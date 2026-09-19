import { GetObjectCommand, S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import { Prisma, PrismaClient } from "@prisma/client";
import semver from "semver";

import { streamToString } from "./helpers";
import { isS3NotFound, s3ObjectExists, versionHasSkuSupport } from "./s3";
import { OTA_PREFIXES, legacyCompatibleSkus, otaFileForPrefix, skusForPrefix } from "./skus";

/** An R2 prefix, which is also the Release.type column value. */
export type ReleaseType = string;

export interface SyncClients {
  prisma: PrismaClient;
  s3Client: S3Client;
}

export interface SyncConfig {
  bucketName: string;
  baseUrl: string;
  skus?: string[];
  /**
   * Defer a version whose newest object changed within this many ms, checked
   * after the artifact scan: the upload script writes several files per SKU,
   * and sync never rewrites a row, so a scan that overlapped an upload would
   * freeze a partial SKU set or a stale hash. Unset or 0 disables the check
   * (an operator at a terminal can judge the artifact list for themselves).
   */
  uploadSettleMs?: number;
  /** One version whose upload the caller vouches is complete: it skips the settle check. */
  settled?: { type: ReleaseType; version: string };
}

export interface ReleaseArtifactInput {
  url: string;
  hash: string;
  compatibleSkus: string[];
}

export const DEFAULT_ROLLOUT_PERCENTAGE = 10;

export type ReleaseOutcome =
  | "created"
  | "already-synced"
  | "uploading"
  | "no-artifacts"
  | "skipped"
  | "aborted";

export type SyncStats = Record<ReleaseOutcome, number>;

/** Settle window for unattended runs; shorter than the interval, so it costs at most one tick. */
export const UPLOAD_SETTLE_MS = 10 * 60 * 1000;

export type ReleaseDecision =
  | { kind: "create"; rolloutPercentage: number }
  | { kind: "skip" }
  | { kind: "abort" };

/**
 * Decides whether a release that exists in R2 but not in the DB gets created.
 * The interactive script asks the operator; the in-process scheduler always
 * creates at the default rollout.
 */
export type ReleaseDecider = (
  type: ReleaseType,
  version: string,
  artifacts: ReleaseArtifactInput[],
) => Promise<ReleaseDecision>;

export const createAtDefaultRollout: ReleaseDecider = async () => ({
  kind: "create",
  rolloutPercentage: DEFAULT_ROLLOUT_PERCENTAGE,
});

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
  const skus = config.skus ?? skusForPrefix(type);
  const artifactFileName = otaFileForPrefix(type);

  if (!(await versionHasSkuSupport(clients.s3Client, config.bucketName, type, version))) {
    // Pre-SKU artifacts (no skus/ folder) are only safe on the SKUs that
    // predate the layout. A type with no legacy form treats a version
    // without skus/ as an upload mistake, not a release.
    const compatibleSkus = legacyCompatibleSkus(type);
    if (compatibleSkus.length === 0) {
      return [];
    }

    const artifactPath = `${type}/${version}/${artifactFileName}`;
    const hash = await readHash(clients.s3Client, config.bucketName, artifactPath);
    if (!hash) {
      return [];
    }

    return [
      {
        url: `${config.baseUrl}/${artifactPath}`,
        hash,
        compatibleSkus,
      },
    ];
  }

  // SKUs are probed concurrently; folding afterwards in `skus` order keeps
  // the primary artifact (artifacts[0]) and compatibleSkus order stable.
  const found = await Promise.all(
    skus.map(async sku => {
      const artifactPath = `${type}/${version}/skus/${sku}/${artifactFileName}`;
      if (!(await s3ObjectExists(clients.s3Client, config.bucketName, artifactPath))) {
        return undefined;
      }
      const hash = await readHash(clients.s3Client, config.bucketName, artifactPath);
      return hash ? { sku, url: `${config.baseUrl}/${artifactPath}`, hash } : undefined;
    }),
  );

  const artifactsByUrl = new Map<string, ReleaseArtifactInput>();
  for (const artifact of found) {
    if (artifact) {
      addArtifact(artifactsByUrl, artifact.url, artifact.hash, artifact.sku);
    }
  }
  return Array.from(artifactsByUrl.values());
}

async function listStableVersions(
  s3Client: S3Client,
  bucketName: string,
  type: ReleaseType,
): Promise<string[]> {
  const prefixes: string[] = [];
  for await (const page of paginateListObjectsV2(
    { client: s3Client },
    { Bucket: bucketName, Prefix: `${type}/`, Delimiter: "/" },
  )) {
    for (const cp of page.CommonPrefixes ?? []) {
      if (cp.Prefix) {
        prefixes.push(cp.Prefix);
      }
    }
  }

  return prefixes
    .map(prefix => prefix.split("/")[1])
    .filter((version): version is string => Boolean(version))
    .filter(
      version => Boolean(semver.valid(version)) && semver.prerelease(version) === null,
    )
    .sort(semver.compare);
}

/** Newest LastModified among every object under `${type}/${version}/`, or undefined when empty. */
async function newestUploadTime(
  s3Client: S3Client,
  bucketName: string,
  type: ReleaseType,
  version: string,
): Promise<Date | undefined> {
  let newest: Date | undefined;
  for await (const page of paginateListObjectsV2(
    { client: s3Client },
    { Bucket: bucketName, Prefix: `${type}/${version}/` },
  )) {
    for (const object of page.Contents ?? []) {
      if (object.LastModified && (!newest || object.LastModified > newest)) {
        newest = object.LastModified;
      }
    }
  }
  return newest;
}

