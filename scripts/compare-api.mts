/**
 * Sends the same requests to two API deployments and reports where the
 * answers differ, grouped by cause.
 *
 *   npm run compare -- --candidate <url|local|staging> [options]
 *
 * Only safe requests are sent: GETs, CORS preflights, and POSTs that the
 * API must reject before any handler runs.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const ALIASES: Record<string, string> = {
  local: "http://localhost:3000",
  staging: "https://staging-api.jetkvm.com",
  production: "https://api.jetkvm.com",
};

const SKUS = [
  "jetkvm-v2",
  "jetkvm-v2-sdmmc",
  "jetkvm-mini-ethernet",
  "jetkvm-mini-wireless",
];
const MINI_SKUS = new Set(["jetkvm-mini-ethernet", "jetkvm-mini-wireless"]);
const AREAS = ["releases", "redirects", "auth", "http", "replay"] as const;
type Area = (typeof AREAS)[number];

const COMPARED_HEADERS = [
  "content-type",
  "location",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "x-content-type-options",
  "x-frame-options",
  "strict-transport-security",
  "x-powered-by",
];

const USAGE = `Usage: npm run compare -- --candidate <url|local|staging> [options]

  --candidate <url>     API under test (local = ${ALIASES.local}, staging = ${ALIASES.staging})
  --reference <url>     API to compare against (default ${ALIASES.production})
  --only <areas>        Comma-separated: ${AREAS.join(", ")} (default: all but replay)
  --sku <sku>           Only this SKU; repeat for more (default: ${SKUS.join(", ")})
  --device <id>         Add a device ID; repeat for more (default: one per 5% rollout bucket)
  --requests <file>     Also replay these GET paths, one per line (# starts a comment)
  --json <file>         Write every request and its result to this file
  --concurrency <n>     Requests in flight per API (default 8)
  --examples <n>        Examples shown per group (default 3)
`;

interface Probe {
  area: Area;
  /** Requests of one kind share a label; differences are grouped by it. */
  label: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Pinned requests do not depend on the rollout table. */
  rolloutDependent?: boolean;
}

interface Answer {
  status: number | string;
  headers: Record<string, string>;
  body: unknown;
}

interface Difference {
  field: string;
  reference: unknown;
  candidate: unknown;
}

// ---------------------------------------------------------------- arguments

