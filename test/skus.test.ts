import { describe, expect, it } from "vitest";

import {
  DEFAULT_SKU,
  KNOWN_SKUS,
  OTA_PREFIXES,
  artifactFor,
  isKnownSku,
  legacyCompatibleSkus,
  otaArtifacts,
  otaFileForPrefix,
  skusForPrefix,
} from "../src/skus";

const JETKVM_SKUS = ["jetkvm-v2", "jetkvm-v2-sdmmc"];

describe("SKU table", () => {
  it("registers the eMMC and SDMMC JetKVM variants, eMMC first as the default", () => {
    expect(KNOWN_SKUS).toEqual(JETKVM_SKUS);
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

  it("keeps the recovery image with the system artifact, named per variant", () => {
    expect(artifactFor("jetkvm-v2", "recovery")).toEqual({
      prefix: "system",
      file: "update.img",
    });
    expect(artifactFor("jetkvm-v2-sdmmc", "recovery")).toEqual({
      prefix: "system",
      file: "update_sd.img.zip",
    });
  });

  it("syncs the app and system prefixes, each holding one over-the-air file", () => {
    expect(OTA_PREFIXES).toEqual(["app", "system"]);
    expect(otaFileForPrefix("app")).toBe("jetkvm_app");
    expect(otaFileForPrefix("system")).toBe("system.tar");
    expect(() => otaFileForPrefix("nope")).toThrow('Prefix "nope" holds 0');
  });

  it("lists every JetKVM variant as a consumer of both prefixes", () => {
    expect(skusForPrefix("app")).toEqual(JETKVM_SKUS);
    expect(skusForPrefix("system")).toEqual(JETKVM_SKUS);
  });

  it("only allows the original hardware on the pre-SKU layout", () => {
    expect(legacyCompatibleSkus("app")).toEqual([DEFAULT_SKU]);
    expect(legacyCompatibleSkus("system")).toEqual([DEFAULT_SKU]);
    expect(legacyCompatibleSkus("nope")).toEqual([]);
  });

  it("rejects SKUs that are not registered, including prototype keys", () => {
    expect(isKnownSku("jetkvm-v3")).toBe(false);
    expect(isKnownSku("__proto__")).toBe(false);
    expect(isKnownSku("constructor")).toBe(false);
    expect(() => artifactFor("jetkvm-v3", "app")).toThrow('Unknown SKU "jetkvm-v3"');
  });
});
