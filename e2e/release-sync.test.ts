import { afterEach, describe, expect, inject, it } from "vitest";
import {
  api,
  cdn,
  db,
  removeArtifact,
  sha256,
  syncReleases,
  uploadArtifact,
} from "./helpers";

async function registered() {
  return db.release.findMany({
    select: {
      type: true,
      version: true,
      artifacts: { select: { url: true, compatibleSkus: true }, orderBy: { id: "asc" } },
    },
    orderBy: [{ type: "asc" }, { id: "asc" }],
  });
}

describe("release registration", () => {
  it("registers each stable version in the bucket with the SKUs it has files for", async () => {
    expect(await registered()).toEqual([
      {
        type: "app",
        version: "0.3.0",
        artifacts: [{ url: cdn("app/0.3.0/jetkvm_app"), compatibleSkus: ["jetkvm-v2"] }],
      },
      {
        type: "app",
        version: "0.4.0",
        artifacts: [
          {
            url: cdn("app/0.4.0/skus/jetkvm-v2/jetkvm_app"),
            compatibleSkus: ["jetkvm-v2"],
          },
          {
            url: cdn("app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app"),
            compatibleSkus: ["jetkvm-v2-sdmmc"],
          },
        ],
      },
      {
        type: "app",
        version: "0.5.0",
        artifacts: [
          {
            url: cdn("app/0.5.0/skus/jetkvm-v2/jetkvm_app"),
            compatibleSkus: ["jetkvm-v2"],
          },
        ],
      },
      {
        type: "mini",
        version: "0.5.3",
        artifacts: [
          {
            url: cdn("mini/0.5.3/skus/jetkvm-mini-ethernet/jetkvm-mini.bin"),
            compatibleSkus: ["jetkvm-mini-ethernet"],
          },
          {
            url: cdn("mini/0.5.3/skus/jetkvm-mini-wireless/jetkvm-mini.bin"),
            compatibleSkus: ["jetkvm-mini-wireless"],
          },
        ],
      },
      {
        type: "mini",
        version: "0.5.4",
        artifacts: [
          {
            url: cdn("mini/0.5.4/skus/jetkvm-mini-ethernet/jetkvm-mini.bin"),
            compatibleSkus: ["jetkvm-mini-ethernet"],
          },
        ],
      },
      {
        type: "system",
        version: "0.2.0",
        artifacts: [
          { url: cdn("system/0.2.0/system.tar"), compatibleSkus: ["jetkvm-v2"] },
        ],
      },
      {
        type: "system",
        version: "0.3.0",
        artifacts: [
          {
            url: cdn("system/0.3.0/skus/jetkvm-v2/system.tar"),
            compatibleSkus: ["jetkvm-v2"],
          },
          {
            url: cdn("system/0.3.0/skus/jetkvm-v2-sdmmc/system.tar"),
            compatibleSkus: ["jetkvm-v2-sdmmc"],
          },
        ],
      },
    ]);
  });

  describe("of a new upload", () => {
    const keys = [
      "app/0.4.5/skus/jetkvm-v2/jetkvm_app",
      "app/0.4.5/skus/jetkvm-v2-sdmmc/jetkvm_app",
    ];

    afterEach(async () => {
      await db.release.deleteMany({ where: { type: "app", version: "0.4.5" } });
      await Promise.all(keys.map(removeArtifact));
    });

    it("waits for the upload to settle unless the uploader says it is complete, then starts at 0%", async () => {
      const bodies = keys.map(key => Buffer.from(`new upload ${key}`));
      await Promise.all(keys.map((key, i) => uploadArtifact(key, bodies[i])));

      // The objects were just written, so an unattended run leaves the version for later
      const unattended = await syncReleases();
      expect(unattended.status).toBe(200);
      expect(await unattended.json()).toMatchObject({ created: 0 });
      expect(await db.release.count({ where: { type: "app", version: "0.4.5" } })).toBe(
        0,
      );

      const vouched = await syncReleases({ type: "app", version: "0.4.5" });
      expect(await vouched.json()).toMatchObject({ created: 1 });

      const release = await db.release.findUniqueOrThrow({
        where: { version_type: { version: "0.4.5", type: "app" } },
        include: { artifacts: { orderBy: { id: "asc" } } },
      });
      expect(release.rolloutPercentage).toBe(0);
      expect(
        release.artifacts.map(({ url, hash, compatibleSkus }) => ({
          url,
          hash,
          compatibleSkus,
        })),
      ).toEqual([
        { url: cdn(keys[0]), hash: sha256(bodies[0]), compatibleSkus: ["jetkvm-v2"] },
        {
          url: cdn(keys[1]),
          hash: sha256(bodies[1]),
          compatibleSkus: ["jetkvm-v2-sdmmc"],
        },
      ]);
    });
  });

  it("never changes a release that is already registered", async () => {
    await db.release.updateMany({
      where: { type: "app", version: "0.4.0" },
      data: { rolloutPercentage: 37 },
    });
    const before = await db.release.findFirstOrThrow({
      where: { type: "app", version: "0.4.0" },
      include: { artifacts: true },
    });

    const response = await syncReleases({ type: "app", version: "0.4.0" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 0 });

    const after = await db.release.findFirstOrThrow({
      where: { type: "app", version: "0.4.0" },
      include: { artifacts: true },
    });
    expect(after).toEqual(before);
  });
});

describe("POST /releases/sync", () => {
  const token = inject("syncToken");

  it.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: "Bearer not-the-token" }],
    [
      "the token in another letter case",
      { authorization: `Bearer ${token.toUpperCase()}` },
    ],
    ["the token under another scheme", { authorization: `Basic ${token}` }],
  ])("rejects %s with 401", async (_name, headers) => {
    const response = await api("/releases/sync", { method: "POST", headers });
    expect(response.status).toBe(401);
  });

  it("accepts the token with the scheme name in any case", async () => {
    const response = await api("/releases/sync", {
      method: "POST",
      headers: { authorization: `bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["a type without a version", { type: "app" }],
    ["a version without a type", { version: "0.4.0" }],
    ["an unknown type", { type: "firmware", version: "0.4.0" }],
  ])("rejects %s with 400", async (_name, body) => {
    expect((await syncReleases(body)).status).toBe(400);
  });
});
