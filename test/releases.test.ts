import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { s3Mock, createAsyncIterable, testPrisma, resetToSeedData } from "./setup";
import { BadRequestError, NotFoundError, InternalServerError } from "../src/errors";

// Import the module under test after setup
import {
  Retrieve,
  RetrieveLatestApp,
  RetrieveLatestSystemRecovery,
  clearCaches,
} from "../src/releases";

const DEFAULT_SKU = "jetkvm-v2";
const SDMMC_SKU = "jetkvm-v2-sdmmc";
type ReleaseType = "app" | "system";

// Helper to create mock Request
function createMockRequest(query: Record<string, string | undefined> = {}): Request {
  return {
    query,
  } as unknown as Request;
}

// Helper to create mock Response
function createMockResponse(): Response & {
  _json: any;
  _redirectUrl: string;
  _redirectStatus: number;
} {
  const res = {
    _json: null,
    _redirectUrl: "",
    _redirectStatus: 0,
    json: vi.fn(function (this: any, data: any) {
      this._json = data;
      return this;
    }),
    redirect: vi.fn(function (this: any, status: number, url: string) {
      this._redirectStatus = status;
      this._redirectUrl = url;
      return this;
    }),
  } as unknown as Response & {
    _json: any;
    _redirectUrl: string;
    _redirectStatus: number;
  };
  return res;
}

// Mock S3 responses for listing versions
function mockS3ListVersions(prefix: "app" | "system", versions: string[]) {
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/` }).resolves({
    CommonPrefixes: versions.map(v => ({ Prefix: `${prefix}/${v}/` })),
  });
}

// Mock S3 hash file response for legacy versions (no SKU support)
function mockS3HashFile(
  prefix: "app" | "system",
  version: string,
  hash: string,
  opts?: { hasSig?: boolean },
) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  const artifactPath = `${prefix}/${version}/${fileName}`;

  // Mock versionHasSkuSupport to return false (no SKU folders)
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [],
  });

  // Mock legacy hash path
  s3Mock.on(GetObjectCommand, { Key: `${artifactPath}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });

  // Mock .sig existence check (absence handled by default HeadObject reject in beforeEach)
  if (opts?.hasSig) {
    s3Mock.on(HeadObjectCommand, { Key: `${artifactPath}.sig` }).resolves({});
  }
}

