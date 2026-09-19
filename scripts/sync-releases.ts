import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline/promises";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import semver from "semver";

import { objectKeyFromArtifactUrl } from "../src/helpers";
import { baseUrl, bucketName, s3Client, s3ObjectExists } from "../src/s3";
import {
  DEFAULT_ROLLOUT_PERCENTAGE,
  createAtDefaultRollout,
  syncReleases,
  type ReleaseArtifactInput,
  type ReleaseDecider,
  type ReleaseType,
  type SyncClients,
  type SyncConfig,
} from "../src/release-sync";

// Operator front end for src/release-sync.ts: signature verification output
// and a confirmation prompt before each production DB write.

const OTA_ROOT_KEY_FPR = "AF5A36A993D828FEFE7C18C2D1B9856C26A79E95";

interface LatestExistingRelease {
  version: string;
  rolloutPercentage: number;
}

type SignatureStatus =
  | { kind: "absent" }
  | { kind: "valid"; signingFpr: string; rootFpr: string }
  | { kind: "wrong-root"; signingFpr: string; rootFpr: string }
  | { kind: "invalid"; reason: string }
  | { kind: "missing-pubkey"; rootFpr?: string }
  | { kind: "gpg-unavailable" };

interface ArtifactDisplayInfo {
  artifact: ReleaseArtifactInput;
  signature: SignatureStatus;
}

function shortFpr(fpr: string): string {
  // Keep the leading 16 hex chars (8 bytes) — enough to be unambiguous in a log
  // line while staying readable. The full fingerprint is what we actually
  // compare against; this is just for display.
  return fpr.slice(0, 16);
}

function describeSignature(status: SignatureStatus): string {
  switch (status.kind) {
    case "absent":
      return "NO  (no .sig file in S3)";
    case "valid":
      return `yes (root ${shortFpr(status.rootFpr)})`;
    case "wrong-root":
      return `WRONG ROOT (got ${shortFpr(status.rootFpr)}, expected ${shortFpr(OTA_ROOT_KEY_FPR)})`;
    case "invalid":
      return `INVALID (${status.reason})`;
    case "missing-pubkey":
      return `cannot verify (OTA root key ${shortFpr(OTA_ROOT_KEY_FPR)} not in local GPG keyring)`;
    case "gpg-unavailable":
      return "cannot verify (gpg not installed)";
  }
}

