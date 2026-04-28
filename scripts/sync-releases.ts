import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline/promises";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import semver from "semver";

import { objectKeyFromArtifactUrl, streamToString } from "../src/helpers";

const OTA_ROOT_KEY_FPR = "AF5A36A993D828FEFE7C18C2D1B9856C26A79E95";

type ReleaseType = "app" | "system";

const DEFAULT_SKU = "jetkvm-v2";
const KNOWN_SKUS = ["jetkvm-v2", "jetkvm-v2-sdmmc"];

interface SyncClients {
  prisma: PrismaClient;
  s3Client: S3Client;
}

interface SyncConfig {
  bucketName: string;
  baseUrl: string;
  skus?: string[];
}

interface ReleaseArtifactInput {
  url: string;
  hash: string;
  compatibleSkus: string[];
}

function artifactName(type: ReleaseType): string {
  return type === "app" ? "jetkvm_app" : "system.tar";
}

// Pre-SKU artifacts (no skus/ folder) are only safe on the original jetkvm-v2.
// Other SKUs require an explicit skus/<sku>/ upload to opt in.
function legacyCompatibleSkus(): string[] {
  return [DEFAULT_SKU];
}

const DEFAULT_ROLLOUT_PERCENTAGE = 10;

type ReleaseOutcome =
  | "created"
  | "already-synced"
  | "no-artifacts"
  | "skipped"
  | "aborted";

type ReleaseDecision =
  | { kind: "create"; rolloutPercentage: number }
  | { kind: "skip" }
  | { kind: "abort" };

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

async function confirmProductionCreate(
  clients: SyncClients,
  config: SyncConfig,
  type: ReleaseType,
  version: string,
  artifacts: ReleaseArtifactInput[],
): Promise<ReleaseDecision> {
  if (process.env.NODE_ENV !== "production") {
    return { kind: "create", rolloutPercentage: DEFAULT_ROLLOUT_PERCENTAGE };
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Production release sync requires an interactive terminal for DB write confirmation.",
    );
  }

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
}

function isS3NotFound(error: any): boolean {
  return (
    error.name === "NotFound" ||
    error.name === "NoSuchKey" ||
    error.$metadata?.httpStatusCode === 404
  );
}

async function s3ObjectExists(
  s3Client: S3Client,
  bucketName: string,
  key: string,
): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (error: any) {
    if (isS3NotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function versionHasSkuSupport(
  s3Client: S3Client,
  bucketName: string,
  type: ReleaseType,
  version: string,
): Promise<boolean> {
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${type}/${version}/skus/`,
      MaxKeys: 1,
    }),
  );
  return (response.Contents?.length ?? 0) > 0;
}

async function readHash(
  s3Client: S3Client,
  bucketName: string,
  artifactPath: string,
): Promise<string | undefined> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `${artifactPath}.sha256`,
      }),
    );
    return streamToString(response.Body);
  } catch (error: any) {
    if (isS3NotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function addArtifact(
  artifactsByUrl: Map<string, ReleaseArtifactInput>,
  url: string,
  hash: string,
  sku: string,
): void {
  const artifact = artifactsByUrl.get(url);
  if (artifact) {
    if (!artifact.compatibleSkus.includes(sku)) {
      artifact.compatibleSkus.push(sku);
    }
    return;
  }

  artifactsByUrl.set(url, { url, hash, compatibleSkus: [sku] });
}

export async function collectReleaseArtifacts(
  clients: Pick<SyncClients, "s3Client">,
  config: SyncConfig,
  type: ReleaseType,
  version: string,
): Promise<ReleaseArtifactInput[]> {
  const skus = config.skus ?? KNOWN_SKUS;
  const artifactFileName = artifactName(type);

  if (!(await versionHasSkuSupport(clients.s3Client, config.bucketName, type, version))) {
    const artifactPath = `${type}/${version}/${artifactFileName}`;
    const hash = await readHash(clients.s3Client, config.bucketName, artifactPath);
    if (!hash) {
      return [];
    }

    return [
      {
        url: `${config.baseUrl}/${artifactPath}`,
        hash,
        compatibleSkus: legacyCompatibleSkus(),
      },
    ];
  }

  const artifactsByUrl = new Map<string, ReleaseArtifactInput>();
  for (const sku of skus) {
    const artifactPath = `${type}/${version}/skus/${sku}/${artifactFileName}`;
    if (!(await s3ObjectExists(clients.s3Client, config.bucketName, artifactPath))) {
      continue;
    }

    const hash = await readHash(clients.s3Client, config.bucketName, artifactPath);
    if (!hash) {
      continue;
    }
    addArtifact(artifactsByUrl, `${config.baseUrl}/${artifactPath}`, hash, sku);
  }

  return Array.from(artifactsByUrl.values());
}

async function listStableVersions(
  s3Client: S3Client,
  bucketName: string,
  type: ReleaseType,
): Promise<string[]> {
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${type}/`,
      Delimiter: "/",
    }),
  );

  return (response.CommonPrefixes ?? [])
    .map(cp => cp.Prefix?.split("/")[1])
    .filter((version): version is string => Boolean(version))
    .filter(
      version => Boolean(semver.valid(version)) && semver.prerelease(version) === null,
    )
    .sort(semver.compare);
}

