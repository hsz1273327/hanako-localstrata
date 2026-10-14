// lib/deployer/common.js
//
// Pure / shared helpers used by BOTH deployers (source + docker). Nothing in
// here knows how Strata is launched; the deployer implementations own that.
//
// This file is the "one copy" of the helpers the design doc calls out as
// reusable (flatConfig, rawSamplingValues, applyTextEdit, parseMetrics,
// isLanExposedAddr, generateApiKey, …). The source implementation and the
// docker implementation both import from here so the two never drift.
import * as fs from "../fsx.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { processCommandLine, isStrataCommandLine } from "../process.js";

export const DEFAULTS = {
  strataDir: "",
  pythonPath: "",
  // Optional config-file override. Discovered from {strataDir}/strata-*.json;
  // empty means "auto": use the newest existing config, or generate one with
  // setup.py on first launch. It is never typed by hand.
  configFile: "",
  // Model folder holding the GGUF shards (1.1.0 first-run path).
  //   local  → passed to `setup.py --setup --gguf-dir <ggufDir>`
  //   docker → bind-mounted at /gguf and exported as GGUF_DIR=/gguf
  // Empty means setup.py downloads the model (or uses its data folder).
  ggufDir: "",
  // Optional override. 0 / empty means "use the deployment's own port".
  port: 0,
  autoStart: false,
  refreshSec: 5,
  apiKey: "",
  // ── 1.1.0 deploy layer (see v1.1-TASK.md / strata-docker-design.md) ──
  // "" = the user has not chosen yet. It is detected ONCE from the image
  // list and then persisted; after that only an explicit choice is honoured.
  // There is no `auto` and no automatic switching.
  deployMode: "", // "" | local | docker
  containerName: "strata",
  imageName: "strata", // image the updater rebuilds / the user names in the UI
  imageNames: ["strata"], // detection anchors (v1.1.0 default: ["strata"])
  volumeName: "strata-data", // host volume (or bind) mounted at /data
  dockerStopTimeoutSec: 60,
  dockerRunConfig: "", // internal: sampled `docker run` params (JSON) for rebuilds
};

// Last-resort port when neither the plugin override nor the deployment
// provides one. Kept separate from DEFAULTS.port, which means "no override".
export const FALLBACK_PORT = 8080;

export const STATUS_URL = (port) => `http://127.0.0.1:${port}/v1/status`;
export const WEB_URL = (port) => `http://127.0.0.1:${port}/`;

// The v2 AppHost sandbox denies bare `fetch` (even to loopback). The
// manifest-gated host network door is the only way out; fall back to global
// fetch for unit tests and v1-style hosts.
export function netFetch(ctx, url, init) {
  return ctx?.network?.fetch ? ctx.network.fetch(url, init) : fetch(url, init);
}

// ── Plugin config ─────────────────────────────────────────────────────────

export async function readConfig(ctx, key) {
  try {
    const value = await ctx?.config?.get?.(key);
    if (value !== undefined && value !== null && value !== "") return value;
  } catch {
    /* fall through to default */
  }
  return DEFAULTS[key];
}

export async function readAllConfig(ctx) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = await readConfig(ctx, key);
  out.port = toNum(out.port) ?? 0;
  out.refreshSec = Math.max(1, Number(out.refreshSec) || DEFAULTS.refreshSec);
  out.dockerStopTimeoutSec = Math.max(
    1,
    Number(out.dockerStopTimeoutSec) || DEFAULTS.dockerStopTimeoutSec,
  );
  out.containerName = String(out.containerName || DEFAULTS.containerName);
  out.imageName = String(out.imageName || DEFAULTS.imageName);
  out.ggufDir = String(out.ggufDir || "").trim();
  out.deployMode = ["local", "docker"].includes(out.deployMode) ? out.deployMode : "";
  out.imageNames = normalizeImageNames(out.imageNames, out.imageName);
  out.volumeName = String(out.volumeName || DEFAULTS.volumeName);
  return out;
}