async function downloadObjectToFile(
  s3Client: S3Client,
  bucketName: string,
  key: string,
  destPath: string,
): Promise<void> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Empty body from S3 for key ${key}`);
  }
  await pipeline(response.Body as Readable, createWriteStream(destPath));
}

function runGpgVerify(
  sigPath: string,
  artifactPath: string,
): Promise<{ exitCode: number; statusOutput: string; stderrOutput: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "gpg",
      ["--batch", "--status-fd=1", "--verify", sigPath, artifactPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let statusOutput = "";
    let stderrOutput = "";
    proc.stdout.on("data", chunk => (statusOutput += chunk.toString()));
    proc.stderr.on("data", chunk => (stderrOutput += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", exitCode => {
      resolve({ exitCode: exitCode ?? -1, statusOutput, stderrOutput });
    });
  });
}

interface GpgStatus {
  validSig?: { signingFpr: string; rootFpr: string };
  noPubkey?: boolean;
  // ERRSIG `rc` field. GnuPG documents rc=4 (unsupported algorithm),
  // rc=9 (missing public key); other codes are possible and we leave
  // them as raw strings for the caller to format.
  errSigRc?: string;
  badSig?: boolean;
}

const ERRSIG_RC_REASONS: Record<string, string> = {
  "4": "unsupported algorithm",
  "9": "missing public key",
};

function describeErrSigRc(rc: string): string {
  return ERRSIG_RC_REASONS[rc] ?? `gpg error code ${rc}`;
}

function parseGpgStatus(statusOutput: string): GpgStatus {
  const result: GpgStatus = {};
  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.replace(/^\[GNUPG:\]\s+/, "").trim();

    if (line.startsWith("VALIDSIG ")) {
      // VALIDSIG <signing-fpr> <date> <ts> <expire> <ver> <pubkey-algo>
      //          <hash-algo> <sig-class> <primary-key-fpr>
      // Fields are space-separated; index 10 is the primary key fingerprint.
      const parts = line.split(/\s+/);
      if (parts.length >= 11) {
        result.validSig = { signingFpr: parts[1], rootFpr: parts[10] };
      }
    } else if (line.startsWith("NO_PUBKEY ")) {
      result.noPubkey = true;
    } else if (line.startsWith("ERRSIG ")) {
      // ERRSIG <keyid> <pkalgo> <hashalgo> <sig_class> <time> <rc> [<fpr>]
      // Index 6 is the rc field. Only rc=9 means "missing public key" —
      // other codes (e.g. 4 = unsupported algorithm) are real verification
      // failures and must not be reported as missing-pubkey.
      const parts = line.split(/\s+/);
      if (parts.length >= 7) {
        result.errSigRc = parts[6];
      }
    } else if (line.startsWith("BADSIG ")) {
      result.badSig = true;
    }
  }
  return result;
}

async function verifySignature(
  s3Client: S3Client,
  bucketName: string,
  artifactKey: string,
): Promise<SignatureStatus> {
  const sigKey = `${artifactKey}.sig`;
  if (!(await s3ObjectExists(s3Client, bucketName, sigKey))) {
    return { kind: "absent" };
  }

  const dir = await mkdtemp(path.join(tmpdir(), "sync-releases-verify-"));
  const sigPath = path.join(dir, "artifact.sig");
  const artifactPath = path.join(dir, "artifact");

  try {
    await Promise.all([
      downloadObjectToFile(s3Client, bucketName, sigKey, sigPath),
      downloadObjectToFile(s3Client, bucketName, artifactKey, artifactPath),
    ]);

    let result: Awaited<ReturnType<typeof runGpgVerify>>;
    try {
      result = await runGpgVerify(sigPath, artifactPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return { kind: "gpg-unavailable" };
      }
      throw err;
    }

    const parsed = parseGpgStatus(result.statusOutput);

    if (parsed.badSig) {
      return { kind: "invalid", reason: "BADSIG (signature does not match)" };
    }
    if (parsed.validSig) {
      const rootFprUpper = parsed.validSig.rootFpr.toUpperCase();
      if (rootFprUpper !== OTA_ROOT_KEY_FPR.toUpperCase()) {
        return { kind: "wrong-root", ...parsed.validSig };
      }
      return { kind: "valid", ...parsed.validSig };
    }
    // NO_PUBKEY and ERRSIG rc=9 both mean "we don't have the signer's key".
    // Any other ERRSIG rc is a real failure (e.g. unsupported algorithm) and
    // must surface as `invalid`, not `missing-pubkey`, otherwise the prompt
    // would falsely tell the operator to import a key they already have.
    if (parsed.noPubkey || parsed.errSigRc === "9") {
      return { kind: "missing-pubkey" };
    }
    if (parsed.errSigRc) {
      return {
        kind: "invalid",
        reason: `ERRSIG ${parsed.errSigRc} (${describeErrSigRc(parsed.errSigRc)})`,
      };
    }
    const stderrFirstLine =
      result.stderrOutput.split("\n").find(l => l.trim().length > 0)?.trim() ??
      `gpg exited ${result.exitCode}`;
    return { kind: "invalid", reason: stderrFirstLine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadArtifactDisplayInfo(
  clients: Pick<SyncClients, "s3Client">,
  config: SyncConfig,
  artifacts: ReleaseArtifactInput[],
): Promise<ArtifactDisplayInfo[]> {
  return Promise.all(
    artifacts.map(async artifact => {
      const signature = await verifySignature(
        clients.s3Client,
        config.bucketName,
        objectKeyFromArtifactUrl(artifact.url),
      );
      return { artifact, signature };
    }),
  );
}

async function findLatestExistingRelease(
  prisma: PrismaClient,
  type: ReleaseType,
): Promise<LatestExistingRelease | null> {
  const releases = await prisma.release.findMany({
    where: { type },
    select: { version: true, rolloutPercentage: true },
  });
  if (releases.length === 0) return null;

  const latestVersion = semver.maxSatisfying(
    releases.map(r => r.version),
    "*",
    { includePrerelease: true },
  );
  if (!latestVersion) return null;

  return releases.find(r => r.version === latestVersion) ?? null;
}

function printArtifactSummary(
  type: ReleaseType,
  version: string,
  artifactInfos: ArtifactDisplayInfo[],
  latestExisting: LatestExistingRelease | null,
): void {
  console.log("");
  console.log(
    `[sync-releases] About to create production ${type} release ${version}:`,
  );

  if (latestExisting) {
    console.log(
      `  latest existing: ${latestExisting.version} at ${latestExisting.rolloutPercentage}% rollout`,
    );
  } else {
    console.log(`  latest existing: (none — this will be the first ${type} release)`);
  }

  console.log(`  artifacts (${artifactInfos.length}):`);
  artifactInfos.forEach(({ artifact, signature }, index) => {
    console.log(`    [${index + 1}] url:    ${artifact.url}`);
    console.log(`        hash:   ${artifact.hash}`);
    console.log(`        skus:   ${artifact.compatibleSkus.join(", ")}`);
    console.log(`        signed: ${describeSignature(signature)}`);
  });

  const warnings = artifactInfos.flatMap(({ signature }, index) => {
    const label = `artifact [${index + 1}]`;
    switch (signature.kind) {
      case "wrong-root":
        return [
          `WARNING: ${label} signed by an UNTRUSTED root (got ${signature.rootFpr}, expected ${OTA_ROOT_KEY_FPR}). Devices that enforce the OTA root will reject this firmware.`,
        ];
      case "invalid":
        return [
          `WARNING: ${label} signature is INVALID: ${signature.reason}. Do not publish unless you have verified this manually.`,
        ];
      default:
        return [];
    }
  });

  if (warnings.length > 0) {
    console.log("");
    for (const warning of warnings) {
      console.log(`  ${warning}`);
    }
  }
  console.log("");
}

async function promptRolloutPercentage(
  readline: ReturnType<typeof createInterface>,
): Promise<number> {
  while (true) {
    const answer = (
      await readline.question(
        `  Rollout percentage [${DEFAULT_ROLLOUT_PERCENTAGE}]: `,
      )
    ).trim();

    if (answer === "") {
      return DEFAULT_ROLLOUT_PERCENTAGE;
    }

    const parsed = Number(answer);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      console.log("    Error: enter an integer between 0 and 100");
      continue;
    }
    return parsed;
  }
}

function confirmProductionCreate(
  clients: SyncClients,
  config: SyncConfig,
): ReleaseDecider {
  return async (type, version, artifacts) => {
    const [artifactInfos, latestExisting] = await Promise.all([
      loadArtifactDisplayInfo(clients, config, artifacts),
      findLatestExistingRelease(clients.prisma, type),
    ]);

    printArtifactSummary(type, version, artifactInfos, latestExisting);

    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const rolloutPercentage = await promptRolloutPercentage(readline);

      const confirmation = (
        await readline.question(
          `  Create production ${type} release ${version} at ${rolloutPercentage}% rollout? [y/N/a (abort run)] `,
        )
      )
        .trim()
        .toLowerCase();

      if (["a", "abort"].includes(confirmation)) {
        return { kind: "abort" };
      }
      if (!["y", "yes"].includes(confirmation)) {
        return { kind: "skip" };
      }
      return { kind: "create", rolloutPercentage };
    } finally {
      readline.close();
    }
  };
}

function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(DATABASE_URL not set)";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname || "?";
    const port = parsed.port ? `:${parsed.port}` : "";
    const dbName = parsed.pathname.replace(/^\/+/, "") || "?";
    return `${host}${port}/${dbName}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  console.log(
    `[sync-releases] env=${process.env.NODE_ENV ?? "(unset)"} db=${describeDbTarget()} bucket=${bucketName ?? "(unset)"}`,
  );

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && (!stdin.isTTY || !stdout.isTTY)) {
    throw new Error(
      "Production release sync requires an interactive terminal for DB write confirmation.",
    );
  }

  const prisma = new PrismaClient();
  const clients: SyncClients = { prisma, s3Client };
  const config: SyncConfig = { bucketName, baseUrl };

  try {
    await syncReleases(
      clients,
      config,
      isProduction ? confirmProductionCreate(clients, config) : createAtDefaultRollout,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error("[sync-releases] failed", error);
  process.exit(1);
});
