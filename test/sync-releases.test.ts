import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, beforeEach, it, vi } from "vitest";

import {
  collectReleaseArtifacts,
  createAtDefaultRollout,
  scheduleReleaseSync,
  syncReleases,
  UPLOAD_SETTLE_MS,
  type ReleaseDecider,
  type ReleaseType,
} from "../src/release-sync";
import { otaFileForPrefix } from "../src/skus";

import { createAsyncIterable, s3Mock, testPrisma } from "./setup";

const DEFAULT_SKU = "jetkvm-v2";
const SDMMC_SKU = "jetkvm-v2-sdmmc";
const MINI_ETHERNET_SKU = "jetkvm-mini-ethernet";
const MINI_WIRELESS_SKU = "jetkvm-mini-wireless";
const SYNC_BUCKET = "test-bucket";
const SYNC_BASE_URL = "https://cdn.test.com";
const syncS3Client = new S3Client({});

/** Makes the settle check see one object under the version uploaded at `at`. */
function mockS3UploadedAt(prefix: ReleaseType, version: string, at: Date) {
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/` }).resolves({
    Contents: [{ Key: `${prefix}/${version}/${otaFileForPrefix(prefix)}`, LastModified: at }],
  });
}

function mockS3ListVersions(prefix: ReleaseType, versions: string[]) {
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/` }).resolves({
    CommonPrefixes: versions.map(v => ({ Prefix: `${prefix}/${v}/` })),
  });
}

