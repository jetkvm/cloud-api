/**
 * One row per hardware SKU: the artifacts a device with that SKU can get.
 *
 *   app       installed over the air, reported in the app* fields of /releases
 *   system    installed over the air, reported in the system* fields of /releases
 *   recovery  full image flashed by cable, served by /releases/system_recovery/latest
 *
 * Each value is `<prefix>/<file>`. The prefix is the R2 folder the artifact
 * lives under and the `Release.type` value in the database; artifacts that
 * are released together share a prefix and a version number. The full key
 * is `<prefix>/<version>/skus/<sku>/<file>` (+ .sha256, optional .sig).
 *
 * Keep this table in sync with the firmware build tooling
 * (rv1106-system/scripts/common.sh, kvm/Makefile APP_SKUS, the kvm-mini
 * release script). Unknown SKUs are rejected at the API boundary so a typo
 * can never fall back to firmware built for different hardware.
 */

export type OtaKind = "app" | "system";
export type ArtifactKind = OtaKind | "recovery";

export interface SkuArtifacts {
  app?: string;
  system?: string;
  recovery?: string;
  /**
   * Uploads made before the skus/ layout existed (`<prefix>/<version>/<file>`,
   * no skus/ folder) belong to this SKU.
   */
  legacyUploads?: boolean;
}

export const SKUS: Record<string, SkuArtifacts> = {
  // JetKVM (RV1106, Linux). The Go app and the system rootfs are released
  // separately, so they have separate prefixes and version numbers. The
  // recovery image is built with the rootfs and shares its version.
  // eMMC variant: flashed via DFU + the Rockchip upgrade tool (RKDevTool format).
  "jetkvm-v2": {
    app: "app/jetkvm_app",
    system: "system/system.tar",
    recovery: "system/update.img",
    legacyUploads: true,
  },
  // SDMMC variant: written to a microSD with balenaEtcher (dd-format zip).
  "jetkvm-v2-sdmmc": {
    app: "app/jetkvm_app",
    system: "system/system.tar",
    recovery: "system/update_sd.img.zip",
  },
  // JetKVM Mini (ESP32-P4). One firmware image is the whole system:
  // FreeRTOS, drivers, the application, the web UI and the ESP32-C5 Wi-Fi
  // co-processor firmware. There is no separate app. The Ethernet (IP101)
  // and wireless (ESP32-C5 over SDIO) boards are separate builds. The
  // recovery image is the merged full-flash binary (bootloader, partition
  // table, firmware in the first OTA slot, erased OTA selection data),
  // written with esptool or a browser flasher at offset 0.
  "jetkvm-mini-ethernet": {
    system: "mini/jetkvm-mini.bin",
    recovery: "mini/jetkvm-mini-full.bin",
  },
  "jetkvm-mini-wireless": {
    system: "mini/jetkvm-mini.bin",
    recovery: "mini/jetkvm-mini-full.bin",
  },
};

export const DEFAULT_SKU = "jetkvm-v2";
export const KNOWN_SKUS: readonly string[] = Object.keys(SKUS);
export const OTA_KINDS: readonly OtaKind[] = ["app", "system"];

export function isKnownSku(sku: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKUS, sku);
}

export interface Artifact {
  prefix: string;
  file: string;
}

export interface OtaArtifact extends Artifact {
  kind: OtaKind;
}

function parseArtifact(value: string): Artifact {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Artifact "${value}" must be <prefix>/<file>`);
  }
  return { prefix: value.slice(0, slash), file: value.slice(slash + 1) };
}

/** The artifact of one kind for a SKU, or undefined when the SKU has none. */
export function artifactFor(sku: string, kind: ArtifactKind): Artifact | undefined {
  const row = SKUS[sku];
  if (!row) {
    throw new Error(`Unknown SKU "${sku}"`);
  }
  const value = row[kind];
  return value ? parseArtifact(value) : undefined;
}

/** The over-the-air artifacts of a SKU: app, then system, whichever exist. */
export function otaArtifacts(sku: string): OtaArtifact[] {
  return OTA_KINDS.flatMap(kind => {
    const artifact = artifactFor(sku, kind);
    return artifact ? [{ kind, ...artifact }] : [];
  });
}

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const OTA_ROWS = KNOWN_SKUS.flatMap(sku => otaArtifacts(sku).map(artifact => ({ sku, ...artifact })));

/** Every prefix that holds over-the-air artifacts, in table order. */
export const OTA_PREFIXES: readonly string[] = unique(OTA_ROWS.map(row => row.prefix));

/** File name of the over-the-air artifact stored under a prefix. */
export function otaFileForPrefix(prefix: string): string {
  const files = unique(OTA_ROWS.filter(row => row.prefix === prefix).map(row => row.file));
  if (files.length !== 1) {
    throw new Error(`Prefix "${prefix}" holds ${files.length} over-the-air files, expected one`);
  }
  return files[0];
}

/** SKUs that receive the over-the-air artifact stored under a prefix. */
export function skusForPrefix(prefix: string): string[] {
  return unique(OTA_ROWS.filter(row => row.prefix === prefix).map(row => row.sku));
}

/**
 * SKUs that may consume a pre-SKU upload (`<prefix>/<version>/<file>` with
 * no skus/ folder) under a prefix. Every other SKU requires an explicit
 * `skus/<sku>/` upload.
 */
export function legacyCompatibleSkus(prefix: string): string[] {
  return skusForPrefix(prefix).filter(sku => SKUS[sku].legacyUploads);
}
