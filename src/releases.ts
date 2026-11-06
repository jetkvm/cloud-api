import { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { BadRequestError, ConflictError, InternalServerError, NotFoundError } from "./errors";
import type { ReleaseSyncRunner } from "./release-sync";
import semver from "semver";

import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { LRUCache } from "lru-cache";
import { baseUrl, bucketName, s3Client, s3ObjectExists, versionHasSkuSupport } from "./s3";

import {
  getDeviceRolloutBucket,
  objectKeyFromArtifactUrl,
  streamToString,
  toSemverRange,
} from "./helpers";
import { z, ZodError } from "zod";
import {
  DEFAULT_SKU,
  artifactFor,
  isKnownSku,
  legacyCompatibleSkus,
  otaArtifacts,
  OTA_PREFIXES,
  type OtaKind,
  type Artifact,
} from "./skus";

/** Query param schema builders for common patterns */
const queryString = () =>
  z
    .string()
    .optional()
    .transform(v => v || undefined);
const queryBoolean = () =>
  z
    .string()
    .optional()
    .transform(v => v === "true");
const querySku = () =>
  z
    .string()
    .optional()
    .transform(v => v || DEFAULT_SKU)
    .refine(isKnownSku, { error: issue => `Unknown SKU "${issue.input}"` });

/**
 * Schema for redirect endpoints (RetrieveLatestApp, RetrieveLatestSystemRecovery).
 * Only needs prerelease flag and SKU (defaults to jetkvm-v2).
 */
const latestQuerySchema = z.object({
  prerelease: queryBoolean(),
  sku: querySku(),
});

type LatestQuery = z.infer<typeof latestQuerySchema>;

/**
 * Schema for the main Retrieve endpoint.
 * Requires deviceId and includes version constraints.
 */
const retrieveQuerySchema = z.object({
  deviceId: z.string({ error: "Device ID is required" }).min(1, "Device ID is required"),
  prerelease: queryBoolean(),
  appVersion: queryString(),
  systemVersion: queryString(),
  sku: querySku(),
});

type RetrieveQuery = z.infer<typeof retrieveQuerySchema>;

/**
 * Parses query parameters and converts ZodError to BadRequestError.
 */
function parseQuery<T>(schema: z.ZodSchema<T>, req: Request): T {
  return parseOrBadRequest(schema, req.query);
}

function parseOrBadRequest<T>(schema: z.ZodSchema<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      throw new BadRequestError(message);
    }
    throw error;
  }
}

export interface ReleaseMetadata {
  version: string;
  url: string;
  hash: string;
}

interface DbRelease {
  version: string;
  rolloutPercentage: number;
  artifacts: {
    url: string;
    hash: string;
  }[];
}

const releaseCache = new LRUCache<string, ReleaseMetadata>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const MISSING_SIG_URL = false;

const sigUrlCache = new LRUCache<string, string | typeof MISSING_SIG_URL>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const redirectCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

/** Clear all caches - useful for testing */
export function clearCaches() {
  releaseCache.clear();
  redirectCache.clear();
  sigUrlCache.clear();
}

/**
 * The one error for "this version ships no artifact for this SKU", whichever
 * path detects it: a skus/ folder without this SKU, a pre-SKU version asked
 * for by non-default hardware, or a DB release with no compatible artifact.
 */
function noArtifactForSku(version: string, sku: string): NotFoundError {
  return new NotFoundError(`Version ${version} has no artifact for SKU "${sku}"`);
}

const objectExists = (key: string) => s3ObjectExists(s3Client, bucketName, key);

/**
 * Resolves the artifact path for a given version and SKU.
 *
 * For versions with SKU support (skus/ folder exists):
 *   - Uses the provided SKU
 *   - Fails if the requested SKU is not available
 *
 * For legacy versions (no skus/ folder):
 *   - Returns legacy path for SKUs that predate the SKU layout, if the file exists
 *   - Fails for every other SKU because legacy firmware predates
 *     that hardware and may not be compatible
 *
 * @param prefix - The R2 folder the artifact lives under
 * @param version - The version string
 * @param sku - SKU identifier (defaults to jetkvm-v2 from schema)
 * @param file - The artifact's file name
 */