async function syncRelease(
  clients: SyncClients,
  config: SyncConfig,
  type: ReleaseType,
  version: string,
  artifacts: ReleaseArtifactInput[],
): Promise<ReleaseOutcome> {
  if (artifacts.length === 0) {
    console.log(`[sync-releases] ${type} ${version}: skipped, no compatible artifacts`);
    return "no-artifacts";
  }

  // Sync only registers brand-new releases. Existing rows (rollout state, URLs,
  // artifact compatibility) are left untouched — backfills/repairs are handled
  // by one-off scripts so a routine sync run can never rewrite production data.
  const existing = await clients.prisma.release.findUnique({
    where: { version_type: { version, type } },
    select: { id: true },
  });

  if (existing) {
    console.log(`[sync-releases] ${type} ${version}: already synced, skipping`);
    return "already-synced";
  }

  const decision = await confirmProductionCreate(
    clients,
    config,
    type,
    version,
    artifacts,
  );
  if (decision.kind === "abort") {
    console.log(`[sync-releases] ${type} ${version}: aborted by user`);
    return "aborted";
  }
  if (decision.kind === "skip") {
    console.log(`[sync-releases] ${type} ${version}: skipped by user`);
    return "skipped";
  }

  const primaryArtifact = artifacts[0];
  await clients.prisma.release.create({
    data: {
      version,
      type,
      rolloutPercentage: decision.rolloutPercentage,
      url: primaryArtifact.url,
      hash: primaryArtifact.hash,
      artifacts: {
        create: artifacts.map(artifact => ({
          url: artifact.url,
          hash: artifact.hash,
          compatibleSkus: artifact.compatibleSkus,
        })),
      },
    },
  });

  console.log(
    `[sync-releases] ${type} ${version}: created with ${artifacts.length} artifact(s) at ${decision.rolloutPercentage}% rollout`,
  );
  return "created";
}

export async function syncReleases(
  clients: SyncClients,
  config: SyncConfig,
): Promise<void> {
  const stats: Record<ReleaseOutcome, number> = {
    created: 0,
    "already-synced": 0,
    "no-artifacts": 0,
    skipped: 0,
    aborted: 0,
  };
  let abortedAt: { type: ReleaseType; version: string } | null = null;

  outer: for (const type of ["app", "system"] as const) {
    const versions = await listStableVersions(clients.s3Client, config.bucketName, type);

    for (const version of versions) {
      const artifacts = await collectReleaseArtifacts(clients, config, type, version);
      const outcome = await syncRelease(clients, config, type, version, artifacts);
      stats[outcome]++;

      if (outcome === "aborted") {
        abortedAt = { type, version };
        break outer;
      }
    }
  }

  if (abortedAt) {
    console.log(
      `[sync-releases] aborted at ${abortedAt.type} ${abortedAt.version}; remaining versions in this run were not processed`,
    );
  }
  console.log(
    `[sync-releases] done: created=${stats.created} skipped-by-user=${stats.skipped} already-synced=${stats["already-synced"]} no-artifacts=${stats["no-artifacts"]}`,
  );
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
    `[sync-releases] env=${process.env.NODE_ENV ?? "(unset)"} db=${describeDbTarget()} bucket=${process.env.R2_BUCKET ?? "(unset)"}`,
  );

  const prisma = new PrismaClient();
  const s3Client = new S3Client({
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    region: "auto",
  });

  try {
    await syncReleases(
      { prisma, s3Client },
      {
        bucketName: process.env.R2_BUCKET!,
        baseUrl: process.env.R2_CDN_URL!,
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("[sync-releases] failed", error);
    process.exit(1);
  });
}