function mockS3HashFile(prefix: ReleaseType, version: string, hash: string) {
  const fileName = otaFileForPrefix(prefix);
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
  prefix: ReleaseType,
  version: string,
  sku: string,
  hash: string,
) {
  const fileName = otaFileForPrefix(prefix);
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;

  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [{ Key: skuPath }],
  });
  s3Mock.on(HeadObjectCommand, { Key: skuPath }).resolves({});
  s3Mock.on(GetObjectCommand, { Key: `${skuPath}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });
}

beforeEach(() => {
  s3Mock.reset();
  s3Mock
    .on(HeadObjectCommand)
    .rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
  // Listings a test does not stub (other prefixes, the upload settle check) see
  // an empty folder. More specific .on(..., { Prefix }) stubs registered later win.
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
});

describe("syncReleases", () => {
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

  it("collects mini artifacts for the mini SKUs only", async () => {
    mockS3SkuVersion("mini", "1.0.0", MINI_ETHERNET_SKU, "mini-ethernet-hash");
    mockS3SkuVersion("mini", "1.0.0", MINI_WIRELESS_SKU, "mini-wireless-hash");
    // A stray JetKVM upload under mini/ must not be picked up.
    mockS3SkuVersion("mini", "1.0.0", DEFAULT_SKU, "stray-hash");

    const artifacts = await collectReleaseArtifacts(
      { s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      "mini",
      "1.0.0",
    );

    expect(artifacts).toEqual([
      {
        url: `https://cdn.test.com/mini/1.0.0/skus/${MINI_ETHERNET_SKU}/jetkvm-mini.bin`,
        hash: "mini-ethernet-hash",
        compatibleSkus: [MINI_ETHERNET_SKU],
      },
      {
        url: `https://cdn.test.com/mini/1.0.0/skus/${MINI_WIRELESS_SKU}/jetkvm-mini.bin`,
        hash: "mini-wireless-hash",
        compatibleSkus: [MINI_WIRELESS_SKU],
      },
    ]);
  });

  it("ignores a mini version uploaded without the skus/ layout", async () => {
    mockS3HashFile("mini", "1.0.1", "legacy-mini-hash");

    const artifacts = await collectReleaseArtifacts(
      { s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      "mini",
      "1.0.1",
    );

    expect(artifacts).toEqual([]);
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

    const stats = await syncReleases(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      createAtDefaultRollout,
    );

    expect(stats).toEqual({
      created: 1,
      "already-synced": 1,
      uploading: 0,
      "no-artifacts": 0,
      skipped: 0,
      aborted: 0,
    });

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

  it("defers a version whose objects changed within the settle window", async () => {
    const fresh = "9.9.10";
    const settled = "9.9.11";
    mockS3ListVersions("app", [fresh, settled]);
    mockS3HashFile("app", fresh, "fresh-hash");
    mockS3HashFile("app", settled, "settled-hash");
    mockS3UploadedAt("app", fresh, new Date(Date.now() - 60 * 1000));
    mockS3UploadedAt("app", settled, new Date(Date.now() - UPLOAD_SETTLE_MS - 60 * 1000));

    const stats = await syncReleases(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL, uploadSettleMs: UPLOAD_SETTLE_MS },
      createAtDefaultRollout,
    );

    expect(stats).toMatchObject({ created: 1, uploading: 1 });
    expect(
      await testPrisma.release.findUnique({
        where: { version_type: { version: fresh, type: "app" } },
      }),
    ).toBeNull();
    // The settle listing must come after the artifact scan, so an upload that
    // overlaps the scan is seen. The deferred version was therefore scanned.
    const calls = s3Mock.calls().map(call => call.args[0].input as { Key?: string; Prefix?: string });
    const scanIndex = calls.findIndex(input => input.Key === `app/${fresh}/jetkvm_app.sha256`);
    const settleIndex = calls.findIndex(input => input.Prefix === `app/${fresh}/`);
    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeGreaterThan(scanIndex);
    expect(
      await testPrisma.release.findUnique({
        where: { version_type: { version: settled, type: "app" } },
      }),
    ).toMatchObject({ hash: "settled-hash" });
  });

  it("honours the decider's rollout, skip and abort answers", async () => {
    mockS3ListVersions("app", ["9.9.5", "9.9.6", "9.9.7"]);
    mockS3ListVersions("system", ["9.9.5"]);
    for (const version of ["9.9.5", "9.9.6", "9.9.7"]) {
      mockS3HashFile("app", version, `app-hash-${version}`);
    }
    mockS3HashFile("system", "9.9.5", "system-hash");

    const answers: Record<string, Awaited<ReturnType<ReleaseDecider>>> = {
      "app 9.9.5": { kind: "create", rolloutPercentage: 42 },
      "app 9.9.6": { kind: "skip" },
      "app 9.9.7": { kind: "abort" },
    };
    const decide: ReleaseDecider = async (type, version) => answers[`${type} ${version}`];

    const stats = await syncReleases(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      decide,
    );

    expect(stats).toMatchObject({ created: 1, skipped: 1, aborted: 1 });

    const created = await testPrisma.release.findUniqueOrThrow({
      where: { version_type: { version: "9.9.5", type: "app" } },
    });
    expect(created.rolloutPercentage).toBe(42);

    const notCreated = await testPrisma.release.findMany({
      where: {
        OR: [
          { version: "9.9.6", type: "app" },
          { version: "9.9.7", type: "app" },
          // Abort stops the whole run, so system is never reached.
          { version: "9.9.5", type: "system" },
        ],
      },
    });
    expect(notCreated).toEqual([]);
  });

  it("treats a release created by another instance mid-run as already synced", async () => {
    const version = "9.9.8";
    mockS3ListVersions("app", [version]);
    mockS3HashFile("app", version, "app-hash");

    // Simulate the race: the known-versions query sees nothing, but by the
    // time this instance inserts, the row is there (written here up front so
    // the real unique constraint fires on create).
    await testPrisma.release.create({
      data: {
        version,
        type: "app",
        rolloutPercentage: 10,
        url: "https://cdn.test.com/other-instance",
        hash: "other-instance-hash",
      },
    });
    const racingPrisma = {
      release: {
        findMany: async () => [],
        create: (args: unknown) => testPrisma.release.create(args as any),
      },
    } as unknown as PrismaClient;

    const stats = await syncReleases(
      { prisma: racingPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      createAtDefaultRollout,
    );

    expect(stats).toMatchObject({ created: 0, "already-synced": 1 });
    const release = await testPrisma.release.findUniqueOrThrow({
      where: { version_type: { version, type: "app" } },
    });
    expect(release.url).toBe("https://cdn.test.com/other-instance");
  });
});

describe("scheduleReleaseSync", () => {
  const INTERVAL_MS = 1000;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    // Only the scheduler's own timer is faked; DB and S3 mock I/O stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs at start, keeps the schedule after a failed run and creates on the next tick", async () => {
    const version = "9.9.9";
    s3Mock
      .on(ListObjectsV2Command, { Prefix: "app/" })
      .rejectsOnce(new Error("R2 unavailable"))
      .resolves({ CommonPrefixes: [{ Prefix: `app/${version}/` }] });
    mockS3HashFile("app", version, "app-hash");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    stop = scheduleReleaseSync(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      INTERVAL_MS,
    );

    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledOnce());
    expect(
      await testPrisma.release.findUnique({
        where: { version_type: { version, type: "app" } },
      }),
    ).toBeNull();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    await vi.waitFor(async () => {
      const release = await testPrisma.release.findUnique({
        where: { version_type: { version, type: "app" } },
      });
      expect(release?.rolloutPercentage).toBe(10);
    });
  });

  it("skips a tick while the previous run is still in progress", async () => {
    let finishFirstRun!: () => void;
    const firstListing = new Promise<{ CommonPrefixes: never[] }>(resolve => {
      finishFirstRun = () => resolve({ CommonPrefixes: [] });
    });
    s3Mock
      .on(ListObjectsV2Command, { Prefix: "app/" })
      .callsFakeOnce(() => firstListing)
      .resolves({ CommonPrefixes: [] });
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    stop = scheduleReleaseSync(
      { prisma: testPrisma, s3Client: syncS3Client },
      { bucketName: SYNC_BUCKET, baseUrl: SYNC_BASE_URL },
      INTERVAL_MS,
    );

    // Two ticks fire while the first run is still waiting on R2.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(warnLog).toHaveBeenCalledTimes(2);
    // The stalled run's list call is the only R2 traffic so far: the skipped
    // ticks did not start a second walk of the bucket.
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1);

    finishFirstRun();
    await vi.waitFor(() =>
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(3),
    );

    // The next tick after the run completed starts a fresh run.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.waitFor(() =>
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(6),
    );
    expect(warnLog).toHaveBeenCalledTimes(2);
  });
});
