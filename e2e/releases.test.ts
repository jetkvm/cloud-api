import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_IN_BUCKET } from "./fixtures";
import {
  api,
  cdn,
  db,
  expectServable,
  getRelease,
  objectBytes,
  removeArtifact,
  setRollouts,
  syncReleases,
  uploadArtifact,
} from "./helpers";

// Selection rules are covered by test/releases.test.ts against a mocked S3.
// These tests cover what only a real bucket, a real sync and HTTP show: the
// files a device is sent exist and match the hash it is told to check.

const V2 = "jetkvm-v2";
const SDMMC = "jetkvm-v2-sdmmc";
const MINI_ETH = "jetkvm-mini-ethernet";
const MINI_WIFI = "jetkvm-mini-wireless";

/** The offered versions and URLs, after checking every URL serves bytes with the offered hash. */
async function offered(query: Record<string, string>) {
  const { status, body } = await getRelease(query);
  expect(status, JSON.stringify(body)).toBe(200);
  if (body.appUrl) await expectServable(body.appUrl, body.appHash);
  if (body.systemUrl) await expectServable(body.systemUrl, body.systemHash);
  return {
    appVersion: body.appVersion,
    appUrl: body.appUrl,
    systemVersion: body.systemVersion,
    systemUrl: body.systemUrl,
  };
}

const device = (bucket: keyof typeof DEVICE_IN_BUCKET, sku = V2) => ({
  deviceId: DEVICE_IN_BUCKET[bucket],
  sku,
});

describe("an update check", () => {
  it("gets, for each SKU, files that exist and match the hashes it must verify", async () => {
    await setRollouts({
      app: { "0.4.0": 100 },
      system: { "0.3.0": 100 },
      mini: { "0.5.3": 100, "0.5.4": 100 },
    });

    expect(await offered(device(9, V2))).toEqual({
      appVersion: "0.4.0",
      appUrl: cdn("app/0.4.0/skus/jetkvm-v2/jetkvm_app"),
      systemVersion: "0.3.0",
      systemUrl: cdn("system/0.3.0/skus/jetkvm-v2/system.tar"),
    });
    expect(await offered(device(9, SDMMC))).toEqual({
      appVersion: "0.4.0",
      appUrl: cdn("app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app"),
      systemVersion: "0.3.0",
      systemUrl: cdn("system/0.3.0/skus/jetkvm-v2-sdmmc/system.tar"),
    });
    expect(await offered(device(9, MINI_ETH))).toEqual({
      appVersion: undefined,
      appUrl: undefined,
      systemVersion: "0.5.4",
      systemUrl: cdn("mini/0.5.4/skus/jetkvm-mini-ethernet/jetkvm-mini.bin"),
    });
    // 0.5.4 has no wireless build
    expect(await offered(device(9, MINI_WIFI))).toMatchObject({
      systemVersion: "0.5.3",
      systemUrl: cdn("mini/0.5.3/skus/jetkvm-mini-wireless/jetkvm-mini.bin"),
    });
  });

  it("gets a signature URL only where the bucket has a .sig file", async () => {
    await setRollouts({ app: { "0.4.0": 100 }, system: { "0.3.0": 100 } });

    const v2 = (await getRelease(device(9, V2))).body;
    expect(v2.appSigUrl).toBe(cdn("app/0.4.0/skus/jetkvm-v2/jetkvm_app.sig"));
    expect(
      (await objectBytes("app/0.4.0/skus/jetkvm-v2/jetkvm_app.sig")).length,
    ).toBeGreaterThan(0);
    expect(v2).not.toHaveProperty("systemSigUrl");
    expect((await getRelease(device(9, SDMMC))).body).not.toHaveProperty("appSigUrl");
  });

  it("puts devices into a staged rollout by a bucket that does not change between versions of the API", async () => {
    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 50 }, system: { "0.3.0": 100 } });
    expect((await offered(device(0))).appVersion).toBe("0.5.0");
    expect((await offered(device(49))).appVersion).toBe("0.5.0");
    expect((await offered(device(50))).appVersion).toBe("0.4.0");
    expect((await offered(device(99))).appVersion).toBe("0.4.0");

    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 81 }, system: { "0.3.0": 100 } });
    expect((await offered(device(81))).appVersion).toBe("0.4.0");
    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 82 }, system: { "0.3.0": 100 } });
    expect((await offered(device(81))).appVersion).toBe("0.5.0");
  });

  it("never sends a device a file built for other hardware", async () => {
    // 0.5.0 has no SDMMC build; 0.3.0 and 0.2.0 predate the SKU layout and are JetKVM v2 only
    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 100 }, system: { "0.3.0": 100 } });
    expect((await offered(device(9, SDMMC))).appUrl).toBe(
      cdn("app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app"),
    );

    await setRollouts({ app: { "0.3.0": 100 }, system: { "0.2.0": 100 } });
    expect(await offered(device(9, V2))).toMatchObject({
      appUrl: cdn("app/0.3.0/jetkvm_app"),
      systemUrl: cdn("system/0.2.0/system.tar"),
    });
    expect((await getRelease(device(9, SDMMC))).status).toBe(404);
  });

  it("on the prerelease channel gets the newest build in the bucket, whatever the rollout", async () => {
    await setRollouts({});
    expect(await offered({ ...device(99, V2), prerelease: "true" })).toEqual({
      appVersion: "0.6.0-beta.1",
      appUrl: cdn("app/0.6.0-beta.1/skus/jetkvm-v2/jetkvm_app"),
      systemVersion: "0.4.0-rc.1",
      systemUrl: cdn("system/0.4.0-rc.1/skus/jetkvm-v2/system.tar"),
    });
  });
});