// Mock S3 for versions with SKU support
function mockS3SkuVersion(
  prefix: "app" | "system",
  version: string,
  sku: string,
  hash: string,
  opts?: { hasSig?: boolean },
) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;

  // Mock versionHasSkuSupport to return true (has SKU folders)
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [{ Key: skuPath }],
  });

  // Mock SKU artifact exists (HeadObjectCommand for existence check)
  s3Mock.on(HeadObjectCommand, { Key: skuPath }).resolves({});

  // Mock SKU hash path
  s3Mock.on(GetObjectCommand, { Key: `${skuPath}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });

  // Mock .sig existence check (absence handled by default HeadObject reject in beforeEach)
  if (opts?.hasSig) {
    s3Mock.on(HeadObjectCommand, { Key: `${skuPath}.sig` }).resolves({});
  }
}

// Mock S3 for legacy version with file content (for redirect endpoints with hash verification)
function mockS3LegacyVersionWithContent(
  prefix: "app" | "system",
  version: string,
  fileName: string,
  content: string,
  hash: string,
) {
  // Mock versionHasSkuSupport to return false (no SKU folders)
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [],
  });

  // Mock legacy file path with content
  s3Mock.on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}` }).resolves({
    Body: createAsyncIterable(content) as any,
  });
  s3Mock
    .on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}.sha256` })
    .resolves({
      Body: createAsyncIterable(hash) as any,
    });
}

// Mock S3 for SKU version with file content (for redirect endpoints with hash verification)
function mockS3SkuVersionWithContent(
  prefix: "app" | "system",
  version: string,
  sku: string,
  fileName: string,
  content: string,
  hash: string,
) {
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;

  // Mock versionHasSkuSupport to return true (has SKU folders)
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/${version}/skus/` }).resolves({
    Contents: [{ Key: skuPath }],
  });

  // Mock SKU artifact exists (HeadObjectCommand for existence check)
  s3Mock.on(HeadObjectCommand, { Key: skuPath }).resolves({});

  // Mock SKU artifact with content (GetObjectCommand for actual fetch)
  s3Mock.on(GetObjectCommand, { Key: skuPath }).resolves({
    Body: createAsyncIterable(content) as any,
  });

  // Mock SKU hash path
  s3Mock.on(GetObjectCommand, { Key: `${skuPath}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });
}

function artifactFileName(type: ReleaseType) {
  return type === "app" ? "jetkvm_app" : "system.tar";
}

function artifactUrl(type: ReleaseType, version: string, sku = DEFAULT_SKU) {
  const fileName = artifactFileName(type);
  const path =
    sku === DEFAULT_SKU
      ? `${type}/${version}/${fileName}`
      : `${type}/${version}/skus/${sku}/${fileName}`;
  return `https://cdn.test.com/${path}`;
}

function releaseArtifact(
  type: ReleaseType,
  version: string,
  sku = DEFAULT_SKU,
  hash = `${type}-${version}-${sku}-hash`,
) {
  return {
    url: artifactUrl(type, version, sku),
    hash,
    compatibleSkus: [sku],
  };
}

async function createDbRelease(
  type: ReleaseType,
  version: string,
  rolloutPercentage: number,
  artifacts = [releaseArtifact(type, version)],
) {
  const primaryArtifact = artifacts[0];
  await testPrisma.release.create({
    data: {
      version,
      type,
      rolloutPercentage,
      url: primaryArtifact.url,
      hash: primaryArtifact.hash,
      artifacts: { create: artifacts },
    },
  });
}

async function createDbReleasePair(version: string, rolloutPercentage: number) {
  await createDbRelease("app", version, rolloutPercentage);
  await createDbRelease("system", version, rolloutPercentage);
}

function jsonBody(res: { _json: unknown }) {
  return JSON.parse(JSON.stringify(res._json));
}

describe("Retrieve handler", () => {
  beforeEach(() => {
    s3Mock.reset();
    // Default: .sig files don't exist unless explicitly mocked per-key.
    // More specific .on(HeadObjectCommand, { Key }) mocks take precedence.
    s3Mock
      .on(HeadObjectCommand)
      .rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    clearCaches();
  });

  describe("input validation", () => {
    it("should throw BadRequestError when deviceId is missing", async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      await expect(Retrieve(req, res)).rejects.toThrow(BadRequestError);
      await expect(Retrieve(req, res)).rejects.toThrow("Device ID is required");
    });

    it("should throw BadRequestError when deviceId is empty string", async () => {
      const req = createMockRequest({ deviceId: "" });
      const res = createMockResponse();

      // Empty string is falsy, so it should throw
      await expect(Retrieve(req, res)).rejects.toThrow(BadRequestError);
    });
  });

  describe("S3 error handling", () => {
    it("should throw NotFoundError when no versions exist in S3", async () => {
      const req = createMockRequest({ deviceId: "device-123", prerelease: "true" });
      const res = createMockResponse();

      // Mock empty S3 response for both app and system
      s3Mock.on(ListObjectsV2Command).resolves({ CommonPrefixes: [] });

      await expect(Retrieve(req, res)).rejects.toThrow(NotFoundError);
    });

    it("should throw NotFoundError when no valid semver versions exist", async () => {
      const req = createMockRequest({ deviceId: "device-123", prerelease: "true" });
      const res = createMockResponse();

      // Mock S3 with invalid version names
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [
          { Prefix: "app/invalid-version/" },
          { Prefix: "app/not-semver/" },
        ],
      });
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [
          { Prefix: "system/invalid-version/" },
          { Prefix: "system/not-semver/" },
        ],
      });

      await expect(Retrieve(req, res)).rejects.toThrow(NotFoundError);
    });
  });

  describe("prerelease mode", () => {
    it("should return latest prerelease version when prerelease=true", async () => {
      const req = createMockRequest({ deviceId: "device-123", prerelease: "true" });
      const res = createMockResponse();

      // Mock S3 with stable and prerelease versions
      mockS3ListVersions("app", ["1.0.0", "1.1.0", "2.0.0-beta.1"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "2.0.0-alpha.1"]);
      mockS3HashFile("app", "2.0.0-beta.1", "prerelease-app-hash");
      mockS3HashFile("system", "2.0.0-alpha.1", "prerelease-system-hash");

      await Retrieve(req, res);

      expect(res.json).toHaveBeenCalled();
      expect(res._json.appVersion).toBe("2.0.0-beta.1");
      expect(res._json.systemVersion).toBe("2.0.0-alpha.1");
    });

    it("should skip rollout logic for prereleases", async () => {
      // Use version constraints to get unique cache keys
      // Note: 3.1.0-rc.1 satisfies ^3.0.0 (3.0.0-rc.1 would NOT satisfy it since prereleases < release)
      const req = createMockRequest({
        deviceId: "device-456",
        prerelease: "true",
        appVersion: "^3.0.0",
        systemVersion: "^3.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["3.0.0", "3.1.0-rc.1"]);
      mockS3ListVersions("system", ["3.0.0", "3.1.0-rc.1"]);
      mockS3HashFile("app", "3.1.0-rc.1", "rc-app-hash");
      mockS3HashFile("system", "3.1.0-rc.1", "rc-system-hash");

      await Retrieve(req, res);

      // Should return prerelease directly without checking DB rollout
      expect(res._json.appVersion).toBe("3.1.0-rc.1");
      expect(res._json.systemVersion).toBe("3.1.0-rc.1");
    });
  });

  describe("stable DB-backed contract", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("serves the latest fully rolled out release on background checks", async () => {
      await createDbReleasePair("2.0.0", 100);
      await createDbReleasePair("2.1.0", 0);

      const res = createMockResponse();

      await Retrieve(createMockRequest({ deviceId: "stable-background-device" }), res);

      expect(jsonBody(res)).toMatchObject({
        appVersion: "2.0.0",
        appUrl: artifactUrl("app", "2.0.0"),
        appHash: "app-2.0.0-jetkvm-v2-hash",
        appSigUrl: `${artifactUrl("app", "2.0.0")}.sig`,
        systemVersion: "2.0.0",
        systemUrl: artifactUrl("system", "2.0.0"),
        systemHash: "system-2.0.0-jetkvm-v2-hash",
        systemSigUrl: `${artifactUrl("system", "2.0.0")}.sig`,
      });
    });

    it("serves the latest DB release when forceUpdate bypasses rollout", async () => {
      await createDbReleasePair("2.2.0", 100);
      await createDbReleasePair("2.3.0", 0);

      const res = createMockResponse();

      await Retrieve(
        createMockRequest({ deviceId: "manual-update-device", forceUpdate: "true" }),
        res,
      );

      expect(jsonBody(res)).toMatchObject({
        appVersion: "2.3.0",
        appUrl: artifactUrl("app", "2.3.0"),
        appSigUrl: `${artifactUrl("app", "2.3.0")}.sig`,
        systemVersion: "2.3.0",
        systemUrl: artifactUrl("system", "2.3.0"),
        systemSigUrl: `${artifactUrl("system", "2.3.0")}.sig`,
      });
    });

    it("applies app and system rollout independently", async () => {
      await createDbReleasePair("2.4.0", 100);
      await createDbRelease("app", "2.5.0", 100);
      await createDbRelease("system", "2.5.0", 0);

      const res = createMockResponse();

      await Retrieve(createMockRequest({ deviceId: "split-rollout-device" }), res);

      expect(jsonBody(res)).toMatchObject({
        appVersion: "2.5.0",
        appUrl: artifactUrl("app", "2.5.0"),
        systemVersion: "2.4.0",
        systemUrl: artifactUrl("system", "2.4.0"),
      });
    });

    it("uses DB version ranges and bypasses rollout for constrained requests", async () => {
      await createDbReleasePair("3.0.0", 100);
      await createDbReleasePair("3.1.0", 0);

      const res = createMockResponse();

      await Retrieve(
        createMockRequest({
          deviceId: "pinned-device",
          appVersion: "^3.0.0",
          systemVersion: "3.0.0",
        }),
        res,
      );

      expect(jsonBody(res)).toMatchObject({
        appVersion: "3.1.0",
        appSigUrl: `${artifactUrl("app", "3.1.0")}.sig`,
        systemVersion: "3.0.0",
        systemSigUrl: `${artifactUrl("system", "3.0.0")}.sig`,
      });
    });

    it("selects the artifact compatible with the requested SKU", async () => {
      await createDbRelease("app", "3.2.0", 100, [
        {
          ...releaseArtifact("app", "3.2.0", DEFAULT_SKU),
          compatibleSkus: [DEFAULT_SKU, SDMMC_SKU],
        },
      ]);
      await createDbRelease("system", "3.2.0", 100, [
        releaseArtifact("system", "3.2.0", DEFAULT_SKU, "system-default-hash"),
        releaseArtifact("system", "3.2.0", SDMMC_SKU, "system-sdmmc-hash"),
      ]);

      const res = createMockResponse();

      await Retrieve(
        createMockRequest({
          deviceId: "sdmmc-device",
          sku: SDMMC_SKU,
          forceUpdate: "true",
        }),
        res,
      );

      expect(jsonBody(res)).toMatchObject({
        appVersion: "3.2.0",
        appUrl: artifactUrl("app", "3.2.0"),
        systemVersion: "3.2.0",
        systemUrl: artifactUrl("system", "3.2.0", SDMMC_SKU),
        systemHash: "system-sdmmc-hash",
      });
    });

    it("falls back to the latest release with a compatible artifact", async () => {
      await createDbRelease("app", "3.3.0", 100, [
        {
          ...releaseArtifact("app", "3.3.0", DEFAULT_SKU),
          compatibleSkus: [DEFAULT_SKU, SDMMC_SKU],
        },
      ]);
      await createDbRelease("app", "3.3.1", 100, [
        {
          ...releaseArtifact("app", "3.3.1", DEFAULT_SKU),
          compatibleSkus: [DEFAULT_SKU, SDMMC_SKU],
        },
      ]);
      await createDbRelease("system", "3.3.0", 100, [
        releaseArtifact("system", "3.3.0", DEFAULT_SKU, "system-default-hash"),
        releaseArtifact("system", "3.3.0", SDMMC_SKU, "system-sdmmc-hash"),
      ]);
      await createDbRelease("system", "3.3.1", 100);

      const res = createMockResponse();

      await Retrieve(
        createMockRequest({
          deviceId: "sdmmc-compatible-fallback-device",
          sku: SDMMC_SKU,
          forceUpdate: "true",
        }),
        res,
      );

      expect(jsonBody(res)).toMatchObject({
        appVersion: "3.3.1",
        systemVersion: "3.3.0",
        systemUrl: artifactUrl("system", "3.3.0", SDMMC_SKU),
        systemHash: "system-sdmmc-hash",
      });
    });

    it("does not discover or create stable releases from S3", async () => {
      await createDbReleasePair("3.4.0", 100);
      s3Mock
        .on(ListObjectsV2Command)
        .rejects(new Error("stable requests should not list S3"));
      s3Mock
        .on(GetObjectCommand)
        .rejects(new Error("stable requests should not read S3"));

      const res = createMockResponse();

      await Retrieve(
        createMockRequest({ deviceId: "db-only-device", forceUpdate: "true" }),
        res,
      );

      expect(jsonBody(res)).toMatchObject({
        appVersion: "3.4.0",
        systemVersion: "3.4.0",
      });
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    });

    it("fails when no fully rolled out default exists for background checks", async () => {
      await testPrisma.release.updateMany({ data: { rolloutPercentage: 50 } });

      await expect(
        Retrieve(
          createMockRequest({ deviceId: "no-default-device" }),
          createMockResponse(),
        ),
      ).rejects.toThrow(InternalServerError);
    });
  });

  describe("signature URL handling", () => {
    it("should include sigUrl when .sig file exists", async () => {
      const req = createMockRequest({
        deviceId: "device-sig",
        prerelease: "true",
        appVersion: "^6.0.0",
        systemVersion: "^6.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["6.0.0"]);
      mockS3ListVersions("system", ["6.0.0"]);
      mockS3HashFile("app", "6.0.0", "sig-app-hash", { hasSig: true });
      mockS3HashFile("system", "6.0.0", "sig-system-hash", { hasSig: true });

      await Retrieve(req, res);

      expect(res._json.appSigUrl).toBe("https://cdn.test.com/app/6.0.0/jetkvm_app.sig");
      expect(res._json.systemSigUrl).toBe(
        "https://cdn.test.com/system/6.0.0/system.tar.sig",
      );
    });

    it("should omit sigUrl when .sig file does not exist", async () => {
      const req = createMockRequest({
        deviceId: "device-nosig",
        prerelease: "true",
        appVersion: "^7.0.0",
        systemVersion: "^7.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["7.0.0"]);
      mockS3ListVersions("system", ["7.0.0"]);
      mockS3HashFile("app", "7.0.0", "nosig-app-hash");
      mockS3HashFile("system", "7.0.0", "nosig-system-hash");

      await Retrieve(req, res);

      expect(res._json.appSigUrl).toBeUndefined();
      expect(res._json.systemSigUrl).toBeUndefined();
    });

    it("should include sigUrl with SKU path when .sig file exists", async () => {
      const req = createMockRequest({
        deviceId: "device-sku-sig",
        prerelease: "true",
        sku: "jetkvm-2",
        appVersion: "^8.0.0",
        systemVersion: "^8.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["8.0.0"]);
      mockS3ListVersions("system", ["8.0.0"]);
      mockS3SkuVersion("app", "8.0.0", "jetkvm-2", "sku-sig-app-hash", { hasSig: true });
      mockS3SkuVersion("system", "8.0.0", "jetkvm-2", "sku-sig-system-hash", {
        hasSig: true,
      });

      await Retrieve(req, res);

      expect(res._json.appSigUrl).toBe(
        "https://cdn.test.com/app/8.0.0/skus/jetkvm-2/jetkvm_app.sig",
      );
      expect(res._json.systemSigUrl).toBe(
        "https://cdn.test.com/system/8.0.0/skus/jetkvm-2/system.tar.sig",
      );
    });
  });

  describe("S3 non-NotFoundError handling", () => {
    it("should wrap non-NotFoundError in InternalServerError", async () => {
      const req = createMockRequest({ deviceId: "device-123", prerelease: "true" });
      const res = createMockResponse();

      // Mock S3 to throw a generic error (e.g., network error)
      s3Mock.on(ListObjectsV2Command).rejects(new Error("Network timeout"));

      await expect(Retrieve(req, res)).rejects.toThrow(InternalServerError);
      await expect(Retrieve(req, res)).rejects.toThrow(
        "Failed to get the latest release from S3",
      );
    });
  });

  describe("cache behavior", () => {
    it("should return cached release on second call with same parameters", async () => {
      const req1 = createMockRequest({
        deviceId: "cache-test-device",
        prerelease: "true",
        appVersion: "^5.0.0",
        systemVersion: "^5.0.0",
      });
      const res1 = createMockResponse();

      mockS3ListVersions("app", ["5.0.0", "5.1.0"]);
      mockS3ListVersions("system", ["5.0.0", "5.1.0"]);
      mockS3HashFile("app", "5.1.0", "cache-app-hash");
      mockS3HashFile("system", "5.1.0", "cache-system-hash");

      await Retrieve(req1, res1);
      expect(res1._json.appVersion).toBe("5.1.0");

      // Reset S3 mock to return different data
      s3Mock.reset();
      mockS3ListVersions("app", ["5.0.0", "5.2.0"]); // Different version
      mockS3ListVersions("system", ["5.0.0", "5.2.0"]);
      mockS3HashFile("app", "5.2.0", "new-app-hash");
      mockS3HashFile("system", "5.2.0", "new-system-hash");

      // Second call should return cached result (5.1.0), not new S3 data (5.2.0)
      const req2 = createMockRequest({
        deviceId: "cache-test-device-2",
        prerelease: "true",
        appVersion: "^5.0.0",
        systemVersion: "^5.0.0",
      });
      const res2 = createMockResponse();

      await Retrieve(req2, res2);
      expect(res2._json.appVersion).toBe("5.1.0"); // Still cached
    });
  });
});

describe("RetrieveLatestApp S3 redirect handler", () => {
  beforeEach(() => {
    s3Mock.reset();
    clearCaches();
  });

  it("should handle all invalid semver versions gracefully", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    // All versions are invalid semver
    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [{ Prefix: "app/not-valid/" }, { Prefix: "app/bad-version/" }],
    });

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
  });

  it("should throw NotFoundError when no app versions exist", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({ CommonPrefixes: [] });

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
  });

  it("should redirect to latest stable app version", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [
        { Prefix: "app/1.0.0/" },
        { Prefix: "app/1.1.0/" },
        { Prefix: "app/1.2.0/" },
      ],
    });

    // Create content and matching hash
    const content = "app-binary-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3LegacyVersionWithContent("app", "1.2.0", "jetkvm_app", content, hash);

    await RetrieveLatestApp(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://cdn.test.com/app/1.2.0/jetkvm_app",
    );
  });

  it("should redirect to latest prerelease when prerelease=true", async () => {
    const req = createMockRequest({ prerelease: "true" });
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [
        { Prefix: "app/1.0.0/" },
        { Prefix: "app/1.1.0/" },
        { Prefix: "app/2.0.0-beta.1/" },
      ],
    });

    const content = "app-prerelease-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3LegacyVersionWithContent("app", "2.0.0-beta.1", "jetkvm_app", content, hash);

    await RetrieveLatestApp(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://cdn.test.com/app/2.0.0-beta.1/jetkvm_app",
    );
  });

  it("should throw InternalServerError when hash does not match", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
    });

    mockS3LegacyVersionWithContent(
      "app",
      "1.0.0",
      "jetkvm_app",
      "actual-content",
      "wrong-hash-value",
    );

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(InternalServerError);
  });

  it("should throw NotFoundError when app file is missing", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
    });

    // Mock versionHasSkuSupport to return false (no SKU folders)
    s3Mock.on(ListObjectsV2Command, { Prefix: "app/1.0.0/skus/" }).resolves({
      Contents: [],
    });

    s3Mock.on(GetObjectCommand, { Key: "app/1.0.0/jetkvm_app" }).resolves({
      Body: undefined,
    });
    s3Mock.on(GetObjectCommand, { Key: "app/1.0.0/jetkvm_app.sha256" }).resolves({
      Body: createAsyncIterable("some-hash") as any,
    });

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
  });

  describe("SKU handling", () => {
    it("should use legacy path when no SKU provided on legacy version", async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
      });

      const content = "legacy-app-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("app", "1.0.0", "jetkvm_app", content, hash);

      await RetrieveLatestApp(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
    });

    it("should use legacy path when default SKU provided on legacy version", async () => {
      const req = createMockRequest({ sku: "jetkvm-v2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
      });

      const content = "legacy-app-content-default-sku";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("app", "1.0.0", "jetkvm_app", content, hash);

      await RetrieveLatestApp(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
    });

    it("should throw NotFoundError when non-default SKU requested on legacy version", async () => {
      const req = createMockRequest({ sku: "jetkvm-2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
      });

      // Mock versionHasSkuSupport to return false (no SKU folders)
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/1.0.0/skus/" }).resolves({
        Contents: [],
      });

      await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
      await expect(RetrieveLatestApp(req, res)).rejects.toThrow("predates SKU support");
    });

    it("redirects to the requested SKU path when the S3 version has SKU support", async () => {
      const req = createMockRequest({ sku: "jetkvm-2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/2.0.0/" }],
      });

      const content = "sku-app-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-2",
        "jetkvm_app",
        content,
        hash,
      );

      await RetrieveLatestApp(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-2/jetkvm_app",
      );
    });

    it("should use default SKU when no SKU provided on version with SKU support", async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/2.0.0/" }],
      });

      const content = "default-sku-app-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-v2",
        "jetkvm_app",
        content,
        hash,
      );

      await RetrieveLatestApp(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-v2/jetkvm_app",
      );
    });

    it("should throw NotFoundError when requested SKU not available on version with SKU support", async () => {
      const req = createMockRequest({ sku: "jetkvm-3" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/2.0.0/" }],
      });

      // Version has SKU support (jetkvm-v2 exists) but jetkvm-3 doesn't
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/2.0.0/skus/" }).resolves({
        Contents: [{ Key: "app/2.0.0/skus/jetkvm-v2/jetkvm_app" }],
      });
      s3Mock
        .on(HeadObjectCommand, { Key: "app/2.0.0/skus/jetkvm-3/jetkvm_app" })
        .rejects({
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });

      await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
      await expect(RetrieveLatestApp(req, res)).rejects.toThrow(
        "is not available for version",
      );
    });
  });

  describe("cache behavior", () => {
    it("should return cached redirect on second call with same parameters", async () => {
      const req1 = createMockRequest({});
      const res1 = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
      });

      const content = "cached-app-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("app", "1.0.0", "jetkvm_app", content, hash);

      await RetrieveLatestApp(req1, res1);
      expect(res1._redirectUrl).toBe("https://cdn.test.com/app/1.0.0/jetkvm_app");

      // Reset S3 mock to return different data
      s3Mock.reset();
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/2.0.0/" }],
      });
      mockS3LegacyVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm_app",
        "new-content",
        "new-hash",
      );

      // Second call should return cached result (1.0.0), not new S3 data (2.0.0)
      const req2 = createMockRequest({});
      const res2 = createMockResponse();

      await RetrieveLatestApp(req2, res2);
      expect(res2._redirectUrl).toBe("https://cdn.test.com/app/1.0.0/jetkvm_app");
    });

    it("should use different cache keys for different SKUs", async () => {
      // First call with default SKU
      const req1 = createMockRequest({});
      const res1 = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
      });

      const content = "sku-cache-test";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("app", "1.0.0", "jetkvm_app", content, hash);

      await RetrieveLatestApp(req1, res1);
      expect(res1._redirectUrl).toBe("https://cdn.test.com/app/1.0.0/jetkvm_app");

      // Second call with different SKU should NOT use cached result
      s3Mock.reset();
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/2.0.0/" }],
      });
      mockS3SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-2",
        "jetkvm_app",
        content,
        hash,
      );

      const req2 = createMockRequest({ sku: "jetkvm-2" });
      const res2 = createMockResponse();

      await RetrieveLatestApp(req2, res2);
      expect(res2._redirectUrl).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-2/jetkvm_app",
      );
    });
  });
});

