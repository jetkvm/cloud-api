import { createHmac } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";
import WebSocket from "ws";
import { CDN_BASE } from "./fixtures";
import { postSync, putArtifact, s3Client, sha256 } from "./support";

export { sha256 };

const apiUrl = inject("apiUrl");
const bucket = inject("bucket");
const s3 = s3Client(inject("s3Endpoint"));

export const db = new PrismaClient({ datasourceUrl: inject("databaseUrl") });

export function api(path: string, init?: RequestInit) {
  return fetch(`${apiUrl}${path}`, { redirect: "manual", ...init });
}

export const cdn = (key: string) => `${CDN_BASE}/${key}`;

export async function objectBytes(key: string): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await response.Body!.transformToByteArray());
}

export const uploadArtifact = (key: string, body: Buffer) =>
  putArtifact(s3, bucket, key, body);

export async function removeArtifact(key: string) {
  await Promise.all(
    [key, `${key}.sha256`].map(Key =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })),
    ),
  );
}

export const syncReleases = (body?: object) =>
  postSync(apiUrl, inject("syncToken"), body);

/** The URL is on the CDN, and the object behind it has exactly this SHA-256. */
export async function expectServable(url: string, hash: string) {
  if (!url.startsWith(`${CDN_BASE}/`)) throw new Error(`${url} is not on ${CDN_BASE}`);
  const actual = sha256(await objectBytes(url.slice(CDN_BASE.length + 1)));
  if (actual !== hash)
    throw new Error(`${url}: hash ${hash} does not match the object (${actual})`);
}

type Rollouts = Record<string, Record<string, number>>;

/** Sets every release to 0% except the ones listed, like an operator editing the table. */
export async function setRollouts(rollouts: Rollouts) {
  await db.release.updateMany({ data: { rolloutPercentage: 0 } });
  for (const [type, versions] of Object.entries(rollouts)) {
    for (const [version, rolloutPercentage] of Object.entries(versions)) {
      const { count } = await db.release.updateMany({
        where: { type, version },
        data: { rolloutPercentage },
      });
      if (count !== 1)
        throw new Error(`No release ${type} ${version} to set to ${rolloutPercentage}%`);
    }
  }
}

export async function getRelease(query: Record<string, string>) {
  const response = await api(`/releases?${new URLSearchParams(query)}`);
  return { status: response.status, body: await response.json() };
}

/**
 * A cookie-session cookie pair, signed like the API signs it. Only the
 * WebSocket client route accepts the id_token without asking Google, so the
 * signaling tests double as the check that this signature is right.
 */
export function sessionCookie(session: object, secret = inject("cookieSecret")) {
  const value = Buffer.from(JSON.stringify(session)).toString("base64");
  const signature = createHmac("sha1", secret)
    .update(`session=${value}`)
    .digest("base64")
    .replace(/\/|\+|=/g, c => ({ "/": "_", "+": "-", "=": "" })[c]!);
  return `session=${value}; session.sig=${signature}`;
}

/** A JWT that decodes but is not signed by Google. */
export function unsignedIdToken(claims: Record<string, unknown>) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${part({ alg: "RS256", kid: "e2e" })}.${part({ iss: "https://accounts.google.com", exp, ...claims })}.c2ln`;
}

export async function createUserWithDevice(
  googleId: string,
  deviceId: string,
  secretToken: string,
) {
  await db.user.create({
    data: { googleId, device: { create: { id: deviceId, secretToken } } },
  });
}

function wsUrl(path: string) {
  return `${apiUrl.replace(/^http/, "ws")}${path}`;
}

/** Resolves with the open socket, or rejects with the HTTP status (or "closed") the server answered with. */
export function openSocket(
  path: string,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path), { headers });
    // Listen before the handshake completes: the server may send right after it
    messages(ws);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`rejected: ${res.statusCode}`)),
    );
    ws.once("error", () => reject(new Error("rejected: closed")));
  });
}

type Inbox = { next(timeoutMs?: number): Promise<any> };
const inboxes = new WeakMap<WebSocket, Inbox>();

/** Collects JSON (or text) messages so tests can await the next one. */
export function messages(ws: WebSocket): Inbox {
  const existing = inboxes.get(ws);
  if (existing) return existing;
  const queue: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  ws.on("message", data => {
    const text = data.toString();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // plain text such as "pong"
    }
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  const inbox: Inbox = {
    next(timeoutMs = 5000): Promise<any> {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const waiter = (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("no message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
  inboxes.set(ws, inbox);
  return inbox;
}

export function closed(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket stayed open")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
