import express from "express";
import { prisma } from "./db";
import { BadRequestError, InternalServerError, NotFoundError } from "./errors";
import { createHash } from "crypto";
import semver from "semver";


import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { LRUCache } from 'lru-cache';

export interface ReleaseMetadata {
  version: string;
  url: string;
  hash: string;
  _cachedAt?: number;
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

const systemRecoveryImageCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const bucketName = process.env.R2_BUCKET;
const baseUrl = process.env.R2_CDN_URL;

async function getLatestVersion(
  prefix: "app" | "system",
  includePrerelease: boolean,
): Promise<ReleaseMetadata> {
  const cacheKey = `${prefix}-${includePrerelease}`;
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
  const latestVersion = semver.maxSatisfying(versions, "*", {
    includePrerelease,
  }) as string;

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
  const release = { version: latestVersion, url, hash, _cachedAt: Date.now() };
  releaseCache.set(cacheKey, release);
  return release;
}

interface Release {
  appVersion: string;
  appUrl: string;
  appHash: string;
  appCachedAt?: number;

  systemVersion: string;
  systemUrl: string;
  systemHash: string;
  systemCachedAt?: number;
}

function setAppRelease(release: Release, appRelease: ReleaseMetadata) {
  release.appVersion = appRelease.version;
  release.appUrl = appRelease.url;
  release.appHash = appRelease.hash;
  release.appCachedAt = appRelease._cachedAt;
}

function setSystemRelease(release: Release, systemRelease: ReleaseMetadata) {
  release.systemVersion = systemRelease.version;
  release.systemUrl = systemRelease.url;
  release.systemHash = systemRelease.hash;
  release.systemCachedAt = systemRelease._cachedAt;
}

function toRelease(appRelease?: ReleaseMetadata, systemRelease?: ReleaseMetadata): Release {
  const release: Partial<Release> = {};
  if (appRelease) setAppRelease(release as Release, appRelease);
  if (systemRelease) setSystemRelease(release as Release, systemRelease);
  return release as Release;
}

async function getReleaseFromS3(includePrerelease: boolean): Promise<Release> {
  const [appRelease, systemRelease] = await Promise.all([
    getLatestVersion("app", includePrerelease),
    getLatestVersion("system", includePrerelease),
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

export async function Retrieve(req: express.Request, res: express.Response) {
  const deviceId = req.query.deviceId as string | undefined;
  if (!deviceId) {
    throw new BadRequestError("Device ID is required");
  }

  const includePrerelease = req.query.prerelease === "true";

  // Get the latest release from S3
  let remoteRelease: Release;
  try {
    remoteRelease = await getReleaseFromS3(includePrerelease);
  } catch (error) {
    console.error(error);
    throw new InternalServerError("Failed to get the latest release from S3");
  }

  // If the request is for prereleases, ignore the rollout percentage and just return the latest release
  // This is useful for the OTA updater to get the latest prerelease version
  // This also prevents us from storing the rollout percentage for prerelease versions
  if (includePrerelease) {
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

export async function RetrieveLatestSystemRecovery(
  req: express.Request,
  res: express.Response,
) {
  const includePrerelease = req.query.prerelease === "true";

  const cacheKey = `system-recovery-${includePrerelease}`;
  const cached = systemRecoveryImageCache.get(cacheKey);
  if (cached) {
    return res.redirect(302, cached);
  }

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

  const firmwareContent = await streamToBuffer(firmwareFile.Body);
  const remoteHash = await streamToString(hashFile.Body);
  const localHash = createHash("sha256").update(firmwareContent).digest("hex");

  if (remoteHash.trim() !== localHash) {
    throw new InternalServerError("system recovery image hash does not match");
  }

  console.log("system recovery image hash matches", latestVersion);

  const url = `${baseUrl}/system/${latestVersion}/update.img`;
  systemRecoveryImageCache.set(cacheKey, url);

  return res.redirect(302, url);
}

export async function RetrieveLatestApp(req: express.Request, res: express.Response) {
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

  const appContent = await streamToBuffer(appFile.Body);
  const remoteHash = await streamToString(hashFile.Body);
  const localHash = createHash("sha256").update(appContent).digest("hex");

  if (remoteHash.trim() !== localHash) {
    throw new InternalServerError("App hash does not match");
  }

  console.log("App hash matches", latestVersion);
  return res.redirect(302, `${baseUrl}/app/${latestVersion}/jetkvm_app`);
}

// Helper function to convert stream to string
async function streamToString(stream: any): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const result = Buffer.concat(chunks).toString("utf-8");
  return result.trimEnd();
}

// Helper function to convert stream to buffer
async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
