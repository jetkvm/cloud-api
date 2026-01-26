import { Request, Response } from "express";
import { prisma } from "./db";
import { BadRequestError, InternalServerError, NotFoundError } from "./errors";
import { createHash } from "crypto";
import semver from "semver";

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { LRUCache } from 'lru-cache';

import { streamToString, streamToBuffer, toSemverRange, verifyHash } from "./helpers";

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

async function getLatestVersion(
  prefix: "app" | "system",
  includePrerelease: boolean,
  maxSatisfying: string = "*",
): Promise<ReleaseMetadata> {
  const cacheKey = `${prefix}-${includePrerelease}-${maxSatisfying}`;
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
    throw new NotFoundError(`No version found under prefix ${prefix} that satisfies ${maxSatisfying}`);
  }

  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  const url = `${baseUrl}/${prefix}/${latestVersion}/${fileName}`;

  const hashResponse = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `${prefix}/${latestVersion}/${fileName}.sha256`,
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

function toRelease(appRelease?: ReleaseMetadata, systemRelease?: ReleaseMetadata): Release {
  const release: Partial<Release> = {};
  if (appRelease) setAppRelease(release as Release, appRelease);
  if (systemRelease) setSystemRelease(release as Release, systemRelease);
  return release as Release;
}

async function getReleaseFromS3(
  includePrerelease: boolean,
  { appVersion, systemVersion }: { appVersion?: string; systemVersion?: string },
): Promise<Release> {
  const [appRelease, systemRelease] = await Promise.all([
    getLatestVersion("app", includePrerelease, appVersion),
    getLatestVersion("system", includePrerelease, systemVersion),
  ]);

  return toRelease(appRelease, systemRelease);
}

async function isDeviceEligibleForLatestRelease(
  rolloutPercentage: number,
  deviceId: string,
): Promise<boolean> {
  if (rolloutPercentage === 100) return true;

  const hash = createHash("md5").update(deviceId).digest("hex");
  const hashPrefix = hash.substring(0, 8);
  const hashValue = parseInt(hashPrefix, 16) % 100;

  return hashValue < rolloutPercentage;
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

  // Get the latest release from S3
  let remoteRelease: Release;
  try {
    remoteRelease = await getReleaseFromS3(includePrerelease, { appVersion, systemVersion });
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
    return res.json(
      toRelease(latestAppRelease, latestSystemRelease),
    );
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

function cachedRedirect(cachedKey: (req: Request) => string, callback: (req: Request) => Promise<string>) {
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
  (req: Request) => `system-recovery-${req.query.prerelease === "true" ? "pre" : "stable"}`,
  async (req: Request) => {
    const includePrerelease = req.query.prerelease === "true";

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

    const [firmwareFile, hashFile] = await Promise.all([
      // TODO: store file hash using custom header to avoid extra request
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `system/${latestVersion}/update.img`,
        }),
      ),
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `system/${latestVersion}/update.img.sha256`,
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

    return `${baseUrl}/system/${latestVersion}/update.img`;
  },
);

export const RetrieveLatestApp = cachedRedirect(
  (req: Request) => `app-${req.query.prerelease === "true" ? "pre" : "stable"}`,
  async (req: Request) => {
    const includePrerelease = req.query.prerelease === "true";

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

    const versions = response.CommonPrefixes.map(cp => cp.Prefix!.split("/")[1]).filter(v =>
      semver.valid(v),
    );

    const latestVersion = semver.maxSatisfying(versions, "*", {
      includePrerelease,
    }) as string;

    if (!latestVersion) {
      throw new NotFoundError("No valid app versions found");
    }

    // Get the app file and its hash
    const [appFile, hashFile] = await Promise.all([
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `app/${latestVersion}/jetkvm_app`,
        }),
      ),
      s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `app/${latestVersion}/jetkvm_app.sha256`,
        }),
      ),
    ]);

    if (!appFile.Body || !hashFile.Body) {
      throw new NotFoundError(`App or hash file not found for version ${latestVersion}`);
    }

    await verifyHash(appFile, hashFile, "app hash does not match");

    console.log("App hash matches", latestVersion);
    return `${baseUrl}/app/${latestVersion}/jetkvm_app`;
  });
