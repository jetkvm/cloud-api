import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
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

/**
 * A version whose newest object changed more recently than this is still being
 * uploaded (the upload script writes several files per SKU). Registering it
 * now would freeze a partial SKU set or a stale hash, since sync never rewrites
 * a row. Shorter than the schedule interval, so it costs at most one tick.
 */
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

/** Newest LastModified among every object under `${type}/${version}/`, or undefined when empty. */
async function newestUploadTime(
  s3Client: S3Client,
  bucketName: string,
  type: ReleaseType,
  version: string,
): Promise<Date | undefined> {
  let newest: Date | undefined;
  let continuationToken: string | undefined;
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${type}/${version}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.LastModified && (!newest || object.LastModified > newest)) {
        newest = object.LastModified;
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return newest;
}

async function listSyncedVersions(prisma: PrismaClient, type: ReleaseType): Promise<Set<string>> {
  const releases = await prisma.release.findMany({
    where: { type },
    select: { version: true },
  });
  return new Set(releases.map(release => release.version));
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
  const newest = await newestUploadTime(clients.s3Client, config.bucketName, type, version);
  if (newest && Date.now() - newest.getTime() < UPLOAD_SETTLE_MS) {
    console.log(
      `[sync-releases] ${type} ${version}: upload still settling (last object ${newest.toISOString()}), retrying next run`,
    );
    return "uploading";
  }

  const artifacts = await collectReleaseArtifacts(clients, config, type, version);
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
    // this insert. The row it wrote is the one we wanted, so treat it as synced.
    if (isUniqueViolation(error)) {
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
): Promise<Record<ReleaseOutcome, number>> {
  const stats: Record<ReleaseOutcome, number> = {
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
      const outcome = synced.has(version)
        ? "already-synced"
        : await createRelease(clients, config, decide, type, version);
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

/**
 * Runs the sync now and then every `intervalMs`, inside the API process.
 * A tick that fires while the previous run is still going is skipped, not
 * queued. A failed run is logged and the schedule continues, so one bad R2
 * or DB response never stops future syncs.
 * Returns a function that stops the schedule.
 */
export function scheduleReleaseSync(
  clients: SyncClients,
  config: SyncConfig,
  intervalMs: number = RELEASE_SYNC_INTERVAL_MS,
): () => void {
  let running = false;

  const run = async () => {
    if (running) {
      console.warn("[sync-releases] previous run still in progress, skipping this tick");
      return;
    }
    running = true;
    try {
      await syncReleases(clients, config, createAtDefaultRollout);
    } catch (error) {
      console.error("[sync-releases] scheduled run failed", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