describe("a release from upload to full rollout", () => {
  const keys = [
    "app/0.4.6/skus/jetkvm-v2/jetkvm_app",
    "app/0.4.6/skus/jetkvm-v2-sdmmc/jetkvm_app",
  ];

  afterEach(async () => {
    await db.release.deleteMany({ where: { type: "app", version: "0.4.6" } });
    await Promise.all(keys.map(removeArtifact));
  });

  const setApp046 = (rolloutPercentage: number) =>
    db.release.updateMany({
      where: { type: "app", version: "0.4.6" },
      data: { rolloutPercentage },
    });

  it("reaches no device at 0%, the devices in the bucket while staged, and every device at 100%", async () => {
    // app 0.5.0 stays registered at 0%: a newer unreleased version must not get in the way
    await setRollouts({ app: { "0.4.0": 100 }, system: { "0.3.0": 100 } });
    await Promise.all(
      keys.map(key => uploadArtifact(key, Buffer.from(`release ${key}`))),
    );
    expect(
      await (await syncReleases({ type: "app", version: "0.4.6" })).json(),
    ).toMatchObject({
      created: 1,
    });

    // Registered at 0%: every device keeps 0.4.0
    for (const bucket of [0, 9, 81, 99] as const) {
      expect((await offered(device(bucket))).appVersion).toBe("0.4.0");
    }

    await setApp046(30);
    expect(await offered(device(9))).toMatchObject({
      appVersion: "0.4.6",
      appUrl: cdn(keys[0]),
    });
    expect(await offered(device(9, SDMMC))).toMatchObject({
      appVersion: "0.4.6",
      appUrl: cdn(keys[1]),
    });
    expect((await offered(device(81))).appVersion).toBe("0.4.0");
    expect((await offered(device(81, SDMMC))).appVersion).toBe("0.4.0");

    await setApp046(100);
    for (const bucket of [0, 81, 99] as const) {
      expect((await offered(device(bucket))).appVersion).toBe("0.4.6");
      expect((await offered(device(bucket, SDMMC))).appUrl).toBe(cdn(keys[1]));
    }
  });
});

describe("the first staged release that has a build for a new SKU", () => {
  // app 0.3.0 predates the SKU layout (JetKVM v2 only); 0.4.0 is the first with an SDMMC build
  it("reaches the new SKU's devices in the bucket, and the rest get 404 until it is rolled out", async () => {
    await setRollouts({ app: { "0.3.0": 100, "0.4.0": 30 }, system: { "0.3.0": 100 } });

    expect(await offered(device(9, SDMMC))).toMatchObject({
      appVersion: "0.4.0",
      appUrl: cdn("app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app"),
    });
    const outside = await getRelease(device(81, SDMMC));
    expect(outside.status).toBe(404);
    expect(outside.body.name).toBe("NotFoundError");

    // The original JetKVM is not affected
    expect((await offered(device(9, V2))).appVersion).toBe("0.4.0");
    expect((await offered(device(81, V2))).appUrl).toBe(cdn("app/0.3.0/jetkvm_app"));
  });
});