async function resolveArtifactPath(
  prefix: string,
  version: string,
  sku: string,
  file: string,
): Promise<string> {
  if (await versionHasSkuSupport(s3Client, bucketName, prefix, version)) {
    const skuPath = `${prefix}/${version}/skus/${sku}/${file}`;

    if (await objectExists(skuPath)) {
      return skuPath;
    }

    throw noArtifactForSku(version, sku);
  }

  // SKU defaults to "jetkvm-v2" via zod schema when not provided.
  //
  // For legacy versions (pre-SKU folder structure), we only serve the SKUs
  // that predate the layout. This prevents newer hardware variants from
  // rolling back to old firmware that may not have compatible binaries.
  const legacyPath = `${prefix}/${version}/${file}`;
  if (legacyCompatibleSkus(prefix).includes(sku) && (await objectExists(legacyPath))) {
    return legacyPath;
  }

  throw noArtifactForSku(version, sku);
}

/**
 * Resolves the signature URL for a given version if a .sig file exists in S3.
 * Results are cached for 5 minutes.
 */
async function resolveSigUrl(
  artifact: Artifact,
  version: string,
  sku: string,
): Promise<string | undefined> {
  const cacheKey = `${artifact.prefix}-${version}-${sku}`;
  const cached = sigUrlCache.get(cacheKey);
  if (cached !== undefined) return cached === MISSING_SIG_URL ? undefined : cached;

  try {
    const path = await resolveArtifactPath(artifact.prefix, version, sku, artifact.file);
    const sigKey = `${path}.sig`;
    if (await objectExists(sigKey)) {
      const url = `${baseUrl}/${sigKey}`;
      sigUrlCache.set(cacheKey, url);
      return url;
    }
  } catch (error) {
    if (error instanceof NotFoundError) {
      // Version doesn't exist for this SKU — cache as absent
      sigUrlCache.set(cacheKey, MISSING_SIG_URL);
      return undefined;
    }
    // Don't cache transient errors (network, permissions, etc.)
    throw error;
  }

  sigUrlCache.set(cacheKey, MISSING_SIG_URL);
  return undefined;
}

/**
 * Enriches a Release response with signature URLs by checking S3 for .sig files.
 * Transient S3 errors are logged but don't block the response — sigUrl is optional.
 */
async function enrichWithSigUrls(release: Release, sku: string): Promise<void> {
  await Promise.all(
    otaArtifacts(sku).map(async ({ kind, prefix, file }) => {
      const version = release[`${kind}Version`];
      if (!version) return;
      try {
        const sigUrl = await resolveSigUrl({ prefix, file }, version, sku);
        if (sigUrl) release[`${kind}SigUrl`] = sigUrl;
      } catch (e) {
        console.error(`Failed to resolve ${kind} sig URL for ${version}:`, e);
      }
    }),
  );
}

/** Versions checked, newest first, before newestVersionWithArtifact gives up. */
const MAX_FALLBACK_VERSIONS = 5;

/**
 * The newest version under the artifact's prefix that satisfies the range and
 * has the artifact for the SKU, and that artifact's path. A version without a
 * build for the SKU is skipped, as the stable path skips releases without a
 * compatible artifact, so a SKU missing from one upload does not hide older ones.
 * Only the newest `maxVersions` matching versions are checked.
 */
async function newestVersionWithArtifact(
  { prefix, file }: Artifact,
  sku: string,
  range: string,
  includePrerelease: boolean,
  maxVersions = MAX_FALLBACK_VERSIONS,
): Promise<{ version: string; path: string }> {
  const response = await s3Client.send(
    new ListObjectsV2Command({ Bucket: bucketName, Prefix: `${prefix}/`, Delimiter: "/" }),
  );

  const versions = (response.CommonPrefixes ?? [])
    .map(cp => cp.Prefix!.split("/")[1])
    .filter(v => v && semver.valid(v));
  if (versions.length === 0) {
    throw new NotFoundError(`No versions found under prefix ${prefix}`);
  }

  const candidates = semver.rsort(
    versions.filter(v => semver.satisfies(v, range, { includePrerelease })),
  );
  if (candidates.length === 0) {
    throw new NotFoundError(`No version found under prefix ${prefix} that satisfies ${range}`);
  }

  // Each version costs one or two S3 calls and a miss is not cached, so the
  // walk is short: a version without the SKU's build is an upload mistake,
  // not something that runs for many versions.
  for (const version of candidates.slice(0, maxVersions)) {
    try {
      return { version, path: await resolveArtifactPath(prefix, version, sku, file) };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  throw noArtifactForSku(candidates[0], sku);
}

async function getLatestVersion(
  artifact: Artifact,
  includePrerelease: boolean,
  maxSatisfying: string = "*",
  sku: string,
): Promise<ReleaseMetadata> {
  const cacheKey = `${artifact.prefix}-${includePrerelease}-${maxSatisfying}-${sku}`;
  const cached = releaseCache.get(cacheKey);
  if (cached) return cached;

  const { version, path } = await newestVersionWithArtifact(
    artifact,
    sku,
    maxSatisfying,
    includePrerelease,
  );

  const hashResponse = await s3Client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: `${path}.sha256` }),
  );
  const hash = await streamToString(hashResponse.Body);

  const release: ReleaseMetadata = { version, url: `${baseUrl}/${path}`, hash };
  releaseCache.set(cacheKey, release);
  return release;
}

