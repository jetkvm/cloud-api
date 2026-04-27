import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, beforeEach, it } from "vitest";

import { collectReleaseArtifacts, syncReleases } from "../scripts/sync-releases";
import { createAsyncIterable, s3Mock, testPrisma } from "./setup";

const DEFAULT_SKU = "jetkvm-v2";
const SDMMC_SKU = "jetkvm-v2-sdmmc";
const SYNC_BUCKET = "test-bucket";
const SYNC_BASE_URL = "https://cdn.test.com";
const syncS3Client = new S3Client({});

function mockS3ListVersions(prefix: "app" | "system", versions: string[]) {
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/` }).resolves({
    CommonPrefixes: versions.map(v => ({ Prefix: `${prefix}/${v}/` })),
  });
}

function mockS3HashFile(prefix: "app" | "system", version: string, hash: string) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [],
  });
  s3Mock
    .on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}.sha256` })
    .resolves({
      Body: createAsyncIterable(hash) as any,
    });
}

function mockS3SkuVersion(
  prefix: "app" | "system",
  version: string,
  sku: string,
  hash: string,
) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;

  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [{ Key: skuPath }],
  });
  s3Mock.on(HeadObjectCommand, { Key: skuPath }).resolves({});
  s3Mock.on(GetObjectCommand, { Key: `${skuPath}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });
}

describe("sync-releases script", () => {
  beforeEach(() => {
    s3Mock.reset();
    s3Mock
      .on(HeadObjectCommand)
      .rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
  });

  it("marks legacy app artifacts compatible with the default SKU only", async () => {
    mockS3HashFile("app", "9.9.1", "legacy-app-hash");

    const artifacts = await collectReleaseArtifacts(
      { s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      "app",
      "9.9.1",
    );

    expect(artifacts).toEqual([
      {
        url: "https://cdn.test.com/app/9.9.1/jetkvm_app",
        hash: "legacy-app-hash",
        compatibleSkus: [DEFAULT_SKU],
      },
    ]);
  });

  it("marks legacy system artifacts compatible with only the default SKU", async () => {
    mockS3HashFile("system", "9.9.2", "legacy-system-hash");

    const artifacts = await collectReleaseArtifacts(
      { s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      "system",
      "9.9.2",
    );

    expect(artifacts).toEqual([
      {
        url: "https://cdn.test.com/system/9.9.2/system.tar",
        hash: "legacy-system-hash",
        compatibleSkus: [DEFAULT_SKU],
      },
    ]);
  });

  it("collects only SKU artifacts that exist and have a hash", async () => {
    mockS3SkuVersion("system", "9.9.3", DEFAULT_SKU, "system-default-hash");

    const artifacts = await collectReleaseArtifacts(
      { s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      "system",
      "9.9.3",
    );

    expect(artifacts).toEqual([
      {
        url: `https://cdn.test.com/system/9.9.3/skus/${DEFAULT_SKU}/system.tar`,
        hash: "system-default-hash",
        compatibleSkus: [DEFAULT_SKU],
      },
    ]);
  });

  it("creates new releases at 10% with their S3 artifacts and skips already-synced versions", async () => {
    const version = "9.9.4";

    // Pre-existing system row simulates a release the migration (or a prior
    // sync) already wrote. Sync must leave it completely untouched.
    await testPrisma.release.create({
      data: {
        version,
        type: "system",
        rolloutPercentage: 77,
        url: "https://cdn.test.com/old-system.tar",
        hash: "old-system-hash",
      },
    });

    mockS3ListVersions("app", [version, "10.0.0-beta.1"]);
    mockS3ListVersions("system", [version]);
    mockS3HashFile("app", version, "app-hash");
    mockS3SkuVersion("system", version, DEFAULT_SKU, "system-hash-v2");
    mockS3SkuVersion("system", version, SDMMC_SKU, "system-hash-sdmmc");

    await syncReleases(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
    );

    const appRelease = await testPrisma.release.findUniqueOrThrow({
      where: { version_type: { version, type: "app" } },
      include: { artifacts: true },
    });
    const systemRelease = await testPrisma.release.findUniqueOrThrow({
      where: { version_type: { version, type: "system" } },
      include: { artifacts: true },
    });
    const prerelease = await testPrisma.release.findUnique({
      where: { version_type: { version: "10.0.0-beta.1", type: "app" } },
    });

    // App release is new — created at 10% rollout with a single legacy-compatible artifact.
    expect(appRelease.rolloutPercentage).toBe(10);
    expect(appRelease.artifacts).toEqual([
      expect.objectContaining({
        url: `https://cdn.test.com/app/${version}/jetkvm_app`,
        hash: "app-hash",
        compatibleSkus: [DEFAULT_SKU],
      }),
    ]);

    // System release already existed — sync must not touch rollout, URL, hash,
    // or attach any new artifacts (those are handled by one-off scripts).
    expect(systemRelease.rolloutPercentage).toBe(77);
    expect(systemRelease.url).toBe("https://cdn.test.com/old-system.tar");
    expect(systemRelease.hash).toBe("old-system-hash");
    expect(systemRelease.artifacts).toEqual([]);

    // Prereleases are filtered out by listStableVersions.
    expect(prerelease).toBeNull();
  });
});
