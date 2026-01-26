import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3Mock, createAsyncIterable, testPrisma, seedReleases, setRollout, resetToSeedData } from "./setup";
import { BadRequestError, NotFoundError, InternalServerError } from "../src/errors";
import { createHash } from "crypto";

// Import the module under test after setup
import { Retrieve, RetrieveLatestApp, RetrieveLatestSystemRecovery, clearCaches } from "../src/releases";

// Helper to create mock Request
function createMockRequest(query: Record<string, string | undefined> = {}): Request {
  return {
    query,
  } as unknown as Request;
}

// Helper to create mock Response
function createMockResponse(): Response & { _json: any; _redirectUrl: string; _redirectStatus: number } {
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
  } as unknown as Response & { _json: any; _redirectUrl: string; _redirectStatus: number };
  return res;
}

// Mock S3 responses for listing versions
function mockS3ListVersions(prefix: "app" | "system", versions: string[]) {
  s3Mock.on(ListObjectsV2Command, { Prefix: `${prefix}/` }).resolves({
    CommonPrefixes: versions.map((v) => ({ Prefix: `${prefix}/${v}/` })),
  });
}

// Mock S3 hash file response
function mockS3HashFile(prefix: "app" | "system", version: string, hash: string) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  s3Mock.on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });
}

// Mock S3 file and hash for redirect endpoints
function mockS3FileWithHash(
  prefix: "app" | "system",
  version: string,
  fileName: string,
  content: string,
  hash: string
) {
  s3Mock.on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}` }).resolves({
    Body: createAsyncIterable(content) as any,
  });
  s3Mock.on(GetObjectCommand, { Key: `${prefix}/${version}/${fileName}.sha256` }).resolves({
    Body: createAsyncIterable(hash) as any,
  });
}

function rolloutBucket(deviceId: string) {
  const hash = createHash("md5").update(deviceId).digest("hex");
  const hashPrefix = hash.substring(0, 8);
  return parseInt(hashPrefix, 16) % 100;
}

function findDeviceIdOutsideRollout(threshold: number) {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `device-not-eligible-${i}`;
    if (rolloutBucket(candidate) >= threshold) {
      return candidate;
    }
  }
  throw new Error("Failed to find deviceId outside rollout bucket");
}

function findDeviceIdInsideRollout(threshold: number) {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `device-eligible-${i}`;
    if (rolloutBucket(candidate) < threshold) {
      return candidate;
    }
  }
  throw new Error("Failed to find deviceId inside rollout bucket");
}

describe("Retrieve handler", () => {
  beforeEach(() => {
    s3Mock.reset();
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
      const req = createMockRequest({ deviceId: "device-123" });
      const res = createMockResponse();

      // Mock empty S3 response for both app and system
      s3Mock.on(ListObjectsV2Command).resolves({ CommonPrefixes: [] });

      await expect(Retrieve(req, res)).rejects.toThrow(NotFoundError);
    });

    it("should throw NotFoundError when no valid semver versions exist", async () => {
      const req = createMockRequest({ deviceId: "device-123" });
      const res = createMockResponse();

      // Mock S3 with invalid version names
      s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
        CommonPrefixes: [{ Prefix: "app/invalid-version/" }, { Prefix: "app/not-semver/" }],
      });
      s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
        CommonPrefixes: [{ Prefix: "system/invalid-version/" }, { Prefix: "system/not-semver/" }],
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

  describe("version constraints", () => {
    it("should respect appVersion constraint", async () => {
      const req = createMockRequest({ deviceId: "device-123", appVersion: "^1.0.0" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "2.0.0"]);
      mockS3ListVersions("system", ["1.0.0", "2.0.0"]);
      mockS3HashFile("app", "1.1.0", "app-hash-110");
      mockS3HashFile("system", "2.0.0", "system-hash-200");

      await Retrieve(req, res);

      expect(res._json.appVersion).toBe("1.1.0"); // Max satisfying ^1.0.0
      expect(res._json.systemVersion).toBe("2.0.0"); // No constraint, get latest
    });

    it("should respect systemVersion constraint", async () => {
      const req = createMockRequest({ deviceId: "device-123", systemVersion: "~1.0.0" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "2.0.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.0.5", "1.1.0", "2.0.0"]);
      mockS3HashFile("app", "2.0.0", "app-hash-200");
      mockS3HashFile("system", "1.0.5", "system-hash-105");

      await Retrieve(req, res);

      expect(res._json.appVersion).toBe("2.0.0");
      expect(res._json.systemVersion).toBe("1.0.5"); // Max satisfying ~1.0.0
    });

    it("should skip rollout when version constraints are specified", async () => {
      const req = createMockRequest({
        deviceId: "device-123",
        appVersion: "1.0.0",
        systemVersion: "1.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "2.0.0"]);
      mockS3ListVersions("system", ["1.0.0", "2.0.0"]);
      mockS3HashFile("app", "1.0.0", "app-hash-100");
      mockS3HashFile("system", "1.0.0", "system-hash-100");

      await Retrieve(req, res);

      // Should return specified version directly (skipRollout=true)
      expect(res._json.appVersion).toBe("1.0.0");
      expect(res._json.systemVersion).toBe("1.0.0");
    });

    it("should throw NotFoundError when no version satisfies constraint", async () => {
      const req = createMockRequest({ deviceId: "device-123", appVersion: "^5.0.0" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "2.0.0"]);

      await expect(Retrieve(req, res)).rejects.toThrow(NotFoundError);
    });
  });

  describe("forceUpdate mode", () => {
    it("should return latest release when forceUpdate=true", async () => {
      // Use unique version constraints to get unique cache keys
      const req = createMockRequest({
        deviceId: "device-force",
        forceUpdate: "true",
        appVersion: "^1.5.0",
        systemVersion: "^1.5.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.5.5"]);
      mockS3ListVersions("system", ["1.0.0", "1.5.5"]);
      mockS3HashFile("app", "1.5.5", "force-app-hash");
      mockS3HashFile("system", "1.5.5", "force-system-hash");

      await Retrieve(req, res);

      // forceUpdate should return the latest version from S3 (upserted in DB)
      expect(res._json.appVersion).toBe("1.5.5");
      expect(res._json.systemVersion).toBe("1.5.5");
    });
  });

  describe("rollout logic", () => {
    beforeEach(async () => {
      // Reset to baseline seed data before each rollout test
      await resetToSeedData();
    });

    it("should return default release for device not in rollout percentage", async () => {
      // Explicitly set rollout: 1.1.0 at 100% (default), 1.2.0 at 10% (latest)
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 10);
      await setRollout("1.2.0", "system", 10);

      // Use a device ID that will NOT be eligible (hash % 100 >= 10)
      const deviceId = findDeviceIdOutsideRollout(10);
      const req = createMockRequest({ deviceId });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req, res);

      // Device not in 10% rollout should get 1.1.0 (latest 100% default)
      expect(res._json.appVersion).toBe("1.1.0");
      expect(res._json.systemVersion).toBe("1.1.0");
    });

    it("should return latest release when device is in rollout percentage", async () => {
      // Set 1.2.0 to 10% rollout and pick an eligible device
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 10);
      await setRollout("1.2.0", "system", 10);

      const deviceId = findDeviceIdInsideRollout(10);
      const req = createMockRequest({ deviceId });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req, res);

      // With a device in the rollout bucket, it should get the latest
      expect(res._json.appVersion).toBe("1.2.0");
      expect(res._json.systemVersion).toBe("1.2.0");
    });

    it("should return default when rollout is 0%", async () => {
      // Set 1.2.0 to 0% rollout - no devices should get it
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 0);
      await setRollout("1.2.0", "system", 0);

      const req = createMockRequest({ deviceId: "any-device" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req, res);

      // With 0% rollout, all devices get the default (1.1.0)
      expect(res._json.appVersion).toBe("1.1.0");
      expect(res._json.systemVersion).toBe("1.1.0");
    });

    it("should evaluate app and system rollout independently", async () => {
      // Set different rollouts: app at 100%, system at 0%
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 100); // All devices get latest app
      await setRollout("1.2.0", "system", 0); // No devices get latest system

      const req = createMockRequest({ deviceId: "any-device" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req, res);

      // App gets 1.2.0 (100% rollout), system gets 1.1.0 (default, since 1.2.0 is 0%)
      expect(res._json.appVersion).toBe("1.2.0");
      expect(res._json.systemVersion).toBe("1.1.0");
    });
  });

  describe("default release handling", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should throw InternalServerError when no default release exists", async () => {
      // Set all releases to non-100% rollout (no default available)
      await setRollout("1.0.0", "app", 50);
      await setRollout("1.1.0", "app", 50);
      await setRollout("1.2.0", "app", 50);
      await setRollout("1.0.0", "system", 50);
      await setRollout("1.1.0", "system", 50);
      await setRollout("1.2.0", "system", 50);

      const req = createMockRequest({ deviceId: "device-123" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await expect(Retrieve(req, res)).rejects.toThrow(InternalServerError);
    });
  });

  describe("S3 non-NotFoundError handling", () => {
    it("should wrap non-NotFoundError in InternalServerError", async () => {
      const req = createMockRequest({ deviceId: "device-123" });
      const res = createMockResponse();

      // Mock S3 to throw a generic error (e.g., network error)
      s3Mock.on(ListObjectsV2Command).rejects(new Error("Network timeout"));

      await expect(Retrieve(req, res)).rejects.toThrow(InternalServerError);
      await expect(Retrieve(req, res)).rejects.toThrow("Failed to get the latest release from S3");
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

  describe("new release auto-creation", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should create new release with 10% rollout when version not in DB", async () => {
      // Use a version that definitely doesn't exist in seed data
      const newVersion = "9.9.9";

      const req = createMockRequest({ deviceId: "new-release-device" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", newVersion]);
      mockS3ListVersions("system", ["1.0.0", newVersion]);
      mockS3HashFile("app", newVersion, "new-version-app-hash");
      mockS3HashFile("system", newVersion, "new-version-system-hash");

      await Retrieve(req, res);

      // Verify the new release was created in DB with 10% rollout
      const createdAppRelease = await testPrisma.release.findUnique({
        where: { version_type: { version: newVersion, type: "app" } },
      });
      const createdSystemRelease = await testPrisma.release.findUnique({
        where: { version_type: { version: newVersion, type: "system" } },
      });

      expect(createdAppRelease).not.toBeNull();
      expect(createdAppRelease?.rolloutPercentage).toBe(10);
      expect(createdSystemRelease).not.toBeNull();
      expect(createdSystemRelease?.rolloutPercentage).toBe(10);

      // Clean up
      await testPrisma.release.deleteMany({ where: { version: newVersion } });
    });
  });

  describe("default release selection", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should return latest version among multiple 100% rollout releases", async () => {
      // Explicitly set: 1.0.0 and 1.1.0 at 100%, 1.2.0 at 0%
      await setRollout("1.0.0", "app", 100);
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.2.0", "app", 0);
      await setRollout("1.0.0", "system", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "system", 0);

      const req = createMockRequest({ deviceId: "default-selection-device" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req, res);

      // 1.2.0 has 0% rollout, so device gets 1.1.0 (latest 100% default)
      expect(res._json.appVersion).toBe("1.1.0");
      expect(res._json.systemVersion).toBe("1.1.0");
    });
  });

  describe("rollout eligibility", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should be deterministic - same deviceId always gets same result", async () => {
      // Set explicit rollout: 1.1.0 at 100%, 1.2.0 at 50%
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 50);
      await setRollout("1.2.0", "system", 50);

      const deviceId = "deterministic-test-device-abc123";

      // Make two separate calls with the same deviceId
      const req1 = createMockRequest({ deviceId });
      const res1 = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req1, res1);
      const firstAppVersion = res1._json.appVersion;
      const firstSystemVersion = res1._json.systemVersion;

      // Clear caches and make second call
      clearCaches();
      s3Mock.reset();

      const req2 = createMockRequest({ deviceId });
      const res2 = createMockResponse();

      mockS3ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockS3HashFile("app", "1.2.0", "abc123hash120");
      mockS3HashFile("system", "1.2.0", "sys123hash120");

      await Retrieve(req2, res2);

      // Same deviceId should get same versions (deterministic)
      expect(res2._json.appVersion).toBe(firstAppVersion);
      expect(res2._json.systemVersion).toBe(firstSystemVersion);
    });
  });

  describe("response structure", () => {
    it("should include all required fields in response", async () => {
      const req = createMockRequest({ deviceId: "device-123", prerelease: "true" });
      const res = createMockResponse();

      mockS3ListVersions("app", ["1.0.0"]);
      mockS3ListVersions("system", ["1.0.0"]);
      mockS3HashFile("app", "1.0.0", "app-hash");
      mockS3HashFile("system", "1.0.0", "system-hash");

      await Retrieve(req, res);

      expect(res._json).toHaveProperty("appVersion");
      expect(res._json).toHaveProperty("appUrl");
      expect(res._json).toHaveProperty("appHash");
      expect(res._json).toHaveProperty("systemVersion");
      expect(res._json).toHaveProperty("systemUrl");
      expect(res._json).toHaveProperty("systemHash");
    });

    it("should return correct URL format", async () => {
      // Use unique version constraints for unique cache keys
      const req = createMockRequest({
        deviceId: "device-url-test",
        prerelease: "true",
        appVersion: "^4.0.0",
        systemVersion: "^4.0.0",
      });
      const res = createMockResponse();

      mockS3ListVersions("app", ["4.0.0"]);
      mockS3ListVersions("system", ["4.0.0"]);
      mockS3HashFile("app", "4.0.0", "app-hash-400");
      mockS3HashFile("system", "4.0.0", "system-hash-400");

      await Retrieve(req, res);

      expect(res._json.appUrl).toBe("https://cdn.test.com/app/4.0.0/jetkvm_app");
      expect(res._json.systemUrl).toBe("https://cdn.test.com/system/4.0.0/system.tar");
    });
  });
});

describe("RetrieveLatestApp handler", () => {
  beforeEach(() => {
    s3Mock.reset();
    clearCaches();
  });

  it("should handle all invalid semver versions gracefully", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    // All versions are invalid semver
    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [
        { Prefix: "app/not-valid/" },
        { Prefix: "app/bad-version/" },
      ],
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
      CommonPrefixes: [{ Prefix: "app/1.0.0/" }, { Prefix: "app/1.1.0/" }, { Prefix: "app/1.2.0/" }],
    });

    // Create content and matching hash
    const content = "app-binary-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3FileWithHash("app", "1.2.0", "jetkvm_app", content, hash);

    await RetrieveLatestApp(req, res);

    expect(res.redirect).toHaveBeenCalledWith(302, "https://cdn.test.com/app/1.2.0/jetkvm_app");
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

    mockS3FileWithHash("app", "2.0.0-beta.1", "jetkvm_app", content, hash);

    await RetrieveLatestApp(req, res);

    expect(res.redirect).toHaveBeenCalledWith(302, "https://cdn.test.com/app/2.0.0-beta.1/jetkvm_app");
  });

  it("should throw InternalServerError when hash does not match", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
    });

    mockS3FileWithHash("app", "1.0.0", "jetkvm_app", "actual-content", "wrong-hash-value");

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(InternalServerError);
  });

  it("should throw NotFoundError when app file is missing", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "app/" }).resolves({
      CommonPrefixes: [{ Prefix: "app/1.0.0/" }],
    });

    s3Mock.on(GetObjectCommand, { Key: "app/1.0.0/jetkvm_app" }).resolves({
      Body: undefined,
    });
    s3Mock.on(GetObjectCommand, { Key: "app/1.0.0/jetkvm_app.sha256" }).resolves({
      Body: createAsyncIterable("some-hash") as any,
    });

    await expect(RetrieveLatestApp(req, res)).rejects.toThrow(NotFoundError);
  });
});

describe("RetrieveLatestSystemRecovery handler", () => {
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

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({ CommonPrefixes: [] });

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

    mockS3FileWithHash("system", "1.2.0", "update.img", content, hash);

    await RetrieveLatestSystemRecovery(req, res);

    expect(res.redirect).toHaveBeenCalledWith(302, "https://cdn.test.com/system/1.2.0/update.img");
  });

  it("should redirect to latest prerelease when prerelease=true", async () => {
    const req = createMockRequest({ prerelease: "true" });
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [
        { Prefix: "system/1.0.0/" },
        { Prefix: "system/2.0.0-alpha.1/" },
      ],
    });

    const content = "system-prerelease-content";
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    mockS3FileWithHash("system", "2.0.0-alpha.1", "update.img", content, hash);

    await RetrieveLatestSystemRecovery(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://cdn.test.com/system/2.0.0-alpha.1/update.img"
    );
  });

  it("should throw InternalServerError when hash does not match", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
    });

    mockS3FileWithHash("system", "1.0.0", "update.img", "actual-content", "mismatched-hash");

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(InternalServerError);
  });

  it("should throw NotFoundError when recovery image or hash file is missing", async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    s3Mock.on(ListObjectsV2Command, { Prefix: "system/" }).resolves({
      CommonPrefixes: [{ Prefix: "system/1.0.0/" }],
    });

    s3Mock.on(GetObjectCommand, { Key: "system/1.0.0/update.img" }).resolves({
      Body: undefined,
    });
    s3Mock.on(GetObjectCommand, { Key: "system/1.0.0/update.img.sha256" }).resolves({
      Body: undefined,
    });

    await expect(RetrieveLatestSystemRecovery(req, res)).rejects.toThrow(NotFoundError);
  });
});