/** Wire shape of the /releases response. Only these fields are serialized. */
interface Release {
  appVersion: string;
  appUrl: string;
  appHash: string;
  appSigUrl?: string;

  systemVersion: string;
  systemUrl: string;
  systemHash: string;
  systemSigUrl?: string;
}

type OtaReleases = Partial<Record<OtaKind, ReleaseMetadata>>;

function setOtaRelease(release: Release, kind: OtaKind, metadata: ReleaseMetadata) {
  release[`${kind}Version`] = metadata.version;
  release[`${kind}Url`] = metadata.url;
  release[`${kind}Hash`] = metadata.hash;
}

/**
 * Builds the response object. Artifacts a product does not ship are left out
 * entirely: the device treats an absent one as "not offered".
 */
function toRelease(offers: OtaReleases): Release {
  const release: Partial<Release> = {};
  for (const kind of ["app", "system"] as const) {
    const metadata = offers[kind];
    if (metadata) setOtaRelease(release as Release, kind, metadata);
  }
  return release as Release;
}

async function resolveSigUrlFromArtifactUrl(
  artifactUrl: string,
): Promise<string | undefined> {
  const cacheKey = `artifact-url-${artifactUrl}`;
  const cached = sigUrlCache.get(cacheKey);
  if (cached !== undefined) return cached === MISSING_SIG_URL ? undefined : cached;

  const sigUrl = `${artifactUrl}.sig`;
  try {
    const sigKey = `${objectKeyFromArtifactUrl(artifactUrl)}.sig`;
    if (await objectExists(sigKey)) {
      sigUrlCache.set(cacheKey, sigUrl);
      return sigUrl;
    }
  } catch (error) {
    console.error(`Failed to resolve sig URL for ${artifactUrl}:`, error);
    return undefined;
  }

  sigUrlCache.set(cacheKey, MISSING_SIG_URL);
  return undefined;
}

async function addStableSigUrls(release: Release): Promise<void> {
  const [appSigUrl, systemSigUrl] = await Promise.all([
    release.appUrl ? resolveSigUrlFromArtifactUrl(release.appUrl) : undefined,
    release.systemUrl ? resolveSigUrlFromArtifactUrl(release.systemUrl) : undefined,
  ]);

  if (appSigUrl) release.appSigUrl = appSigUrl;
  if (systemSigUrl) release.systemSigUrl = systemSigUrl;
}

type VersionConstraints = Record<OtaKind, string>;

async function getReleaseFromS3(
  includePrerelease: boolean,
  sku: string,
  constraints: VersionConstraints,
): Promise<Release> {
  const offers: OtaReleases = {};
  await Promise.all(
    otaArtifacts(sku).map(async ({ kind, prefix, file }) => {
      offers[kind] = await getLatestVersion(
        { prefix, file },
        includePrerelease,
        constraints[kind],
        sku,
      );
    }),
  );
  return toRelease(offers);
}

async function isDeviceEligibleForLatestRelease(
  rolloutPercentage: number,
  deviceId: string,
): Promise<boolean> {
  if (rolloutPercentage === 100) return true;
  return getDeviceRolloutBucket(deviceId) < rolloutPercentage;
}

function compatibleArtifactSelect(sku: string) {
  return {
    where: { compatibleSkus: { has: sku } },
    select: { url: true, hash: true },
    orderBy: { id: "asc" as const },
    take: 1,
  };
}

function compatibleReleaseSelect(sku: string) {
  return {
    version: true,
    rolloutPercentage: true,
    artifacts: compatibleArtifactSelect(sku),
  } as const;
}

function dbReleaseToMetadata(release: DbRelease, sku: string): ReleaseMetadata {
  const artifact = release.artifacts[0];
  if (!artifact) {
    throw noArtifactForSku(release.version, sku);
  }

  return {
    version: release.version,
    url: artifact.url,
    hash: artifact.hash,
  };
}