async function listSyncedVersions(prisma: PrismaClient, type: ReleaseType): Promise<Set<string>> {
  const releases = await prisma.release.findMany({
    where: { type },
    select: { version: true },
  });
  return new Set(releases.map(release => release.version));
}

async function releaseExists(
  prisma: PrismaClient,
  type: ReleaseType,
  version: string,
): Promise<boolean> {
  const release = await prisma.release.findUnique({
    where: { version_type: { version, type } },
    select: { id: true },
  });
  return release !== null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

async function createRelease(
  clients: SyncClients,
  config: SyncConfig,
  decide: ReleaseDecider,
  type: ReleaseType,
  version: string,
): Promise<ReleaseOutcome> {
  const artifacts = await collectReleaseArtifacts(clients, config, type, version);

  // Listed after the artifact scan on purpose: an upload that was active at
  // any point during the scan leaves an object newer than the window, so the
  // snapshot above is discarded rather than registered.
  const vouched = config.settled?.type === type && config.settled.version === version;
  if (config.uploadSettleMs && !vouched) {
    const newest = await newestUploadTime(clients.s3Client, config.bucketName, type, version);
    if (newest && Date.now() - newest.getTime() < config.uploadSettleMs) {
      console.log(
        `[sync-releases] ${type} ${version}: upload still settling (last object ${newest.toISOString()}), retrying next run`,
      );
      return "uploading";
    }
  }

  if (artifacts.length === 0) {
    console.log(`[sync-releases] ${type} ${version}: skipped, no compatible artifacts`);
    return "no-artifacts";
  }

  const decision = await decide(type, version, artifacts);
  if (decision.kind === "abort") {
    console.log(`[sync-releases] ${type} ${version}: aborted by user`);
    return "aborted";
  }
  if (decision.kind === "skip") {
    console.log(`[sync-releases] ${type} ${version}: skipped by user`);
    return "skipped";
  }

  const primaryArtifact = artifacts[0];
  try {
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
  } catch (error) {
    // Another API instance can win the race between the version listing and
    // this insert, in which case the row it wrote is the one we wanted. Any
    // other unique violation (a stale id sequence after a data import, say)
    // leaves no row and is a real failure.
    if (isUniqueViolation(error) && (await releaseExists(clients.prisma, type, version))) {
      console.log(`[sync-releases] ${type} ${version}: created concurrently elsewhere, skipping`);
      return "already-synced";
    }
    throw error;
  }

  console.log(
    `[sync-releases] ${type} ${version}: created with ${artifacts.length} artifact(s) at ${decision.rolloutPercentage}% rollout`,
  );
  return "created";
}

/**
 * Registers every stable version in R2 that has no Release row yet.
 *
 * Sync only registers brand-new releases. Existing rows (rollout state, URLs,
 * artifact compatibility) are left untouched — backfills/repairs are handled
 * by one-off scripts so a routine sync run can never rewrite production data.
 * Known versions are loaded once per prefix, so a run over an already-synced
 * bucket costs one R2 list and one DB query per prefix.
 *
 * Returns the per-outcome counts so callers can log or assert on them.
 */
export async function syncReleases(
  clients: SyncClients,
  config: SyncConfig,
  decide: ReleaseDecider,
): Promise<SyncStats> {
  const stats: SyncStats = {
    created: 0,
    "already-synced": 0,
    uploading: 0,
    "no-artifacts": 0,
    skipped: 0,
    aborted: 0,
  };
  let abortedAt: { type: ReleaseType; version: string } | null = null;

  outer: for (const type of OTA_PREFIXES) {
    const [versions, synced] = await Promise.all([
      listStableVersions(clients.s3Client, config.bucketName, type),
      listSyncedVersions(clients.prisma, type),
    ]);

    for (const version of versions) {
      // Name the release in any failure, whichever step raised it, so the
      // scheduled run log does not need to be traced back to a version.
      const outcome = synced.has(version)
        ? "already-synced"
        : await createRelease(clients, config, decide, type, version).catch((error: unknown) => {
            throw new Error(`[sync-releases] ${type} ${version}: sync failed`, { cause: error });
          });
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
    `[sync-releases] done: created=${stats.created} skipped-by-user=${stats.skipped} already-synced=${stats["already-synced"]} uploading=${stats.uploading} no-artifacts=${stats["no-artifacts"]}`,
  );
  return stats;
}

const RELEASE_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** Runs one unattended sync, or resolves to "busy" while another run is in progress. */
export type ReleaseSyncRunner = (
  options?: Pick<SyncConfig, "settled">,
) => Promise<SyncStats | "busy">;

/**
 * One in-process sync at a time, shared by every trigger (the timer and the
 * HTTP endpoint): a second run would only walk the bucket again and lose the
 * (version, type) race to the first.
 */
export function createReleaseSyncRunner(
  clients: SyncClients,
  config: SyncConfig,
): ReleaseSyncRunner {
  let running = false;

  return async (options = {}) => {
    if (running) {
      return "busy";
    }
    running = true;
    try {
      return await syncReleases(
        clients,
        { uploadSettleMs: UPLOAD_SETTLE_MS, ...config, ...options },
        createAtDefaultRollout,
      );
    } finally {
      running = false;
    }
  };
}

/**
 * Runs the sync now and then every `intervalMs`. A failed run is logged and
 * the schedule continues. Returns a function that stops the schedule.
 */
export function scheduleReleaseSync(
  runner: ReleaseSyncRunner,
  intervalMs: number = RELEASE_SYNC_INTERVAL_MS,
): () => void {
  const run = async () => {
    try {
      if ((await runner()) === "busy") {
        console.warn("[sync-releases] previous run still in progress, skipping this tick");
      }
    } catch (error) {
      console.error("[sync-releases] scheduled run failed", error);
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
