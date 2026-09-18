import { describe, expect, it } from "vitest";

import {
  DEFAULT_SKU,
  KNOWN_SKUS,
  OTA_PREFIXES,
  artifactFor,
  effectiveSku,
  isKnownSku,
  legacyCompatibleSkus,
  normalizeSku,
  otaArtifacts,
  otaFileForPrefix,
  skusForPrefix,
} from "../src/skus";

const JETKVM_SKUS = ["jetkvm-v2", "jetkvm-v2-sdmmc"];
const MINI_SKUS = ["jetkvm-mini-ethernet", "jetkvm-mini-wireless"];

describe("SKU table", () => {
  it("registers both JetKVM variants first, then both Mini variants", () => {
    expect(KNOWN_SKUS).toEqual([...JETKVM_SKUS, ...MINI_SKUS]);
    expect(KNOWN_SKUS[0]).toBe(DEFAULT_SKU);
  });

  it("gives both JetKVM variants the same two over-the-air artifacts", () => {
    for (const sku of JETKVM_SKUS) {
      expect(otaArtifacts(sku)).toEqual([
        { kind: "app", prefix: "app", file: "jetkvm_app" },
        { kind: "system", prefix: "system", file: "system.tar" },
      ]);
    }
  });

  it("gives both Mini variants one over-the-air artifact, the firmware image as system", () => {
    for (const sku of MINI_SKUS) {
      expect(otaArtifacts(sku)).toEqual([
        { kind: "system", prefix: "mini", file: "jetkvm-mini.bin" },
      ]);
      expect(artifactFor(sku, "app")).toBeUndefined();
    }
  });

  it("keeps the JetKVM recovery image with the system artifact and gives the Mini none", () => {
    expect(artifactFor("jetkvm-v2", "recovery")).toEqual({
      prefix: "system",
      file: "update.img",
    });
    expect(artifactFor("jetkvm-v2-sdmmc", "recovery")).toEqual({
      prefix: "system",
      file: "update_sd.img.zip",
    });
    for (const sku of MINI_SKUS) {
      expect(artifactFor(sku, "recovery")).toBeUndefined();
    }
  });

  it("syncs three prefixes, each holding one over-the-air file", () => {
    expect(OTA_PREFIXES).toEqual(["app", "system", "mini"]);
    expect(otaFileForPrefix("app")).toBe("jetkvm_app");
    expect(otaFileForPrefix("system")).toBe("system.tar");
    expect(otaFileForPrefix("mini")).toBe("jetkvm-mini.bin");
  });

  it("lists the variants that consume each prefix", () => {
    expect(skusForPrefix("app")).toEqual(JETKVM_SKUS);
    expect(skusForPrefix("system")).toEqual(JETKVM_SKUS);
    expect(skusForPrefix("mini")).toEqual(MINI_SKUS);
  });

  it("only allows the original hardware on the pre-SKU layout, and no mini at all", () => {
    expect(legacyCompatibleSkus("app")).toEqual([DEFAULT_SKU]);
    expect(legacyCompatibleSkus("system")).toEqual([DEFAULT_SKU]);
    expect(legacyCompatibleSkus("mini")).toEqual([]);
  });

  it("rejects SKUs that are not registered, including prototype keys", () => {
    expect(isKnownSku("jetkvm-mini-lte")).toBe(false);
    expect(isKnownSku("__proto__")).toBe(false);
    expect(isKnownSku("constructor")).toBe(false);
    expect(() => artifactFor("jetkvm-mini-lte", "system")).toThrow(
      'Unknown SKU "jetkvm-mini-lte"',
    );
  });
});

describe("device-reported SKUs", () => {
  it("normalizes a reported SKU to a registered one or null", () => {
    expect(normalizeSku("jetkvm-mini-ethernet")).toBe("jetkvm-mini-ethernet");
    expect(normalizeSku("jetkvm-mini-lte")).toBeNull();
    expect(normalizeSku(["jetkvm-v2"])).toBeNull();
    expect(normalizeSku(undefined)).toBeNull();
    expect(normalizeSku("")).toBeNull();
    expect(normalizeSku("__proto__")).toBeNull();
  });

  it("treats a device without a stored SKU as the original hardware", () => {
    expect(effectiveSku(null)).toBe(DEFAULT_SKU);
    expect(effectiveSku(undefined)).toBe(DEFAULT_SKU);
    expect(effectiveSku("jetkvm-mini-ethernet")).toBe("jetkvm-mini-ethernet");
  });
});