/**
 * Newest fully rolled out release that ships a binary for the SKU, or null
 * when there is none: the prefix's first release is still staged, or the SKU
 * is new and its first build has not reached 100% yet. The caller decides
 * whether the device is in the staged release's bucket before it needs this.
 */
async function getDefaultRelease(prefix: string, sku: string): Promise<DbRelease | null> {
  const rolledOutReleases = await prisma.release.findMany({
    where: { type: prefix, rolloutPercentage: 100 },
    select: compatibleReleaseSelect(sku),
  });

  if (rolledOutReleases.length === 0) {
    return null;
  }

  // Only consider releases that ship a binary for this SKU. Without this,
  // the newest 100%-rolled-out release wins even if it has no compatible
  // artifact, masking older releases that do.
  const compatibleReleases = rolledOutReleases.filter(r => r.artifacts.length > 0);

  if (compatibleReleases.length === 0) {
    return null;
  }

  const latestVersion = semver.maxSatisfying(
    compatibleReleases.map(r => r.version),
    "*",
  ) as string;

  const latestDefaultRelease = compatibleReleases.find(r => r.version === latestVersion);

  if (!latestDefaultRelease) {
    throw new InternalServerError(
      `No default release found for type ${prefix} and SKU "${sku}"`,
    );
  }

  return latestDefaultRelease;
}

/**
 * Newest release that is rolling out at all. A row at 0% is registered but
 * not yet released, so it must not displace an older release mid-rollout.
 */
async function getLatestRelease(prefix: string, sku: string): Promise<DbRelease> {
  return getReleaseByRange(prefix, sku, "*", { rolloutPercentage: { gt: 0 } });
}

async function getReleaseByRange(
  prefix: string,
  sku: string,
  range: string,
  where: Prisma.ReleaseWhereInput = {},
): Promise<DbRelease> {
  const releases = await prisma.release.findMany({
    where: { type: prefix, ...where },
    select: compatibleReleaseSelect(sku),
  });

  if (releases.length === 0) {
    throw new NotFoundError(`No release found for type ${prefix} and SKU "${sku}"`);
  }

  const latestVersion = semver.maxSatisfying(
    releases.map(r => r.version),
    range,
  ) as string;

  if (!latestVersion) {
    throw new NotFoundError(`No ${prefix} release found that satisfies ${range}`);
  }

  const latestRelease = releases.find(r => r.version === latestVersion);
  if (!latestRelease) {
    throw new NotFoundError(`No ${prefix} release found that satisfies ${range}`);
  }

  return latestRelease;
}

/**
 * The release a background update check offers: the newest release that is
 * rolling out, if the device is in its bucket and it has a build for the SKU,
 * else the default (the newest 100% release with a build for the SKU). A
 * staged release without a build for the SKU (e.g. a SKU-specific build has
 * not shipped yet) keeps the default rather than 404 the whole request.
 */
async function rolledOutRelease(
  prefix: string,
  sku: string,
  deviceId: string,
): Promise<ReleaseMetadata> {
  // Sequential on purpose: when the prefix has no releases at all, the 404
  // from the latest lookup must win over the 500 from the default lookup.
  const latest = await getLatestRelease(prefix, sku);
  const fallback = await getDefaultRelease(prefix, sku);

  const useLatest =
    latest.artifacts.length > 0 &&
    (await isDeviceEligibleForLatestRelease(latest.rolloutPercentage, deviceId));

  const chosen = useLatest ? latest : fallback;
  if (!chosen) {
    throw new NotFoundError(`No ${prefix} release is rolled out yet for SKU "${sku}"`);
  }
  return dbReleaseToMetadata(chosen, sku);
}