const { values: args } = parseArgs({
  options: {
    candidate: { type: "string" },
    reference: { type: "string", default: ALIASES.production },
    only: { type: "string" },
    sku: { type: "string", multiple: true },
    device: { type: "string", multiple: true },
    requests: { type: "string" },
    json: { type: "string" },
    concurrency: { type: "string", default: "8" },
    examples: { type: "string", default: "3" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help || !args.candidate) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}

const resolveTarget = (value: string) => (ALIASES[value] ?? value).replace(/\/+$/, "");
const candidate = resolveTarget(args.candidate);
const reference = resolveTarget(args.reference!);

const areas = new Set<Area>(
  args.only
    ? args.only.split(",").map(area => {
        if (!AREAS.includes(area as Area))
          fail(`Unknown area "${area}". Areas: ${AREAS.join(", ")}`);
        return area as Area;
      })
    : AREAS.filter(area => area !== "replay"),
);
if (args.requests) areas.add("replay");

const skus = args.sku?.length ? args.sku : SKUS;
const concurrency = Number(args.concurrency);
const exampleCount = Number(args.examples);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------- HTTP

async function send(base: string, probe: Probe): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(base + probe.path, {
        method: probe.method,
        headers: probe.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (response.status >= 500 && attempt < 2)
        throw new Error(`HTTP ${response.status}`);

      const headers: Record<string, string> = {};
      for (const name of COMPARED_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: response.status, headers, body };
    } catch (error) {
      if (attempt >= 2)
        return { status: `error: ${(error as Error).message}`, headers: {}, body: null };
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function pool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------- requests

/** One device ID per 5% rollout bucket, plus bucket 99, using the API's bucketing (md5 % 100). */
function devicesAcrossBuckets(): string[] {
  const bucket = (id: string) =>
    parseInt(createHash("md5").update(id).digest("hex").slice(0, 8), 16) % 100;
  const wanted = new Set([...Array.from({ length: 20 }, (_, i) => i * 5), 99]);
  const ids: string[] = [];
  for (let n = 0; wanted.size > 0 && n < 100_000; n++) {
    const id = `compare-device-${n}`;
    if (wanted.delete(bucket(id))) ids.push(id);
  }
  return ids;
}

const query = (params: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();

/**
 * Every registered version of one kind, newest first, as the reference API
 * reports it: pinned requests ignore the rollout, so "<x" walks down the list.
 */
async function discoverVersions(sku: string, kind: "app" | "system"): Promise<string[]> {
  const versions: string[] = [];
  // ">=0.0.0" would normalize to "*", which the API treats as not pinned
  let range = "<999999.0.0";
  for (let i = 0; i < 200; i++) {
    const answer = await send(reference, {
      area: "releases",
      label: "discovery",
      method: "GET",
      path: `/releases?${query({ deviceId: "compare-discovery", sku, [`${kind}Version`]: range })}`,
    });
    const version = (answer.body as Record<string, string> | null)?.[`${kind}Version`];
    if (answer.status !== 200 || !version || versions.includes(version)) break;
    versions.push(version);
    range = `<${version}`;
  }
  return versions;
}

async function releaseProbes(devices: string[]): Promise<Probe[]> {
  const probes: Probe[] = [];
  const add = (
    label: string,
    params: Record<string, string | undefined>,
    rolloutDependent = false,
  ) =>
    probes.push({
      area: "releases",
      label,
      method: "GET",
      path: `/releases?${query(params)}`,
      rolloutDependent,
    });

  // One request at a time per chain, the chains side by side
  const chains = skus.flatMap(sku =>
    (MINI_SKUS.has(sku) ? (["system"] as const) : (["app", "system"] as const)).map(
      kind => ({ sku, kind }),
    ),
  );
  const discovered = await Promise.all(
    chains.map(async chain => ({
      ...chain,
      versions: await discoverVersions(chain.sku, chain.kind),
    })),
  );

  // A chain stops at a version with no build for its SKU, so every SKU of a
  // release type is probed with the versions any of its SKUs found.
  const releaseType = (sku: string, kind: string) => (MINI_SKUS.has(sku) ? "mini" : kind);
  const versionsByType = new Map<string, Set<string>>();
  for (const { sku, kind, versions } of discovered) {
    const type = releaseType(sku, kind);
    versionsByType.set(type, new Set([...(versionsByType.get(type) ?? []), ...versions]));
  }

  for (const sku of skus) {
    for (const deviceId of devices) add(`stable ${sku}`, { deviceId, sku }, true);
    add(`prerelease ${sku}`, { deviceId: devices[0], sku, prerelease: "true" });

    for (const { kind } of chains.filter(chain => chain.sku === sku)) {
      for (const version of versionsByType.get(releaseType(sku, kind)) ?? []) {
        add(`pinned ${kind} ${sku}`, {
          deviceId: devices[0],
          sku,
          [`${kind}Version`]: version,
        });
        add(`pinned ${kind} range ${sku}`, {
          deviceId: devices[0],
          sku,
          [`${kind}Version`]: `<${version}`,
        });
      }
    }
  }

  add("no SKU", { deviceId: devices[0] }, true);
  add("invalid request", {});
  add("invalid request", { deviceId: "" });
  add("invalid request", { deviceId: devices[0], sku: "jetkvm-unknown" });
  add("invalid request", {
    deviceId: devices[0],
    appVersion: "9999.0.0",
    systemVersion: "9999.0.0",
  });
  return probes;
}

function redirectProbes(): Probe[] {
  const probes: Probe[] = [];
  for (const path of ["/releases/app/latest", "/releases/system_recovery/latest"]) {
    for (const sku of skus) {
      for (const prerelease of [undefined, "true"]) {
        probes.push({
          area: "redirects",
          label: path,
          method: "GET",
          path: `${path}?${query({ sku, prerelease })}`,
        });
      }
    }
  }
  return probes;
}

function authProbes(): Probe[] {
  const routes: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/devices"],
    ["GET", "/devices/compare-device"],
    ["PUT", "/devices/compare-device"],
    ["POST", "/webrtc/session"],
    ["POST", "/webrtc/ice_config"],
    ["POST", "/webrtc/turn_activity"],
    ["POST", "/releases/sync"],
  ];
  return routes.map(([method, path]) => ({
    area: "auth",
    label: `${method} ${path}`,
    method,
    path,
  }));
}

function httpProbes(): Probe[] {
  return [
    { area: "http", label: "root", method: "GET", path: "/" },
    { area: "http", label: "health", method: "GET", path: "/healthz" },
    {
      area: "http",
      label: "unknown route",
      method: "GET",
      path: "/compare-does-not-exist",
    },
    {
      area: "http",
      label: "CORS from another origin",
      method: "OPTIONS",
      path: "/devices",
      headers: {
        origin: "https://compare.invalid",
        "access-control-request-method": "GET",
      },
    },
  ];
}

function replayProbes(file: string): Probe[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(path => ({
      area: "replay" as const,
      label: path.split("?")[0],
      method: "GET",
      path,
      rolloutDependent: true,
    }));
}

// ---------------------------------------------------------------- comparison

/** Values that differ on every call. */
function normalize(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { time: _time, ...rest } = body as Record<string, unknown>;
    return rest;
  }
  return body;
}

function differences(ref: Answer, cand: Answer): Difference[] {
  const found: Difference[] = [];
  const walk = (field: string, a: unknown, b: unknown) => {
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort()) {
        walk(field ? `${field}.${key}` : key, (a as any)[key], (b as any)[key]);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      found.push({ field, reference: a, candidate: b });
    }
  };
  walk("status", ref.status, cand.status);
  walk("header", ref.headers, cand.headers);
  walk("body", normalize(ref.body), normalize(cand.body));
  return found;
}

// ---------------------------------------------------------------- report

const show = (value: unknown) =>
  value === undefined ? "(absent)" : JSON.stringify(value);

async function main() {
  console.log(`Reference  ${reference}`);
  console.log(`Candidate  ${candidate}\n`);

  const healthProbe: Probe = {
    area: "http",
    label: "health",
    method: "GET",
    path: "/healthz",
  };
  const health = await Promise.all(
    [reference, candidate].map(base => send(base, healthProbe)),
  );
  for (const [i, base] of [reference, candidate].entries()) {
    if (health[i].status !== 200)
      fail(`${base}/healthz answered ${health[i].status}; stopping.`);
  }

  const devices = [...devicesAcrossBuckets(), ...(args.device ?? [])];
  const probes: Probe[] = [];
  if (areas.has("releases")) probes.push(...(await releaseProbes(devices)));
  if (areas.has("redirects")) probes.push(...redirectProbes());
  if (areas.has("auth")) probes.push(...authProbes());
  if (areas.has("http")) probes.push(...httpProbes());
  if (areas.has("replay") && args.requests) probes.push(...replayProbes(args.requests));

  let done = 0;
  const results = await pool(probes, concurrency, async probe => {
    const [ref, cand] = await Promise.all([
      send(reference, probe),
      send(candidate, probe),
    ]);
    if (++done % 25 === 0 || done === probes.length) {
      process.stderr.write(`\r${done}/${probes.length} requests`);
    }
    return {
      probe,
      reference: ref,
      candidate: cand,
      differences: differences(ref, cand),
    };
  });
  process.stderr.write("\n\n");

  // Group by area, label and field, so one cause shows once however many requests it touches
  const groups = new Map<
    string,
    { area: Area; label: string; field: string; members: typeof results }
  >();
  for (const result of results) {
    for (const { field } of result.differences) {
      const { area, label } = result.probe;
      const key = JSON.stringify([area, label, field]);
      if (!groups.has(key)) groups.set(key, { area, label, field, members: [] });
      groups.get(key)!.members.push(result);
    }
  }

  // In a terminal, each group of differences must be acknowledged as expected by the person
  // running the compare. Nothing is remembered between runs.
  const prompt = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const sorted = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  const acknowledged: { area: Area; label: string; field: string; expected: boolean }[] =
    [];
  for (const [index, { area, label, field, members }] of sorted.entries()) {
    console.log(
      `✗ [${index + 1}/${sorted.length}] ${area}: ${label}: ${field}  (${members.length} request${members.length === 1 ? "" : "s"})`,
    );
    for (const member of members.slice(0, exampleCount)) {
      const difference = member.differences.find(d => d.field === field)!;
      console.log(`    ${member.probe.method} ${member.probe.path}`);
      console.log(`      reference ${show(difference.reference)}`);
      console.log(`      candidate ${show(difference.candidate)}`);
    }
    if (prompt) {
      // End of input (Ctrl+D) counts as "no"
      const answer = await prompt
        .question("  Is this difference expected? [y/N] ")
        .catch(() => "");
      acknowledged.push({
        area,
        label,
        field,
        expected: /^y(es)?$/i.test(answer.trim()),
      });
    }
    console.log();
  }
  prompt?.close();

  const differing = results.filter(result => result.differences.length > 0);
  for (const area of areas) {
    const inArea = results.filter(result => result.probe.area === area);
    if (inArea.length === 0) continue;
    const bad = inArea.filter(result => result.differences.length > 0).length;
    console.log(
      `${bad === 0 ? "✓" : "✗"} ${area.padEnd(10)} ${inArea.length - bad}/${inArea.length} identical`,
    );
  }

  if (differing.length > 0 && differing.every(result => result.probe.rolloutDependent)) {
    console.log(
      "\nEvery difference is in a request that depends on the rollout table, and every pinned request matches.\n" +
        "The rollout percentages in the two databases probably differ.",
    );
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ reference, candidate, acknowledged, results }, null, 2),
    );
    console.log(`\nFull results: ${args.json}`);
  }

  if (differing.length === 0) {
    console.log("\nNo differences");
    process.exit(0);
  }
  console.log(`\n${differing.length} of ${results.length} requests differ`);
  if (!prompt) {
    console.log("Run in a terminal to review each group of differences.");
    process.exit(1);
  }
  const unexpected = acknowledged.filter(group => !group.expected).length;
  console.log(
    unexpected === 0
      ? `You marked all ${sorted.length} groups of differences as expected`
      : `${unexpected} of ${sorted.length} groups of differences are not marked as expected`,
  );
  process.exit(unexpected === 0 ? 0 : 1);
}

await main();
