import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import type { TestProject } from "vitest/node";
import {
  ARTIFACTS,
  CDN_BASE,
  OTHER_OBJECTS,
  fixtureBody,
  stableVersions,
} from "./fixtures";
import { postSync, putArtifact, s3Client } from "./support";

/**
 * Starts the built API (dist/index.js) the way the container does, against a
 * Postgres database and an S3-compatible bucket that only the e2e run uses.
 *
 *   E2E_DATABASE_URL  default postgresql://jetkvm:jetkvm@localhost:5432/jetkvm_e2e
 *   E2E_S3_ENDPOINT   default http://127.0.0.1:8333 (SeaweedFS from compose.development.yaml)
 */

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://jetkvm:jetkvm@localhost:5432/jetkvm_e2e";
// An IP host makes the AWS SDK use path-style requests, which the local S3 server needs.
const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? "http://127.0.0.1:8333";
const BUCKET = "jetkvm-e2e";
const APP_ORIGIN = "https://app.e2e.test";

declare module "vitest" {
  export interface ProvidedContext {
    apiUrl: string;
    appOrigin: string;
    databaseUrl: string;
    s3Endpoint: string;
    bucket: string;
    cookieSecret: string;
    syncToken: string;
    iceServer: string;
  }
}

function assertLocal(url: string, what: string) {
  const { hostname } = new URL(url);
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(`${what} must point at this machine, got ${hostname}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** A new, empty database with every migration applied. */
async function prepareDatabase() {
  const name = new URL(DATABASE_URL).pathname.slice(1);
  const admin = new URL(DATABASE_URL);
  admin.pathname = "/postgres";

  const prisma = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await prisma.$disconnect();
  }

  await promisify(execFile)("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL },
  });
}

/** The bucket, emptied and filled with the fixture releases. */
async function prepareBucket() {
  const s3 = s3Client(S3_ENDPOINT);
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (error: any) {
    if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.name))
      throw error;
  }

  for (;;) {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    if (Contents.length === 0) break;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: Contents.map(({ Key }) => ({ Key })) },
      }),
    );
  }

  const put = (Key: string, Body: Buffer | string) =>
    s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));
  await Promise.all([
    ...ARTIFACTS.map(({ key, sig }) =>
      Promise.all([
        putArtifact(s3, BUCKET, key, fixtureBody(key)),
        sig ? put(`${key}.sig`, `signature of ${key}`) : undefined,
      ]),
    ),
    ...OTHER_OBJECTS.map(key => put(key, fixtureBody(key))),
  ]);
}

async function waitForHealth(apiUrl: string, server: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("The API exited during startup");
    }
    try {
      if ((await fetch(`${apiUrl}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("The API did not become healthy");
}

/** Registers every stable fixture version through the upload script's endpoint. */
async function registerReleases(apiUrl: string, syncToken: string) {
  for (const settled of stableVersions()) {
    for (;;) {
      const response = await postSync(apiUrl, syncToken, settled);
      // 409 while the startup sync still runs
      if (response.status === 409) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `sync of ${settled.type} ${settled.version} failed: ${response.status}`,
        );
      }
      break;
    }
  }
}

export default async function setup(project: TestProject) {
  assertLocal(DATABASE_URL, "E2E_DATABASE_URL");
  assertLocal(S3_ENDPOINT, "E2E_S3_ENDPOINT");

  const cookieSecret = randomBytes(16).toString("hex");
  const syncToken = randomBytes(16).toString("hex");
  const iceServer = "stun:stun.e2e.test:3478";

  await Promise.all([prepareDatabase(), prepareBucket()]);

  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["dist/index.js"], {
    env: {
      PATH: process.env.PATH,
      // Keep a local .env out of the run
      DOTENV_CONFIG_PATH: "/dev/null",
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_URL,
      API_HOSTNAME: apiUrl,
      APP_HOSTNAME: APP_ORIGIN,
      CORS_ORIGINS: APP_ORIGIN,
      COOKIE_SECRET: cookieSecret,
      GOOGLE_CLIENT_ID: "e2e-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-client-secret",
      CLOUDFLARE_TURN_ID: "e2e",
      CLOUDFLARE_TURN_TOKEN: "e2e",
      R2_ENDPOINT: S3_ENDPOINT,
      R2_ACCESS_KEY_ID: "e2e",
      R2_SECRET_ACCESS_KEY: "e2e",
      R2_BUCKET: BUCKET,
      R2_CDN_URL: CDN_BASE,
      REAL_IP_HEADER: "x-real-ip",
      ICE_SERVERS: iceServer,
      RELEASE_SYNC_TOKEN: syncToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  server.stdout!.on("data", chunk => (output += chunk));
  server.stderr!.on("data", chunk => (output += chunk));
  const log = () => output.split("\n").slice(-40).join("\n");

  let stopping = false;
  let crashed = false;
  server.on("exit", (code, signal) => {
    if (stopping) return;
    crashed = true;
    // Printed now, so the tests that fail next show why
    console.error(`\nThe API exited (code ${code}, signal ${signal}):\n${log()}\n`);
  });

  try {
    await waitForHealth(apiUrl, server);
    await registerReleases(apiUrl, syncToken);
  } catch (error) {
    stopping = true;
    server.kill();
    throw new Error(`${(error as Error).message}:\n${log()}`);
  }

  project.provide("apiUrl", apiUrl);
  project.provide("appOrigin", APP_ORIGIN);
  project.provide("databaseUrl", DATABASE_URL);
  project.provide("s3Endpoint", S3_ENDPOINT);
  project.provide("bucket", BUCKET);
  project.provide("cookieSecret", cookieSecret);
  project.provide("syncToken", syncToken);
  project.provide("iceServer", iceServer);

  return () => {
    stopping = true;
    server.kill("SIGTERM");
    if (crashed) throw new Error("The API exited during the e2e run");
  };
}
