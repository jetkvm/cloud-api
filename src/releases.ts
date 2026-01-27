import { Request, Response } from "express";
import { prisma } from "./db";
import { BadRequestError, InternalServerError, NotFoundError } from "./errors";
import semver from "semver";

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { LRUCache } from "lru-cache";

import {
  getDeviceRolloutBucket,
  streamToString,
  toSemverRange,
  verifyHash,
} from "./helpers";

export interface ReleaseMetadata {
  version: string;
  url: string;
  hash: string;
  _cachedAt?: number;
  _maxSatisfying?: string;
}

const s3Client = new S3Client({
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  region: "auto",
});

const releaseCache = new LRUCache<string, ReleaseMetadata>({
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
}

const bucketName = process.env.R2_BUCKET;
const baseUrl = process.env.R2_CDN_URL;

const DEFAULT_SKU = "jetkvm-1";

/**
 * Checks if an object exists in S3/R2 by attempting a GetObjectCommand.
 * Returns true if the object exists, false otherwise.
 */
async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
    return true;
  } catch (error: any) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Checks if a version was uploaded with SKU folder structure.
 * Returns true if any skus/ subfolder exists for this version.
 */
async function versionHasSkuSupport(
  prefix: "app" | "system",
  version: string,
): Promise<boolean> {
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${prefix}/${version}/skus/`,
      MaxKeys: 1,
    }),
  );
  return (response.Contents?.length ?? 0) > 0;
}

/**
 * Resolves the artifact path for a given version and optional SKU.
 *
 * For versions with SKU support (skus/ folder exists):
 *   - Uses the provided SKU, or defaults to DEFAULT_SKU
 *   - Fails if the requested SKU is not available
 *
 * For legacy versions (no skus/ folder):
 *   - Returns legacy path for default SKU or when no SKU specified
 *   - Fails for non-default SKUs because legacy firmware predates
 *     that hardware and may not be compatible
 *
 * @param prefix - The prefix folder ("app" or "system")
 * @param version - The version string
 * @param sku - Optional SKU identifier
 * @param artifactOverride - Optional artifact name override (defaults based on prefix)
 */
async function resolveArtifactPath(
  prefix: "app" | "system",
  version: string,
  sku: string | undefined,
  artifactOverride?: string,
): Promise<string> {
  const artifact = artifactOverride ?? (prefix === "app" ? "jetkvm_app" : "system.tar");

  if (await versionHasSkuSupport(prefix, version)) {
    const targetSku = sku ?? DEFAULT_SKU;
    const skuPath = `${prefix}/${version}/skus/${targetSku}/${artifact}`;

    if (await s3ObjectExists(skuPath)) {
      return skuPath;
    }

    throw new NotFoundError(
      `SKU "${targetSku}" is not available for version ${version}`,
    );
  }

  // Legacy version - only default SKU (or unspecified) is allowed
  if (sku === undefined || sku === DEFAULT_SKU) {
    return `${prefix}/${version}/${artifact}`;
  }

  throw new NotFoundError(
    `Version ${version} predates SKU support and cannot serve SKU "${sku}"`,
  );
}

async function getLatestVersion(
  prefix: "app" | "system",
  includePrerelease: boolean,
  maxSatisfying: string = "*",
  sku?: string,
): Promise<ReleaseMetadata> {
  const cacheKey = `${prefix}-${includePrerelease}-${maxSatisfying}-${sku ?? "default"}`;
  const cached = releaseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const listCommand = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix + "/",
    Delimiter: "/",
  });

  const response = await s3Client.send(listCommand);

  if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
    throw new NotFoundError(`No versions found under prefix ${prefix}`);
  }

  // Extract version folder names
  let versions = response.CommonPrefixes.map(cp => cp.Prefix!.split("/")[1])
    .filter(Boolean)
    .filter(v => semver.valid(v));

  if (versions.length === 0) {
    throw new NotFoundError(`No valid versions found under prefix ${prefix}`);
  }

  // Get the latest version, optionally including prerelease versions
  const latestVersion = semver.maxSatisfying(versions, maxSatisfying, {
    includePrerelease,
  }) as string;
  if (!latestVersion) {
    throw new NotFoundError(
      `No version found under prefix ${prefix} that satisfies ${maxSatisfying}`,
    );
  }

  const selectedPath = await resolveArtifactPath(prefix, latestVersion, sku);
  const url = `${baseUrl}/${selectedPath}`;

  const hashResponse = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `${selectedPath}.sha256`,
    }),
  );

  const hash = await streamToString(hashResponse.Body);

  // Cache the release metadata
  const release = {
    version: latestVersion,
    url,
    hash,
    _cachedAt: Date.now(),
    _maxSatisfying: maxSatisfying,
  };
  releaseCache.set(cacheKey, release);
  return release;
}

interface Release {
  appVersion: string;
  appUrl: string;
  appHash: string;
  appCachedAt?: number;
  appMaxSatisfying?: string;

  systemVersion: string;
  systemUrl: string;
  systemHash: string;
  systemCachedAt?: number;
  systemMaxSatisfying?: string;
}

function setAppRelease(release: Release, appRelease: ReleaseMetadata) {
  release.appVersion = appRelease.version;
  release.appUrl = appRelease.url;
  release.appHash = appRelease.hash;
  release.appCachedAt = appRelease._cachedAt;
  release.appMaxSatisfying = appRelease._maxSatisfying;
}

function setSystemRelease(release: Release, systemRelease: ReleaseMetadata) {
  release.systemVersion = systemRelease.version;
  release.systemUrl = systemRelease.url;
  release.systemHash = systemRelease.hash;
  release.systemCachedAt = systemRelease._cachedAt;
  release.systemMaxSatisfying = systemRelease._maxSatisfying;
}

function toRelease(
  appRelease?: ReleaseMetadata,
  systemRelease?: ReleaseMetadata,
): Release {
  const release: Partial<Release> = {};
  if (appRelease) setAppRelease(release as Release, appRelease);
  if (systemRelease) setSystemRelease(release as Release, systemRelease);
  return release as Release;
}

async function getReleaseFromS3(
  includePrerelease: boolean,
  {
    appVersion,
    systemVersion,
    sku,
  }: { appVersion?: string; systemVersion?: string; sku?: string },
): Promise<Release> {
  const [appRelease, systemRelease] = await Promise.all([
    getLatestVersion("app", includePrerelease, appVersion, sku),
    getLatestVersion("system", includePrerelease, systemVersion, sku),
  ]);

  return toRelease(appRelease, systemRelease);
}

async function isDeviceEligibleForLatestRelease(
  rolloutPercentage: number,
  deviceId: string,
): Promise<boolean> {
  if (rolloutPercentage === 100) return true;
  return getDeviceRolloutBucket(deviceId) < rolloutPercentage;
}

async function getDefaultRelease(type: "app" | "system") {
  const rolledOutReleases = await prisma.release.findMany({
    where: { rolloutPercentage: 100, type },
    select: { version: true, url: true, hash: true },
  });

  if (rolledOutReleases.length === 0) {
    throw new InternalServerError(`No default release found for type ${type}`);
  }

  // Get the latest default version from the rolled out releases
  const latestVersion = semver.maxSatisfying(
    rolledOutReleases.map(r => r.version),
    "*",
  ) as string;

  // Get the release with the latest default version
  const latestDefaultRelease = rolledOutReleases.find(r => r.version === latestVersion);

  if (!latestDefaultRelease) {
    throw new InternalServerError(`No default release found for type ${type}`);
  }

  return latestDefaultRelease;
}

export async function Retrieve(req: Request, res: Response) {
  // verify params
  const deviceId = req.query.deviceId as string | undefined;
  if (!deviceId) {
    throw new BadRequestError("Device ID is required");
  }

  const includePrerelease = req.query.prerelease === "true";

  const appVersion = toSemverRange(req.query.appVersion as string | undefined);
  const systemVersion = toSemverRange(req.query.systemVersion as string | undefined);
  const skipRollout = appVersion !== "*" || systemVersion !== "*";

  // Get SKU from query - undefined means use default with legacy fallback
  const skuParam = req.query.sku as string | undefined;
  const sku = skuParam === "" ? undefined : skuParam;

  // Get the latest release from S3
  let remoteRelease: Release;
  try {
    remoteRelease = await getReleaseFromS3(includePrerelease, {
      appVersion,
      systemVersion,
      sku,
    });
  } catch (error) {
    console.error(error);
    if (error instanceof NotFoundError) {
      throw error;
    }
    throw new InternalServerError(`Failed to get the latest release from S3: ${error}`);
  }

  // If the request is for prereleases, ignore the rollout percentage and just return the latest release
  // This is useful for the OTA updater to get the latest prerelease version
  // This also prevents us from storing the rollout percentage for prerelease versions

  // If the version isn't a wildcard, we skip the rollout percentage check
  if (includePrerelease || skipRollout) {
    return res.json(remoteRelease);
  }

  // Fetch or create the latest app release
  const latestAppRelease = await prisma.release.upsert({
    where: { version_type: { version: remoteRelease.appVersion, type: "app" } },
    update: {},
    create: {
      version: remoteRelease.appVersion,
      rolloutPercentage: 10,
      url: remoteRelease.appUrl,
      type: "app",
      hash: remoteRelease.appHash,
    },
    select: { version: true, url: true, rolloutPercentage: true, hash: true },
  });

  // Fetch or create the latest system release
  const latestSystemRelease = await prisma.release.upsert({
    where: { version_type: { version: remoteRelease.systemVersion, type: "system" } },
    update: {},
    create: {
      version: remoteRelease.systemVersion,
      rolloutPercentage: 10,
      url: remoteRelease.systemUrl,
      type: "system",
      hash: remoteRelease.systemHash,
    },
    select: { version: true, url: true, rolloutPercentage: true, hash: true },
  });

  /*
    Return the latest release if forceUpdate is true, bypassing rollout rules.
    This occurs when a user manually checks for updates in the app UI.
    Background update checks follow the normal rollout percentage rules, to ensure controlled, gradual deployment of updates.
  */
  const forceUpdate = req.query.forceUpdate === "true";
  if (forceUpdate) {
    return res.json(toRelease(latestAppRelease, latestSystemRelease));
  }

  const defaultAppRelease = await getDefaultRelease("app");
  const defaultSystemRelease = await getDefaultRelease("system");

  const responseJson = toRelease(defaultAppRelease, defaultSystemRelease);

  if (
    await isDeviceEligibleForLatestRelease(latestAppRelease.rolloutPercentage, deviceId)
  ) {
    setAppRelease(responseJson, latestAppRelease);
  }

  if (
    await isDeviceEligibleForLatestRelease(
      latestSystemRelease.rolloutPercentage,
      deviceId,
    )
  ) {
    setSystemRelease(responseJson, latestSystemRelease);
  }

  return res.json(responseJson);
}

function cachedRedirect(
  cachedKey: (req: Request) => string,
  callback: (req: Request) => Promise<string>,
) {
  return async (req: Request, res: Response) => {
    const cacheKey = cachedKey(req);
    let result = redirectCache.get(cacheKey);
    if (!result) {
      result = await callback(req);
      redirectCache.set(cacheKey, result);
    }
    return res.redirect(302, result);
  };
}

export const RetrieveLatestSystemRecovery = cachedRedirect(
  (req: Request) => {
    const skuParam = req.query.sku as string | undefined;
    const sku = skuParam === "" ? undefined : skuParam;
    return `system-recovery-${req.query.prerelease === "true" ? "pre" : "stable"}-${sku ?? "default"}`;
  },
  async (req: Request) => {
    const includePrerelease = req.query.prerelease === "true";

    // Get SKU from query - undefined means use default with legacy fallback
    const skuParam = req.query.sku as string | undefined;
    const sku = skuParam === "" ? undefined : skuParam;

    // Get the latest system recovery image from S3. It's stored in the system/ folder.
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "system/",
      Delimiter: "/",
    });
    const response = await s3Client.send(listCommand);

    // Extract version folder names
    if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
      throw new NotFoundError(`No versions found under prefix system recovery image`);
    }

    // Get the latest version
    const versions = response.CommonPrefixes.map(cp => cp.Prefix!.split("/")[1])
      .filter(Boolean)
      .filter(v => semver.valid(v));

    const latestVersion = semver.maxSatisfying(versions, "*", {
      includePrerelease,
    }) as string;

    if (!latestVersion) {
      throw new NotFoundError("No valid system recovery versions found");
    }

    // Resolve the artifact path with SKU support (using update.img for recovery)
    const artifactPath = await resolveArtifactPath("system", latestVersion, sku, "update.img");

    const [firmwareFile, hashFile] = await Promise.all([
      // TODO: store file hash using custom header to avoid extra request
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: artifactPath,
        }),
      ),
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `${artifactPath}.sha256`,
        }),
      ),
    ]);

    if (!firmwareFile.Body || !hashFile.Body) {
      throw new NotFoundError(
        `No system recovery image or hash file not found for version ${latestVersion}`,
      );
    }

    await verifyHash(firmwareFile, hashFile, "system recovery image hash does not match");

    console.log("system recovery image hash matches", latestVersion);

    return `${baseUrl}/${artifactPath}`;
  },
);

export const RetrieveLatestApp = cachedRedirect(
  (req: Request) => {
    const skuParam = req.query.sku as string | undefined;
    const sku = skuParam === "" ? undefined : skuParam;
    return `app-${req.query.prerelease === "true" ? "pre" : "stable"}-${sku ?? "default"}`;
  },
  async (req: Request) => {
    const includePrerelease = req.query.prerelease === "true";

    // Get SKU from query - undefined means use default with legacy fallback
    const skuParam = req.query.sku as string | undefined;
    const sku = skuParam === "" ? undefined : skuParam;

    // Get the latest version
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "app/",
      Delimiter: "/",
    });
    const response = await s3Client.send(listCommand);

    if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
      throw new NotFoundError("No app versions found");
    }

    const versions = response.CommonPrefixes.map(cp => cp.Prefix!.split("/")[1]).filter(
      v => semver.valid(v),
    );

    const latestVersion = semver.maxSatisfying(versions, "*", {
      includePrerelease,
    }) as string;

    if (!latestVersion) {
      throw new NotFoundError("No valid app versions found");
    }

    // Resolve the artifact path with SKU support
    const artifactPath = await resolveArtifactPath("app", latestVersion, sku);

    // Get the app file and its hash
    const [appFile, hashFile] = await Promise.all([
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: artifactPath,
        }),
      ),
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `${artifactPath}.sha256`,
        }),
      ),
    ]);

    if (!appFile.Body || !hashFile.Body) {
      throw new NotFoundError(`App or hash file not found for version ${latestVersion}`);
    }

    await verifyHash(appFile, hashFile, "app hash does not match");

    console.log("App hash matches", latestVersion);
    return `${baseUrl}/${artifactPath}`;
  },
);