describe("an update check that pins one part", () => {
  it("gets the other part as a background check would: rolled out, with a build for the SKU", async () => {
    // system 0.3.0 is registered but not released; app 0.5.0 has no SDMMC build
    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 100 }, system: { "0.2.0": 100 } });

    expect(await offered({ ...device(9, V2), appVersion: "0.5.0" })).toMatchObject({
      appVersion: "0.5.0",
      systemVersion: "0.2.0",
    });
    expect(await offered({ ...device(9, V2), systemVersion: "0.3.0" })).toMatchObject({
      appVersion: "0.5.0",
      systemVersion: "0.3.0",
    });

    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 100 }, system: { "0.3.0": 100 } });
    expect(await offered({ ...device(9, SDMMC), systemVersion: "0.3.0" })).toMatchObject({
      appVersion: "0.4.0",
      appUrl: cdn("app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app"),
      systemVersion: "0.3.0",
    });
  });

  it("follows the device's rollout bucket for the other part", async () => {
    await setRollouts({ app: { "0.4.0": 100, "0.5.0": 50 }, system: { "0.3.0": 100 } });
    expect((await offered({ ...device(9), systemVersion: "0.3.0" })).appVersion).toBe(
      "0.5.0",
    );
    expect((await offered({ ...device(81), systemVersion: "0.3.0" })).appVersion).toBe(
      "0.4.0",
    );
  });
});

describe("a SKU missing from the newest upload", () => {
  // app 0.5.0 has no SDMMC build; mini 0.5.4 has no wireless build

  it("does not hide the newest version that has it on the prerelease channel", async () => {
    await setRollouts({});
    expect(await offered({ ...device(9, MINI_WIFI), prerelease: "true" })).toMatchObject({
      systemVersion: "0.5.3",
      systemUrl: cdn("mini/0.5.3/skus/jetkvm-mini-wireless/jetkvm-mini.bin"),
    });
  });

  it.each([
    "/releases/app/latest?sku=jetkvm-v2-sdmmc",
    "/releases/system_recovery/latest?sku=jetkvm-mini-wireless",
  ])("makes %s answer 404, not an older file", async path => {
    expect((await api(path)).status).toBe(404);
  });
});

describe("an update check that cannot be answered", () => {
  it("gets 404 while every release is registered at 0%", async () => {
    await setRollouts({});
    for (const sku of [V2, SDMMC, MINI_ETH]) {
      expect((await getRelease(device(9, sku))).status).toBe(404);
    }
  });

  it("gets 404 for a pinned version that does not exist", async () => {
    await setRollouts({ app: { "0.4.0": 100 }, system: { "0.3.0": 100 } });
    const { status } = await getRelease({
      ...device(9),
      appVersion: "9.9.9",
      systemVersion: "0.3.0",
    });
    expect(status).toBe(404);
  });

  it.each([
    ["no device ID", ""],
    ["an empty device ID", "deviceId="],
    ["an unknown SKU", `deviceId=${DEVICE_IN_BUCKET[9]}&sku=jetkvm-v3`],
  ])("with %s gets 400 and no release", async (_name, query) => {
    await setRollouts({ app: { "0.4.0": 100 }, system: { "0.3.0": 100 } });
    const response = await api(`/releases?${query}`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.name).toBe("BadRequestError");
    expect(body).not.toHaveProperty("appUrl");
    expect(body).not.toHaveProperty("stack");
  });
});

describe("the latest-artifact redirects used by build tooling", () => {
  it.each([
    ["/releases/app/latest", "app/0.5.0/skus/jetkvm-v2/jetkvm_app"],
    [
      "/releases/app/latest?prerelease=true",
      "app/0.6.0-beta.1/skus/jetkvm-v2/jetkvm_app",
    ],
    ["/releases/system_recovery/latest", "system/0.3.0/skus/jetkvm-v2/update.img"],
    [
      "/releases/system_recovery/latest?sku=jetkvm-v2-sdmmc",
      "system/0.3.0/skus/jetkvm-v2-sdmmc/update_sd.img.zip",
    ],
    [
      "/releases/system_recovery/latest?prerelease=true",
      "system/0.4.0-rc.1/skus/jetkvm-v2/update.img",
    ],
    [
      "/releases/system_recovery/latest?sku=jetkvm-mini-ethernet",
      "mini/0.5.4/skus/jetkvm-mini-ethernet/jetkvm-mini-full.bin",
    ],
  ])("%s redirects to %s, which exists", async (path, key) => {
    const response = await api(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(cdn(key));
    expect((await objectBytes(key)).length).toBeGreaterThan(0);
  });

  it.each([
    "/releases/app/latest?sku=jetkvm-mini-ethernet",
    "/releases/app/latest?sku=jetkvm-v3",
    "/releases/system_recovery/latest?sku=jetkvm-v3",
  ])("%s is a bad request", async path => {
    expect((await api(path)).status).toBe(400);
  });
});