export async function Retrieve(req: Request, res: Response) {
  const query = parseQuery(retrieveQuerySchema, req);
  const { sku, deviceId } = query;

  const artifacts = otaArtifacts(sku);
  const constraints: VersionConstraints = {
    app: toSemverRange(query.appVersion),
    system: toSemverRange(query.systemVersion),
  };

  // Prereleases are not imported into the DB by the stable sync script.
  if (query.prerelease) {
    let remoteRelease: Release;
    try {
      remoteRelease = await getReleaseFromS3(query.prerelease, sku, constraints);
    } catch (error) {
      console.error(error);
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new InternalServerError(`Failed to get the latest release from S3: ${error}`);
    }

    await enrichWithSigUrls(remoteRelease, sku);
    return res.json(remoteRelease);
  }

  // A pinned part (appVersion, systemVersion) gets the newest release in its
  // range, rolled out or not. Every other part follows the rollout, as a
  // background update check does, so pinning one part never offers an
  // unreleased build of the other.
  const offered: OtaReleases = {};
  await Promise.all(
    artifacts.map(async ({ kind, prefix }) => {
      offered[kind] =
        constraints[kind] === "*"
          ? await rolledOutRelease(prefix, sku, deviceId)
          : dbReleaseToMetadata(await getReleaseByRange(prefix, sku, constraints[kind]), sku);
    }),
  );

  const responseJson = toRelease(offered);
  await addStableSigUrls(responseJson);

  return res.json(responseJson);
}

function cachedRedirect(
  cachedKey: (query: LatestQuery) => string,
  callback: (query: LatestQuery) => Promise<string>,
) {
  return async (req: Request, res: Response) => {
    const query = parseQuery(latestQuerySchema, req);
    const cacheKey = cachedKey(query);
    let result = redirectCache.get(cacheKey);
    if (!result) {
      result = await callback(query);
      redirectCache.set(cacheKey, result);
    }
    return res.redirect(302, result);
  };
}

/**
 * Generates a cache key for release endpoints based on prefix, prerelease flag, and SKU.
 */
function releaseCacheKey(prefix: string, query: LatestQuery): string {
  return `${prefix}-${query.prerelease ? "pre" : "stable"}-${query.sku}`;
}

/**
 * 302 to the newest recovery image for the requested SKU. The product table
 * says which prefix holds it and what it is called. The route keeps its
 * historical name. Only the newest version counts: if it has no image for the
 * SKU, the answer is 404 rather than an older image.
 */
export const RetrieveLatestSystemRecovery = cachedRedirect(
  query => releaseCacheKey("recovery", query),
  async query => {
    const recovery = artifactFor(query.sku, "recovery");
    if (!recovery) {
      throw new BadRequestError(
        `SKU "${query.sku}" has no downloadable recovery image`,
      );
    }

    const { path } = await newestVersionWithArtifact(
      recovery,
      query.sku,
      "*",
      query.prerelease,
      1,
    );
    return `${baseUrl}/${path}`;
  },
);

/**
 * 302 to the newest over-the-air artifact of one kind for the requested SKU.
 * Integrity is checked at publish time (the .sha256 sidecar is written by the
 * release script, the sync script verifies hash and signature); here the
 * object only has to exist. The product table
 * says which prefix holds it, so the same URL serves every product. Used by
 * build tooling (rv1106-system pulls the app binary into the system image)
 * and by flashing scripts. Only the newest version counts: if it has no build
 * for the SKU, the answer is 404, so a build fails instead of silently
 * packaging an older one.
 */
function latestArtifactRedirect(kind: OtaKind) {
  return cachedRedirect(
    query => releaseCacheKey(kind, query),
    async query => {
      const artifact = artifactFor(query.sku, kind);
      if (!artifact) {
        throw new BadRequestError(`SKU "${query.sku}" has no ${kind} artifact`);
      }

      const { path } = await newestVersionWithArtifact(
        artifact,
        query.sku,
        "*",
        query.prerelease,
        1,
      );
      return `${baseUrl}/${path}`;
    },
  );
}

export const RetrieveLatestApp = latestArtifactRedirect("app");

const syncBodySchema = z
  .object({
    type: z.string().refine(type => OTA_PREFIXES.includes(type), "Unknown release type"),
    version: z.string().min(1),
  })
  .partial()
  .refine(
    body => (body.type === undefined) === (body.version === undefined),
    "type and version go together",
  )
  .transform(body =>
    body.type && body.version ? { type: body.type, version: body.version } : undefined,
  );

/**
 * POST /releases/sync: register every stable R2 version missing from the DB
 * and answer with the per-outcome counts. With `{ type, version }` in the
 * body, that one version skips the settle window: the caller vouches its
 * last object is written. Every other version keeps it.
 */
export function Sync(runner: ReleaseSyncRunner) {
  return async (req: Request, res: Response) => {
    const settled = parseOrBadRequest(syncBodySchema, req.body ?? {});
    const stats = await runner({ settled });
    if (stats === "busy") {
      throw new ConflictError("A release sync is already in progress");
    }
    return res.json(stats);
  };
}