// The image list the first-run detection checks. `imageNames` is the canonical
// setting; `imageName` (the user-facing UI field) is folded in so editing one
// field can never make detection miss the image the updater would rebuild.
export function normalizeImageNames(imageNames, imageName) {
  const list = [];
  const push = (v) => {
    const s = String(v ?? "").trim();
    if (s && !list.includes(s)) list.push(s);
  };
  if (Array.isArray(imageNames)) imageNames.forEach(push);
  else if (typeof imageNames === "string") imageNames.split(",").forEach(push);
  push(imageName);
  return list.length ? list : [...DEFAULTS.imageNames];
}

export function detectionImageNames(cfg) {
  return normalizeImageNames(cfg?.imageNames, cfg?.imageName);
}

// Persists a partial plugin-config patch. Only known keys are written so a
// stray request field can never create a new setting.
export async function savePluginConfig(ctx, patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key in DEFAULTS) clean[key] = value;
  }
  if (typeof ctx?.config?.setMany === "function") {
    await ctx.config.setMany(clean);
  } else {
    for (const [key, value] of Object.entries(clean)) {
      await ctx?.config?.set?.(key, value);
    }
  }
  return clean;
}

// ── Cross-deployer runtime cache ──────────────────────────────────────────
//
// routes/requests.js and routes/update.js call resolvePort(cfg) /
// resolveApiKey(cfg) with only the plugin config in hand — no ctx, no
// container handle. The gateway is required to stay untouched, so the docker
// deployer records the port/key it discovered here and those helpers consult
// the cache when the last detection said "docker". Same idea as the existing
// versionCache: a process-local memo, never a second source of truth.
const dockerRuntime = { containerName: null, port: null, apiKey: null };

export function rememberDockerRuntime(containerName, { port, apiKey } = {}) {
  dockerRuntime.containerName = containerName || null;
  if (port !== undefined) dockerRuntime.port = port;
  if (apiKey !== undefined) dockerRuntime.apiKey = apiKey;
}

function dockerRuntimeFor(containerName) {
  if (!dockerRuntime.containerName) return null;
  if (containerName && containerName !== dockerRuntime.containerName) return null;
  return dockerRuntime;
}

// ── Process helpers ───────────────────────────────────────────────────────

function isStrataProcess(pid, platform = process.platform) {
  return isStrataCommandLine(processCommandLine(pid, platform));
}

export function pidFilePath(cfg) {
  return path.join(cfg.strataDir, ".hanako-localstrata.pid");
}

export function readPidFile(cfg) {
  try {
    const n = Number(fs.readFileSync(pidFilePath(cfg), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writePidFile(cfg, pid) {
  try {
    fs.writeFileSync(pidFilePath(cfg), String(pid));
  } catch {
    /* best effort */
  }
}

export function clearPidFile(cfg) {
  try {
    fs.rmSync(pidFilePath(cfg), { force: true });
  } catch {
    /* best effort */
  }
}

export { isStrataProcess };

// ── Resource usage (host) ─────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function readGpu() {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    const nums = out.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    const usedMiB = Number(nums[0]);
    const totalMiB = Number(nums[1]);
    if (!Number.isFinite(usedMiB) || !Number.isFinite(totalMiB) || totalMiB <= 0) return null;
    return {
      usedMiB,
      totalMiB,
      usedGiB: round1(usedMiB / 1024),
      totalGiB: round1(totalMiB / 1024),
    };
  } catch {
    return null;
  }
}

export function readMem(platform = process.platform) {
  if (platform === "win32") {
    // UNTESTED on Windows. os.freemem() is the closest cross-platform analogue
    // to Linux's MemAvailable (Windows has no MemAvailable counter).
    try {
      const total = os.totalmem();
      const free = os.freemem();
      if (!Number.isFinite(total) || total <= 0) return null;
      const used = Math.max(0, total - free);
      return {
        usedGiB: round1(used / 1024 ** 3),
        totalGiB: round1(total / 1024 ** 3),
      };
    } catch {
      return null;
    }
  }
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const pick = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? Number(m[1]) : NaN;
    };
    const totalKb = pick("MemTotal");
    const availableKb = pick("MemAvailable");
    if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return null;
    const usedKb = Math.max(0, totalKb - availableKb);
    return {
      usedGiB: round1(usedKb / 1024 / 1024),
      totalGiB: round1(totalKb / 1024 / 1024),
    };
  } catch {
    return null;
  }
}

