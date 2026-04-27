import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import semver from "semver";

import { streamToString } from "../src/helpers";

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
  prisma: PrismaClient,
  type: ReleaseType,
  version: string,
  artifacts: ReleaseArtifactInput[],
): Promise<void> {
  if (artifacts.length === 0) {
    console.log(`[sync-releases] ${type} ${version}: skipped, no compatible artifacts`);
    return;
  }

  // Sync only registers brand-new releases. Existing rows (rollout state, URLs,
  // artifact compatibility) are left untouched — backfills/repairs are handled
  // by one-off scripts so a routine sync run can never rewrite production data.
  const existing = await prisma.release.findUnique({
    where: { version_type: { version, type } },
    select: { id: true },
  });

  if (existing) {
    console.log(`[sync-releases] ${type} ${version}: already synced, skipping`);
    return;
  }

  const primaryArtifact = artifacts[0];
  await prisma.release.create({
    data: {
      version,
      type,
      rolloutPercentage: 10,
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
    `[sync-releases] ${type} ${version}: created with ${artifacts.length} artifact(s)`,
  );
}

export async function syncReleases(
  clients: SyncClients,
  config: SyncConfig,
): Promise<void> {
  for (const type of ["app", "system"] as const) {
    const versions = await listStableVersions(clients.s3Client, config.bucketName, type);

    for (const version of versions) {
      const artifacts = await collectReleaseArtifacts(clients, config, type, version);
      await syncRelease(clients.prisma, type, version, artifacts);
    }
  }
}

async function main(): Promise<void> {
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
