/**
 * The release bucket the e2e API reads. Global setup uploads every artifact
 * with a `.sha256` sidecar (and a `.sig` where `sig` is set), as the release
 * scripts do, then registers each stable version through POST /releases/sync.
 */

export const CDN_BASE = "https://cdn.e2e.test";

interface FixtureArtifact {
  key: string;
  sig?: boolean;
}

export const ARTIFACTS: FixtureArtifact[] = [
  // App. 0.3.0 predates the skus/ layout, 0.5.0 has no SDMMC build.
  { key: "app/0.3.0/jetkvm_app" },
  { key: "app/0.4.0/skus/jetkvm-v2/jetkvm_app", sig: true },
  { key: "app/0.4.0/skus/jetkvm-v2-sdmmc/jetkvm_app" },
  { key: "app/0.5.0/skus/jetkvm-v2/jetkvm_app" },
  { key: "app/0.6.0-beta.1/skus/jetkvm-v2/jetkvm_app" },
  { key: "app/0.6.0-beta.1/skus/jetkvm-v2-sdmmc/jetkvm_app" },

  // System, with the recovery images that share its version.
  { key: "system/0.2.0/system.tar" },
  { key: "system/0.2.0/update.img" },
  { key: "system/0.3.0/skus/jetkvm-v2/system.tar" },
  { key: "system/0.3.0/skus/jetkvm-v2/update.img" },
  { key: "system/0.3.0/skus/jetkvm-v2-sdmmc/system.tar" },
  { key: "system/0.3.0/skus/jetkvm-v2-sdmmc/update_sd.img.zip" },
  { key: "system/0.4.0-rc.1/skus/jetkvm-v2/system.tar" },
  { key: "system/0.4.0-rc.1/skus/jetkvm-v2/update.img" },
  { key: "system/0.4.0-rc.1/skus/jetkvm-v2-sdmmc/system.tar" },
  { key: "system/0.4.0-rc.1/skus/jetkvm-v2-sdmmc/update_sd.img.zip" },

  // Mini. 0.4.0 uses the pre-SKU layout, which no Mini build may use.
  // 0.5.4 has no wireless build.
  { key: "mini/0.4.0/jetkvm-mini.bin" },
  { key: "mini/0.5.3/skus/jetkvm-mini-ethernet/jetkvm-mini.bin" },
  { key: "mini/0.5.3/skus/jetkvm-mini-ethernet/jetkvm-mini-full.bin" },
  { key: "mini/0.5.3/skus/jetkvm-mini-wireless/jetkvm-mini.bin" },
  { key: "mini/0.5.3/skus/jetkvm-mini-wireless/jetkvm-mini-full.bin" },
  { key: "mini/0.5.4/skus/jetkvm-mini-ethernet/jetkvm-mini.bin" },
  { key: "mini/0.5.4/skus/jetkvm-mini-ethernet/jetkvm-mini-full.bin" },
];

/** Objects that are not releases: a folder whose name is not a version. */
export const OTHER_OBJECTS = ["app/latest/README.txt"];

export function fixtureBody(key: string): Buffer {
  return Buffer.from(`e2e fixture ${key}\n`);
}

/** Every (type, version) folder with no prerelease tag, as the upload script would sync them. */
export function stableVersions(): { type: string; version: string }[] {
  const seen = new Map<string, { type: string; version: string }>();
  for (const { key } of ARTIFACTS) {
    const [type, version] = key.split("/");
    if (!version.includes("-")) seen.set(`${type}/${version}`, { type, version });
  }
  return [...seen.values()];
}

/**
 * Device IDs and their rollout bucket: parseInt(md5(id).slice(0, 8), 16) % 100.
 * The values are fixed so that a change to the bucketing, which would move
 * devices between rollout groups mid-rollout, fails the tests.
 */
export const DEVICE_IN_BUCKET = {
  0: "e2e-device-74",
  9: "e2e-device-167",
  49: "e2e-device-152",
  50: "e2e-device-28",
  81: "e2e-device-9",
  99: "e2e-device-19",
} as const;