export function readResources(platform = process.platform) {
  return { gpu: readGpu(), mem: readMem(platform) };
}

// ── JSON / config text helpers ────────────────────────────────────────────

export function parseJsonText(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function mainConfigPath(cfg) {
  return path.resolve(cfg.strataDir, cfg.configFile);
}

export function sharedConfigPath(cfg) {
  return mainConfigPath(cfg).replace(/\.json$/, "") + ".shared-settings.json";
}

// Config discovery: every strata-*.json except backups and the sibling
// shared-settings file (which sits next to a chosen config).
export function listConfigFiles(strataDir) {
  try {
    return fs
      .readdirSync(strataDir)
      .filter((f) => /^strata-.*\.json$/.test(f))
      .filter((f) => !f.includes(".bak-") && !f.endsWith(".shared-settings.json"))
      .sort();
  } catch {
    return [];
  }
}

function quantFromFile(file) {
  const m = /^strata-(.+)\.json$/.exec(file);
  return m ? m[1].toUpperCase() : null;
}

export function describeConfigFile(strataDir, file) {
  const data = readJson(path.join(strataDir, file));
  return {
    file,
    quant: quantFromFile(file),
    context: toNum(argsValue(data?.args, "--max-context")),
    modelName: typeof data?.model_name === "string" ? data.model_name : null,
  };
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Auto-selection when the config-file override is empty: the newest existing
// config wins. setup.py touches the most recently used config on every start,
// so mtime is the "last used" signal; ties fall back to the file name.
export function pickConfigFile(strataDir, candidates) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (!list.length) return "";
  list.sort((a, b) => {
    const diff = mtimeMs(path.join(strataDir, b.file)) - mtimeMs(path.join(strataDir, a.file));
    if (diff) return diff;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return list[0].file;
}

export function pluginPort(cfg) {
  const n = toNum(cfg?.port);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function configFilePort(cfg) {
  const main = readJson(mainConfigPath(cfg));
  const n = toNum(main?.port);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Effective port, source shape: plugin override → selected config file → 8080.
// The docker deployer overrides the middle step via the runtime cache.
export function resolvePort(cfg) {
  const override = pluginPort(cfg);
  if (override) return override;
  if (String(cfg?.deployMode) === "docker") {
    const rt = dockerRuntimeFor(cfg?.containerName);
    if (rt && Number.isInteger(rt.port) && rt.port > 0) return rt.port;
  }
  return configFilePort(cfg) ?? FALLBACK_PORT;
}

export function argsValue(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function toNum(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Canonical flat view over the two config files. Used for display and diff.
export function flatConfig(main, shared) {
  const sampling = (main && typeof main.sampling === "object" && main.sampling) || {};
  return {
    context: toNum(argsValue(main?.args, "--max-context")),
    kv: argsValue(main?.args, "--kv"),
    sessionCache: toNum(argsValue(main?.args, "--conversation-cache-mib")),
    mtp: toNum(argsValue(main?.args, "--spec")),
    port: toNum(main?.port),
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    min_p: sampling.min_p,
    presence_penalty: sampling.presence_penalty,
    max_tokens: toNum(shared?.max_tokens),
    reasoning_effort: shared?.reasoning_effort,
  };
}

// Raw string values from the sampling block, so the read-only display keeps
// the original formatting (e.g. `1.0` instead of JSON-parsed `1`).
export function rawSamplingValues(mainText) {
  const out = {};
  for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty"]) {
    const m = mainText.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`));
    if (m) out[key] = m[1];
  }
  return out;
}

// Summary derived from parsed config objects — shared by the source (files)
// and docker (exec'd text) readers.
export function buildConfigSummary(main, shared) {
  const flat = flatConfig(main, shared);
  return {
    context: flat.context,
    kv: flat.kv,
    sessionCache: flat.sessionCache,
    mtp: flat.mtp,
    port: flat.port,
    reasoningEffort: flat.reasoning_effort,
    maxTokens: flat.max_tokens,
  };
}

export function readConfigSummary(cfg) {
  const mainName = path.basename(cfg.configFile);
  const sharedName = mainName.replace(/\.json$/, "") + ".shared-settings.json";
  const main = readJson(path.resolve(cfg.strataDir, cfg.configFile));
  const shared = readJson(path.resolve(cfg.strataDir, sharedName));
  return buildConfigSummary(main, shared);
}

export function configSummaryFromText(mainText, sharedText) {
  return buildConfigSummary(parseJsonText(mainText), parseJsonText(sharedText));
}

// Canonical config view. Both deployers feed raw text in and get the exact
// shape the existing `getConfigView` produced.
export function buildConfigView({ configFile, mainName, sharedName, mainText, sharedText }) {
  const main = parseJsonText(mainText);
  const shared = parseJsonText(sharedText);
  const selected = !!configFile && mainText !== null && mainText !== undefined;
  const rawSmp = mainText ? rawSamplingValues(mainText) : {};
  const flat = flatConfig(main, shared);
  const sampling = (main && typeof main.sampling === "object" && main.sampling) || {};

  return {
    hasConfig: selected,
    configFile: configFile || null,
    files: { main: mainName || "", shared: sharedName || "" },
    errors: {
      main: main ? null : `无法读取 ${mainName}`,
      shared: shared ? null : `无法读取 ${sharedName}`,
    },
    effective: {
      context: { value: flat.context, source: mainName },
      kv: { value: flat.kv, source: mainName },
      sessionCache: { value: flat.sessionCache, unit: "MB", source: mainName },
      mtp: { value: flat.mtp, source: mainName },
      port: { value: flat.port, source: mainName },
      sampling: {
        temperature: rawSmp.temperature ?? sampling.temperature,
        top_p: rawSmp.top_p ?? sampling.top_p,
        top_k: rawSmp.top_k ?? sampling.top_k,
        min_p: rawSmp.min_p ?? sampling.min_p,
        presence_penalty: rawSmp.presence_penalty ?? sampling.presence_penalty,
        source: mainName,
      },
      maxTokens: { value: flat.max_tokens, source: sharedName },
      reasoningEffort: { value: flat.reasoning_effort, source: sharedName },
    },
    values: flat,
  };
}

// ── Config edits (shared text surgery) ────────────────────────────────────

export const EDIT_KEYS = {
  context: { kind: "number", restart: true },
  kv: { kind: "string", restart: true },
  sessionCache: { kind: "number", restart: true },
  mtp: { kind: "number", restart: true },
  port: { kind: "number", restart: true },
  temperature: { kind: "number", restart: true },
  top_p: { kind: "number", restart: true },
  top_k: { kind: "number", restart: true },
  min_p: { kind: "number", restart: true },
  presence_penalty: { kind: "number", restart: true },
  max_tokens: { kind: "number", restart: false },
  reasoning_effort: { kind: "string", restart: false },
};

// Docker cannot change the container's published port from the config file
// (the port mapping is fixed at container creation, and the entrypoint always
// passes `--port "$PORT"`). `port` is therefore read-only there.
export const DOCKER_EDIT_KEYS = (() => {
  const keys = {};
  for (const [k, v] of Object.entries(EDIT_KEYS)) if (k !== "port") keys[k] = v;
  return keys;
})();

export const REASONING_EFFORTS = ["off", "low", "medium", "xhigh"];
export const KV_VALUES = ["int8", "q4_0", "k8v4"];

export function validateEdits(edits, keys = EDIT_KEYS) {
  const clean = {};
  const errors = [];
  for (const [key, raw] of Object.entries(edits || {})) {
    const spec = keys[key];
    if (!spec) {
      errors.push(`未知字段: ${key}`);
      continue;
    }
    if (spec.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push(`${key} 需要数字`);
        continue;
      }
      clean[key] = n;
    } else {
      const s = String(raw);
      if (key === "reasoning_effort" && !REASONING_EFFORTS.includes(s)) {
        errors.push(`思考档位必须是 ${REASONING_EFFORTS.join("/")}`);
        continue;
      }
      if (key === "kv" && !KV_VALUES.includes(s)) {
        errors.push(`KV 量化必须是 ${KV_VALUES.join("/")}`);
        continue;
      }
      clean[key] = s;
    }
  }
  return { clean, errors };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Surgical JSON text edit: only the target field value is rewritten, so the
// rest of the file (including number formatting like 1.0) is left untouched.
export function applyTextEdit(text, op) {
  const key = escapeRegExp(op.key);
  if (op.type === "arg") {
    const re = new RegExp(`("${key}"\\s*,\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    const next = text.replace(re, `$1"${op.value}"`);
    if (next === text) throw new Error(`配置中找不到参数 ${op.key}`);
    return next;
  }
  const reStr = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (reStr.test(text)) return text.replace(reStr, `$1"${op.value}"`);
  const reNum = new RegExp(`("${key}"\\s*:\\s*)-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`);
  const next = text.replace(reNum, `$1${op.value}`);
  if (next === text) throw new Error(`配置中找不到字段 ${op.key}`);
  return next;
}

// Maps a validated edit set onto the main/shared JSON texts. Shared by both
// deployers; only the eventual write target (file vs. container) differs.
export function renderConfigEdits({ clean, before, mainText, sharedText, keys = EDIT_KEYS }) {
  const diff = [];
  for (const key of Object.keys(keys)) {
    if (!(key in clean)) continue;
    if (String(before[key] ?? "") !== String(clean[key] ?? "")) {
      diff.push({ key, old: before[key] ?? null, new: clean[key] });
    }
  }
  if (!diff.length) {
    return { diff: [], mainOps: [], sharedOps: [], newMainText: mainText, newSharedText: sharedText };
  }

  const mainOps = [];
  const sharedOps = [];
  if ("context" in clean) mainOps.push({ type: "arg", key: "--max-context", value: String(clean.context) });
  if ("kv" in clean) mainOps.push({ type: "arg", key: "--kv", value: clean.kv });
  if ("sessionCache" in clean) mainOps.push({ type: "arg", key: "--conversation-cache-mib", value: String(clean.sessionCache) });
  if ("mtp" in clean) mainOps.push({ type: "arg", key: "--spec", value: String(clean.mtp) });
  if ("port" in clean) mainOps.push({ type: "num", key: "port", value: clean.port });
  for (const k of ["temperature", "top_p", "top_k", "min_p", "presence_penalty"]) {
    if (k in clean) mainOps.push({ type: "num", key: k, value: clean[k] });
  }
  if ("max_tokens" in clean) sharedOps.push({ type: "num", key: "max_tokens", value: clean.max_tokens });
  if ("reasoning_effort" in clean) sharedOps.push({ type: "str", key: "reasoning_effort", value: clean.reasoning_effort });

  let newMainText = mainText;
  let newSharedText = sharedText;
  for (const op of mainOps) newMainText = applyTextEdit(newMainText, op);
  for (const op of sharedOps) newSharedText = applyTextEdit(newSharedText, op);

  try {
    JSON.parse(newMainText);
    JSON.parse(newSharedText);
  } catch (e) {
    throw new Error(`编辑结果不是合法 JSON，已中止保存: ${e.message}`);
  }

  const restartRequired = diff.some((d) => keys[d.key]?.restart);
  return { diff, mainOps, sharedOps, newMainText, newSharedText, restartRequired };
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Logs & speed metrics (deployment agnostic) ────────────────────────────

export function avgLast(values, n = 3) {
  if (!values.length) return null;
  const slice = values.slice(-n);
  const sum = slice.reduce((a, b) => a + b, 0);
  return Math.round((sum / slice.length) * 10) / 10;
}

export function parseMetrics(text) {
  const pp = [...text.matchAll(/read in \d+ ms \(([\d.]+) tok\/s\)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const tg = [...text.matchAll(/generated in \d+ ms \(([\d.]+) tok\/s\)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const expert = [...text.matchAll(/expert cache hit rate: ([\d.]+)%/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const kv = [...text.matchAll(/KV streaming: ([\d.]+)%/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
  return {
    pp: avgLast(pp),
    tg: avgLast(tg),
    expertCacheHit: last(expert),
    kvHit: last(kv),
    ppLast: last(pp),
    tgLast: last(tg),
    samples: { pp: pp.length, tg: tg.length, expert: expert.length, kv: kv.length },
  };
}

export const EMPTY_METRICS = {
  pp: null,
  tg: null,
  expertCacheHit: null,
  kvHit: null,
  ppLast: null,
  tgLast: null,
  samples: {},
};

export function logLinesFromText(text, lineCount) {
  if (!text) return [];
  return text.split("\n").filter((l) => l.trim()).slice(-lineCount);
}

// ── Version check (Strata releases) ─────────────────────────────────────

const GITHUB_RELEASE_URL = "https://api.github.com/repos/Niko1221/Strata/releases/latest";
const VERSION_TTL_MS = 3600 * 1000;

let versionCache = { at: 0, value: null, state: "pending", inflight: null };

async function fetchLatestTag(ctx) {
  let res;
  if (ctx?.network?.fetch) {
    res = await ctx.network.fetch(GITHUB_RELEASE_URL, { timeoutMs: 5000 });
  } else {
    res = await fetch(GITHUB_RELEASE_URL, { signal: AbortSignal.timeout(5000) });
  }
  if (!res.ok) return null;
  const data = await res.json();
  const tag = data?.tag_name;
  return typeof tag === "string" ? tag.replace(/^v/i, "") : null;
}

// Returns the cached check result synchronously and refreshes it in the
// background when stale. state: "checked" | "error" | "pending".
export function getLatestVersion(ctx) {
  const now = Date.now();
  const fresh = versionCache.at && now - versionCache.at < VERSION_TTL_MS;
  if (!fresh && !versionCache.inflight) {
    versionCache.inflight = fetchLatestTag(ctx)
      .then((value) => {
        versionCache = { at: Date.now(), value, state: value ? "checked" : "error", inflight: null };
      })
      .catch(() => {
        versionCache = { at: Date.now(), value: null, state: "error", inflight: null };
      });
  }
  return { latest: versionCache.value, checkState: versionCache.state };
}

// ── Network exposure ──────────────────────────────────────────────────────

function runExec(candidates, args, timeout = 3000) {
  for (const bin of candidates) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout });
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// "Local Address:Port" column of `ss -tln` → { addr, port }.
export function parseListenLocal(local) {
  if (!local) return { addr: "", port: "" };
  if (local.startsWith("[")) {
    const m = /^\[([^\]]+)\]:(\S+)$/.exec(local);
    if (m) return { addr: m[1], port: m[2] };
  }
  const i = local.lastIndexOf(":");
  if (i < 0) return { addr: local, port: "" };
  return { addr: local.slice(0, i), port: local.slice(i + 1) };
}

// Actual socket listening address for a port, or null when not found.
export function detectListenAddr(port, platform = process.platform) {
  if (platform === "win32") return detectListenAddrWindows(port);
  const out = runExec(
    ["ss", "/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"],
    ["-tln"],
  );
  if (!out) return null;
  for (const line of out.split("\n")) {
    if (!/^\s*LISTEN\s/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[3];
    if (!local) continue;
    const parsed = parseListenLocal(local);
    if (parsed.port === String(port)) return parsed.addr;
  }
  return null;
}

// UNTESTED on Windows. `netstat -ano -p TCP` prints lines like:
//   TCP    0.0.0.0:8080     0.0.0.0:0      LISTENING      1234
function detectListenAddrWindows(port) {
  const out = runExec(["netstat"], ["-ano", "-p", "TCP"]);
  if (!out) return null;
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0].toUpperCase() !== "TCP") continue;
    if (parts[3].toUpperCase() !== "LISTENING") continue;
    const parsed = parseListenLocal(parts[1]);
    if (parsed.port === String(port)) return parsed.addr;
  }
  return null;
}

export function isLanExposedAddr(addr) {
  const a = String(addr || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!a || a === "*" || a === "0.0.0.0" || a === "::") return true;
  if (a === "localhost" || a === "::1" || /^127\./.test(a)) return false;
  return true; // bound to a specific routable address (e.g. 192.168.x.x)
}

export function getLocalIp(platform = process.platform) {
  if (platform === "win32") return getLocalIpFromInterfaces();
  const out = runExec(["ip", "/usr/sbin/ip", "/sbin/ip", "/bin/ip"], ["-4", "addr", "show"]);
  if (out) {
    const ips = [...out.matchAll(/inet\s+([\d.]+)/g)]
      .map((m) => m[1])
      .filter((ip) => !ip.startsWith("127."));
    if (ips.length) return ips[0];
  }
  const out2 = runExec(["hostname", "/usr/bin/hostname", "/bin/hostname"], ["-I"]);
  if (out2) {
    const ips = out2.trim().split(/\s+/).filter((ip) => ip && !ip.startsWith("127."));
    if (ips.length) return ips[0];
  }
  return getLocalIpFromInterfaces();
}

function getLocalIpFromInterfaces() {
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) return a.address;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readApiKey(cfg) {
  const main = readJson(mainConfigPath(cfg));
  if (main && main.api_key !== undefined && main.api_key !== null && main.api_key !== "") {
    return String(main.api_key).trim();
  }
  return "";
}

// Effective API key, source shape: plugin setting → config-file api_key.
// Docker overrides the middle step via the runtime cache.
export function resolveApiKey(cfg) {
  const fromPlugin = String(cfg?.apiKey || "").trim();
  if (fromPlugin) return fromPlugin;
  if (String(cfg?.deployMode) === "docker") {
    const rt = dockerRuntimeFor(cfg?.containerName);
    if (rt && rt.apiKey) return String(rt.apiKey).trim();
  }
  return readApiKey(cfg);
}

// Builds the `network` block shown to the UI. `fallbackHost` is the config
// file's `host` for source mode, and the container HOST for docker mode.
export function buildNetwork({ port, platform = process.platform, fallbackHost, apiKey, published }) {
  const p = Number(port) || FALLBACK_PORT;
  const listenAddr = detectListenAddr(p, platform);
  const addr = listenAddr || fallbackHost || "127.0.0.1";
  const lanExposed = isLanExposedAddr(addr);
  const localIp = getLocalIp(platform);
  const network = {
    listenAddr: addr,
    lanExposed,
    port: p,
    localIp,
    hasApiKey: !!apiKey,
    addressUrl: lanExposed
      ? localIp
        ? `http://${localIp}:${p}`
        : null
      : `http://127.0.0.1:${p}`,
  };
  if (published !== undefined) network.published = !!published;
  if (apiKey) network.apiKey = apiKey;
  return network;
}

// ── Key generation / host string edit ─────────────────────────────────────

function escapeRegExp2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setTopLevelString(text, key, value) {
  const reStr = new RegExp(`("${escapeRegExp2(key)}"\\s*:\\s*)"(?:[^"\\\\]|\\.)*"`);
  if (reStr.test(text)) {
    return text.replace(reStr, `$1"${value}"`);
  }
  const reAny = new RegExp(`("${escapeRegExp2(key)}"\\s*:\\s*)(?:-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)`);
  if (reAny.test(text)) {
    return text.replace(reAny, `$1"${value}"`);
  }
  return text.replace(/^(\s*\{)/, `$1\n  "${key}": "${value}",`);
}

// API key format requested by the widget: sk-strata- + 40 lowercase hex chars.
export function generateApiKey() {
  return `sk-strata-${crypto.randomBytes(20).toString("hex")}`;
}

// ── macOS unsupported (shared shape) ──────────────────────────────────────

export function unsupportedStatus() {
  return {
    state: "unsupported",
    platform: "macos",
    supportedPlatforms: ["win32", "linux"],
    reason: "Strata 目前只支持 Windows 和 Linux，不支持 macOS。",
    projectUrl: "https://github.com/Niko1221/Strata",
    checkedAt: Date.now(),
  };
}