describe("RetrieveLatestSystemRecovery S3 redirect handler", () => {
  beforeEach(() => {
    s3Mock.reset();
    clearCaches();
  });

  it("should handle all invalid semver versions gracefully", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    // All versions are invalid semver - latestVersion will be null
    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [
        { Prefix: "system/not-a-version/" },
        { Prefix: "system/invalid/" },
        { Prefix: "system/v1.bad.format/" },
      ],
    });

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
  });

  it("should throw NotFoundError when no system versions exist", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock
      .on(ListObjectsV2Command, { Prefix: "system/" })
      .resolves({ CommonPrefixes: [] });

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
  });

  it("should redirect to latest stable system recovery image", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [
        { Prefix: "system/1.0.0/" },
        { Prefix: "system/1.1.0/" },
        { Prefix: "system/1.2.0/" },
      ],
    });

    const content = "system-recovery-image-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3LegacyVersionWithContent("system", "1.2.0", "update.img", content, hash);

    await RetrieveLatestSystemRecovery(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://cdn.test.com/system/1.2.0/update.img",
    );
  });

  it("should redirect to latest prerelease when prerelease=true", async () => {
    const req = createMockRequest({ prerelease: "true" });
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [{ Prefix: "system/1.0.0/" }, { Prefix: "system/2.0.0-alpha.1/" }],
    });

    const content = "system-prerelease-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3LegacyVersionWithContent(
      "system",
      "2.0.0-alpha.1",
      "update.img",
      content,
      hash,
    );

    await RetrieveLatestSystemRecovery(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://cdn.test.com/system/2.0.0-alpha.1/update.img",
    );
  });

  it("should throw InternalServerError when hash does not match", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
    });

    mockS3LegacyVersionWithContent(
      "system",
      "1.0.0",
      "update.img",
      "actual-content",
      "mismatched-hash",
    );

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(
      InternalServerError,
    );
  });

  it("should throw NotFoundError when recovery image or hash file is missing", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
    });

    // Mock versionHasSkuSupport to return false (no SKU folders)
    s3Mock.on(ListObjectsV2Command, { Prefix: "system/1.0.0/skus/" }).resolves({
      Contents: [],
    });

    s3Mock.on(GetObjectCommand, { Key: "system/1.0.0/update.img" }).resolves({
      Body: undefined,
    });
    s3Mock.on(GetObjectCommand, { Key: "system/1.0.0/update.img.sha256" }).resolves({
      Body: undefined,
    });

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
  });

  describe("SKU handling", () => {
    it("should use legacy path when no SKU provided on legacy version", async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
      });

      const content = "legacy-recovery-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("system", "1.0.0", "update.img", content, hash);

      await RetrieveLatestSystemRecovery(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/system/1.0.0/update.img",
      );
    });

    it("should use legacy path when default SKU provided on legacy version", async () => {
      const req = createMockRequest({ sku: "jetkvm-v2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
      });

      const content = "legacy-recovery-content-default-sku";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("system", "1.0.0", "update.img", content, hash);

      await RetrieveLatestSystemRecovery(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/system/1.0.0/update.img",
      );
    });

    it("should throw NotFoundError when non-default SKU requested on legacy version", async () => {
      const req = createMockRequest({ sku: "jetkvm-2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
      });

      // Mock versionHasSkuSupport to return false (no SKU folders)
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/1.0.0/skus/" }).resolves({
        Contents: [],
      });

      await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
      await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(
        "predates SKU support",
      );
    });

    it("redirects to the requested SKU path when the S3 version has SKU support", async () => {
      const req = createMockRequest({ sku: "jetkvm-2" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/2.0.0/" }],
      });

      const content = "sku-recovery-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-2",
        "update.img",
        content,
        hash,
      );

      await RetrieveLatestSystemRecovery(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-2/update.img",
      );
    });

    it("should use default SKU when no SKU provided on version with SKU support", async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/2.0.0/" }],
      });

      const content = "default-sku-recovery-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-v2",
        "update.img",
        content,
        hash,
      );

      await RetrieveLatestSystemRecovery(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-v2/update.img",
      );
    });

    it("should throw NotFoundError when requested SKU not available on version with SKU support", async () => {
      const req = createMockRequest({ sku: "jetkvm-3" });
      const res = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/2.0.0/" }],
      });

      // Version has SKU support (jetkvm-v2 exists) but jetkvm-3 doesn't
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/2.0.0/skus/" }).resolves({
        Contents: [{ Key: "system/2.0.0/skus/jetkvm-v2/update.img" }],
      });
      s3Mock
        .on(HeadObjectCommand, { Key: "system/2.0.0/skus/jetkvm-3/update.img" })
        .rejects({
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });

      await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
      await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(
        "is not available for version",
      );
    });
  });

  describe("cache behavior", () => {
    it("should return cached redirect on second call with same parameters", async () => {
      const req1 = createMockRequest({});
      const res1 = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
      });

      const content = "cached-system-recovery-content";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("system", "1.0.0", "update.img", content, hash);

      await RetrieveLatestSystemRecovery(req1, res1);
      expect(res1._redirectUrl).toBe("https://cdn.test.com/system/1.0.0/update.img");

      // Reset S3 mock to return different data
      s3Mock.reset();
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/2.0.0/" }],
      });
      mockS3LegacyVersionWithContent(
        "system",
        "2.0.0",
        "update.img",
        "new-content",
        "new-hash",
      );

      // Second call should return cached result (1.0.0), not new S3 data (2.0.0)
      const req2 = createMockRequest({});
      const res2 = createMockResponse();

      await RetrieveLatestSystemRecovery(req2, res2);
      expect(res2._redirectUrl).toBe("https://cdn.test.com/system/1.0.0/update.img");
    });

    it("should use different cache keys for different SKUs", async () => {
      // First call with default SKU
      const req1 = createMockRequest({});
      const res1 = createMockResponse();

      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
      });

      const content = "sku-cache-test-recovery";
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      mockS3LegacyVersionWithContent("system", "1.0.0", "update.img", content, hash);

      await RetrieveLatestSystemRecovery(req1, res1);
      expect(res1._redirectUrl).toBe("https://cdn.test.com/system/1.0.0/update.img");

      // Second call with different SKU should NOT use cached result
      s3Mock.reset();
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/2.0.0/" }],
      });
      mockS3SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-2",
        "update.img",
        content,
        hash,
      );

      const req2 = createMockRequest({ sku: "jetkvm-2" });
      const res2 = createMockResponse();

      await RetrieveLatestSystemRecovery(req2, res2);
      expect(res2._redirectUrl).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-2/update.img",
      );
    });
  });
});
