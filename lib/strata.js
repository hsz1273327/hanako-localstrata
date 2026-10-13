import * as fs from "./fsx.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { resolvePython } from "./python.js";
import {
  listStrataPids,
  listChildren,
  processCommandLine,
  isStrataCommandLine,
  killPid,
  pidExists,
} from "./process.js";

const DEFAULTS = {
  strataDir: "",
  pythonPath: "",
  // Selected Strata config file. Discovered from {strataDir}/strata-*.json;
  // never typed by hand. Empty means "not selected yet".
  configFile: "",
  // Optional override. 0 / empty means "use the port stored in the selected
  // Strata config file".
  port: 0,
  autoStart: false,
  refreshSec: 5,
  apiKey: "",
};

// Last-resort port when neither the plugin override nor any config file
// provides one. Kept separate from DEFAULTS.port, which means "no override".
const FALLBACK_PORT = 8080;

const STATUS_URL = (port) => `http://127.0.0.1:${port}/v1/status`;
const WEB_URL = (port) => `http://127.0.0.1:${port}/`;

// The v2 AppHost sandbox denies bare `fetch` (even to loopback). The
// manifest-gated host network door is the only way out; fall back to global
// fetch for unit tests and v1-style hosts. Requires manifest network
// `allowLocalhost: true` + the host in `allowedHosts` to reach Strata.
function netFetch(ctx, url, init) {
  return ctx?.network?.fetch ? ctx.network.fetch(url, init) : fetch(url, init);
}

// ── Config ────────────────────────────────────────────────────────────────

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
  return out;
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

// ── Process helpers (cross-platform; see lib/process.js) ──────────────────

// Validates that a PID (typically read from our pidfile) is really a Strata
// process before we terminate it, so a recycled PID can't kill something else.
function isStrataProcess(pid, platform = process.platform) {
  return isStrataCommandLine(processCommandLine(pid, platform));
}

function pidFilePath(cfg) {
  return path.join(cfg.strataDir, ".hanako-localstrata.pid");
}

function readPidFile(cfg) {
  try {
    const n = Number(fs.readFileSync(pidFilePath(cfg), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writePidFile(cfg, pid) {
  try {
    fs.writeFileSync(pidFilePath(cfg), String(pid));
  } catch {
    /* best effort */
  }
}

function clearPidFile(cfg) {
  try {
    fs.rmSync(pidFilePath(cfg), { force: true });
  } catch {
    /* best effort */
  }
}

// ── Resource usage ────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}

function readGpu() {
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

function readMem(platform = process.platform) {
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

function readResources(platform = process.platform) {
  return { gpu: readGpu(), mem: readMem(platform) };
}

// ── Config files (read / edit) ───────────────────────────────────────────

function mainConfigPath(cfg) {
  return path.resolve(cfg.strataDir, cfg.configFile);
}

function sharedConfigPath(cfg) {
  return mainConfigPath(cfg).replace(/\.json$/, "") + ".shared-settings.json";
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

// A candidate's display info, parsed from the file itself when possible.
// Fall back to the filename only, so a broken/legacy config still shows up.
export function describeConfigFile(strataDir, file) {
  const data = readJson(path.join(strataDir, file));
  return {
    file,
    quant: quantFromFile(file),
    context: toNum(argsValue(data?.args, "--max-context")),
    modelName: typeof data?.model_name === "string" ? data.model_name : null,
  };
}

function pluginPort(cfg) {
  const n = toNum(cfg?.port);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The port stored inside the selected Strata config file, if readable.
function configFilePort(cfg) {
  const main = readJson(mainConfigPath(cfg));
  const n = toNum(main?.port);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Effective port: the plugin's explicit override wins, then the selected
// config file's own port, then the historical default.
export function resolvePort(cfg) {
  return pluginPort(cfg) ?? configFilePort(cfg) ?? FALLBACK_PORT;
}

function argsValue(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Canonical flat view over the two config files. Used for display and diff.
function flatConfig(main, shared) {
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
function rawSamplingValues(mainText) {
  const out = {};
  for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty"]) {
    const m = mainText.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`));
    if (m) out[key] = m[1];
  }
  return out;
}

export function readConfigSummary(cfg) {
  const mainName = path.basename(cfg.configFile);
  const sharedName = mainName.replace(/\.json$/, "") + ".shared-settings.json";
  const main = readJson(path.resolve(cfg.strataDir, cfg.configFile));
  const shared = readJson(path.resolve(cfg.strataDir, sharedName));
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

export async function getConfigView(ctx) {
  const cfg = await readAllConfig(ctx);
  const selected = !!cfg.configFile && fs.existsSync(mainConfigPath(cfg));
  const mainPath = mainConfigPath(cfg);
  const sharedPath = sharedConfigPath(cfg);
  const mainName = cfg.configFile ? path.basename(mainPath) : "";
  const sharedName = cfg.configFile ? path.basename(sharedPath) : "";
  const main = readJson(mainPath);
  const shared = readJson(sharedPath);
  const mainText = readText(mainPath);
  const rawSmp = mainText ? rawSamplingValues(mainText) : {};
  const flat = flatConfig(main, shared);
  const sampling = (main && typeof main.sampling === "object" && main.sampling) || {};

  return {
    hasConfig: selected,
    configFile: cfg.configFile || null,
    files: { main: mainName, shared: sharedName },
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

const EDIT_KEYS = {
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

const REASONING_EFFORTS = ["off", "low", "medium", "xhigh"];
const KV_VALUES = ["int8", "q4_0", "k8v4"];

function validateEdits(edits) {
  const clean = {};
  const errors = [];
  for (const [key, raw] of Object.entries(edits || {})) {
    const spec = EDIT_KEYS[key];
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

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Surgical JSON text edit: only the target field value is rewritten, so the
// rest of the file (including number formatting like 1.0) is left untouched.
function applyTextEdit(text, op) {
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

function backupFile(file) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  return path.basename(backup);
}

export async function applyConfigEdits(ctx, edits) {
  const cfg = await readAllConfig(ctx);
  if (!cfg.configFile) throw new Error("尚未选择配置文件，无法保存参数");
  const { clean, errors } = validateEdits(edits);
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.validation = errors;
    throw err;
  }

  const mainPath = mainConfigPath(cfg);
  const sharedPath = sharedConfigPath(cfg);
  const main = readJson(mainPath);
  const shared = readJson(sharedPath);
  const mainText = readText(mainPath);
  const sharedText = readText(sharedPath);
  if (!main || !shared || mainText === null || sharedText === null) {
    throw new Error("配置文件读取失败，无法保存");
  }

  const before = flatConfig(main, shared);

  // Diff only the requested fields against their current values.
  const diff = [];
  for (const key of Object.keys(EDIT_KEYS)) {
    if (!(key in clean)) continue;
    if (String(before[key] ?? "") !== String(clean[key] ?? "")) {
      diff.push({ key, old: before[key] ?? null, new: clean[key] });
    }
  }
  if (!diff.length) return { saved: false, diff: [], backups: [], restartRequired: false, note: "没有变化" };

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

  // Apply every edit in memory first; touch the disk only when all succeeded.
  let newMainText = mainText;
  let newSharedText = sharedText;
  for (const op of mainOps) newMainText = applyTextEdit(newMainText, op);
  for (const op of sharedOps) newSharedText = applyTextEdit(newSharedText, op);

  // The surgically edited text must still be valid JSON.
  try {
    JSON.parse(newMainText);
    JSON.parse(newSharedText);
  } catch (e) {
    throw new Error(`编辑结果不是合法 JSON，已中止保存: ${e.message}`);
  }

  const backups = [];
  if (mainOps.length) {
    backups.push(backupFile(mainPath));
    fs.writeFileSync(mainPath, newMainText);
  }
  if (sharedOps.length) {
    backups.push(backupFile(sharedPath));
    fs.writeFileSync(sharedPath, newSharedText);
  }

  const restartRequired = diff.some((d) => EDIT_KEYS[d.key]?.restart);
  return { saved: true, diff, backups, restartRequired };
}

// ── Logs & speed metrics ──────────────────────────────────────────────────

function listLogFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^strata-.*\.log$/.test(f))
      .map((f) => path.join(dir, f))
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
}

function readTail(file, maxBytes = 512 * 1024) {
  return fs.readTailSync(file, maxBytes);
}

function avgLast(values, n = 3) {
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

export function readRecentLogs(cfg, lineCount = 10) {
  const files = listLogFiles(cfg.strataDir);
  for (const file of files) {
    const tail = readTail(file);
    if (!tail) continue;
    const metrics = parseMetrics(tail);
    const lines = tail.split("\n").filter((l) => l.trim()).slice(-lineCount);
    return { file: path.basename(file), lines, metrics };
  }
  return {
    file: null,
    lines: [],
    metrics: { pp: null, tg: null, expertCacheHit: null, kvHit: null, ppLast: null, tgLast: null, samples: {} },
  };
}

function collectExtras(cfg) {
  const log = readRecentLogs(cfg);
  let configSummary = null;
  try {
    configSummary = readConfigSummary(cfg);
  } catch {
    /* config not available */
  }
  return {
    metrics: log.metrics,
    log: { file: log.file, lines: log.lines },
    configSummary,
  };
}

// ── Version check (Strata releases) ─────────────────────────────────────

const GITHUB_RELEASE_URL = "https://api.github.com/repos/Niko1221/Strata/releases/latest";
const VERSION_TTL_MS = 3600 * 1000;

// In-memory cache, valid for the plugin process lifetime. The first caller
// triggers a background refresh but never blocks on it, so a slow/unreachable
// GitHub can never stall the status route (or the widget).
let versionCache = { at: 0, value: null, state: "pending", inflight: null };

async function fetchLatestTag(ctx) {
  let res;
  if (ctx?.network?.fetch) {
    res = await ctx.network.fetch(GITHUB_RELEASE_URL, { timeoutMs: 5000 });
  } else {
    // Legacy host fallback (no manifest-gated network.fetch).
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
function parseListenLocal(local) {
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
function detectListenAddr(port, platform = process.platform) {
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

function isLanExposedAddr(addr) {
  const a = String(addr || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!a || a === "*" || a === "0.0.0.0" || a === "::") return true;
  if (a === "localhost" || a === "::1" || /^127\./.test(a)) return false;
  return true; // bound to a specific routable address (e.g. 192.168.x.x)
}

function getLocalIp(platform = process.platform) {
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

// Cross-platform fallback (and the primary path on Windows): first non-internal
// IPv4 address reported by Node's os module.
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

function readApiKey(cfg) {
  const main = readJson(mainConfigPath(cfg));
  if (main && main.api_key !== undefined && main.api_key !== null && main.api_key !== "") {
    return String(main.api_key).trim();
  }
  return "";
}

// Effective API key: the plugin's apiKey setting wins, then fall back to the
// api_key stored in the Strata config file. Keeps auth in one place so every
// request to the Strata API uses the same source of truth.
export function resolveApiKey(cfg) {
  const fromPlugin = String(cfg?.apiKey || "").trim();
  if (fromPlugin) return fromPlugin;
  return readApiKey(cfg);
}

function getNetwork(cfg, port, platform = process.platform) {
  const p = Number(port) || FALLBACK_PORT;
  const listenAddr = detectListenAddr(p, platform);
  let addr = listenAddr;
  if (!addr) {
    // Degrade to the configured host field (default 127.0.0.1).
    const main = readJson(mainConfigPath(cfg));
    addr = typeof main?.host === "string" && main.host ? main.host : "127.0.0.1";
  }
  const lanExposed = isLanExposedAddr(addr);
  const localIp = getLocalIp(platform);
  const apiKey = resolveApiKey(cfg);

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
  // The full key is only needed for the copy button; the status line shows a
  // masked version. Expose it in both modes so the access row is consistent.
  if (apiKey) network.apiKey = apiKey;
  return network;
}

// Rewrites a top-level string field (e.g. "host", "api_key") in JSON text.
// If the field does not exist yet it is inserted right after the opening `{`,
// so the rest of the file keeps its original formatting.
function setTopLevelString(text, key, value) {
  const reStr = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)"(?:[^"\\\\]|\\.)*"`);
  if (reStr.test(text)) {
    return text.replace(reStr, `$1"${value}"`);
  }
  // Existing scalar (null / boolean / number) value → rewrite as the string.
  const reAny = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)(?:-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)`);
  if (reAny.test(text)) {
    return text.replace(reAny, `$1"${value}"`);
  }
  return text.replace(/^(\s*\{)/, `$1\n  "${key}": "${value}",`);
}

// API key format requested by the widget: sk-strata- + 40 lowercase hex chars.
export function generateApiKey() {
  return `sk-strata-${crypto.randomBytes(20).toString("hex")}`;
}

// Switch the Strata listener between local-only (127.0.0.1) and LAN-exposed
// (0.0.0.0). When opening the LAN the config must have an api_key, so one is
// generated and persisted if missing. Closing back to local keeps the key.
// The caller (routes/mode.js) decides whether to restart the running service.
export async function setHostMode(ctx, mode) {
  if (mode !== "local" && mode !== "lan") {
    const err = new Error("mode 必须是 local 或 lan");
    err.validation = ["mode 必须是 local 或 lan"];
    throw err;
  }

  const cfg = await readAllConfig(ctx);
  const mainPath = mainConfigPath(cfg);
  const main = readJson(mainPath);
  const mainText = readText(mainPath);
  if (!main || mainText === null) {
    throw new Error("配置文件读取失败，无法修改网络模式");
  }

  const targetHost = mode === "lan" ? "0.0.0.0" : "127.0.0.1";
  const currentHost = typeof main.host === "string" && main.host ? main.host : "";

  let newText = mainText;
  const hostChanged = currentHost !== targetHost;
  if (hostChanged) newText = setTopLevelString(newText, "host", targetHost);

  let generatedKey = null;
  let apiKeyChanged = false;
  if (mode === "lan" && !readApiKey(cfg)) {
    generatedKey = generateApiKey();
    newText = setTopLevelString(newText, "api_key", generatedKey);
    apiKeyChanged = true;
  }

  if (!hostChanged && !apiKeyChanged) {
    return { saved: false, mode, host: targetHost, apiKeyGenerated: false, apiKey: null, backups: [], note: "没有变化" };
  }

  // The surgically edited text must still be valid JSON.
  try {
    JSON.parse(newText);
  } catch (e) {
    throw new Error(`网络模式修改结果不是合法 JSON，已中止: ${e.message}`);
  }

  const backups = [backupFile(mainPath)];
  fs.writeFileSync(mainPath, newText);
  return {
    saved: true,
    mode,
    host: targetHost,
    apiKeyGenerated: apiKeyChanged,
    apiKey: generatedKey,
    backups,
  };
}

// ── Status ────────────────────────────────────────────────────────────────

export async function getStatus(ctx, opts = {}) {
  // macOS is explicitly unsupported by Strata (see BRIEF.md). Fail fast and
  // return everything the widget needs to render the notice; nothing on disk
  // is touched and no process is spawned. `opts.platform` makes this branch
  // testable from Linux.
  const platform = opts.platform || process.platform;
  if (platform === "darwin") {
    return {
      state: "unsupported",
      platform: "macos",
      supportedPlatforms: ["win32", "linux"],
      reason: "Strata 目前只支持 Windows 和 Linux，不支持 macOS。",
      projectUrl: "https://github.com/Niko1221/Strata",
      checkedAt: Date.now(),
    };
  }

  const cfg = await readAllConfig(ctx);
  const versionCheck = getLatestVersion(ctx);
  const python = resolvePython(cfg);
  const settings = {
    strataDir: cfg.strataDir || "",
    pythonPath: cfg.pythonPath || "",
    configFile: cfg.configFile || "",
    port: pluginPort(cfg),
    // pythonExists is true whenever a usable interpreter was resolved (either
    // the configured path or the system fallback). pythonResolved/source expose
    // which one; pythonError explains a failure.
    pythonExists: python.path !== null,
    pythonResolved: python.path,
    pythonSource: python.source,
    pythonError: python.error || null,
  };
  const basePort = resolvePort(cfg);
  const base = {
    state: "stopped",
    port: basePort,
    webUrl: WEB_URL(basePort),
    refreshSec: cfg.refreshSec,
    resources: readResources(platform),
    checkedAt: Date.now(),
    settings,
    version: { local: null, ...versionCheck },
  };

  // 1. Unconfigured: only strataDir is required. pythonPath may be empty (the
  //    system python3 is used in that case), so it never triggers this state.
  if (!cfg.strataDir) {
    return { ...base, state: "unconfigured" };
  }

  // 2. Not installed: the Strata server entrypoint is missing.
  const serverScript = path.join(cfg.strataDir, "serve", "server.py");
  if (!fs.existsSync(serverScript)) {
    return { ...base, state: "not-installed", serverScript };
  }

  // 3. The configured python must exist, or (when empty) a system python3 must
  //    be available. A missing interpreter is a detection failure, not a
  //    config-selection step.
  if (!python.path) {
    return { ...base, state: "python-missing", serverScript, error: python.error };
  }

  // 4. Discover config files. A stored selection is only valid when the file
  //    still exists in the directory; otherwise the user must (re)select one.
  const configCandidates = listConfigFiles(cfg.strataDir).map((f) => describeConfigFile(cfg.strataDir, f));
  if (!configCandidates.length) {
    return { ...base, state: "no-config", serverScript, configCandidates };
  }
  const selected = configCandidates.some((c) => c.file === cfg.configFile) ? cfg.configFile : "";
  if (!selected) {
    return { ...base, state: "needs-config", serverScript, configCandidates };
  }

  // Paths and the selection are valid — safe to read config files / network / logs.
  const rcfg = { ...cfg, configFile: selected };
  const port = resolvePort(rcfg);
  const readyBase = {
    ...base,
    port,
    webUrl: WEB_URL(port),
    configFile: selected,
    configCandidates,
    network: getNetwork(rcfg, port, platform),
    ...collectExtras(rcfg),
  };

  // 5. Try the running server.
  const apiKey = resolveApiKey(rcfg);
  try {
    const res = await netFetch(ctx, STATUS_URL(port), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        ...data,
        ...readyBase,
        state: "running",
        version: { local: data?.engine ?? null, ...versionCheck },
      };
    }
    // 401/403 means the server is up and answering — it just rejected this
    // key. Treat it as running so the widget never regresses to "加载中".
    if (res.status === 401 || res.status === 403) {
      return { ...readyBase, state: "running", authFailed: true };
    }
  } catch {
    /* server not reachable */
  }

  // 6. Otherwise decide between "starting" and "stopped" by process presence.
  const pids = listStrataPids(platform);
  if (pids.length) return { ...readyBase, state: "starting", pids };

  // 7. Configured, installed and selected, but nothing is running.
  return readyBase;
}

// ── Start / Stop ──────────────────────────────────────────────────────────

export async function startService(ctx, opts = {}) {
  const platform = opts.platform || process.platform;
  const cfg = await readAllConfig(ctx);
  const status = await getStatus(ctx, { platform });
  if (status.state === "running" || status.state === "starting") {
    return { started: false, already: true, state: status.state, ...status };
  }
  if (
    ["unconfigured", "not-installed", "python-missing", "no-config", "needs-config", "unsupported"].includes(
      status.state,
    )
  ) {
    const messages = {
      unconfigured: "请先配置 Strata 目录",
      "not-installed": "未找到 Strata，请先安装或修正目录",
      "python-missing": status.settings?.pythonError || "未找到可用的 Python 解释器",
      "no-config": "目录下未找到配置文件（strata-*.json）",
      "needs-config": "请先选择要使用的配置文件",
      unsupported: status.reason || "Strata 不支持当前系统",
    };
    return { started: false, state: status.state, error: messages[status.state] };
  }

  const python = resolvePython(cfg);
  if (!python.path) {
    return { started: false, state: "python-missing", error: python.error };
  }

  const rcfg = { ...cfg, configFile: status.configFile || cfg.configFile };
  const port = status.port || resolvePort(rcfg);
  const serverScript = path.join(rcfg.strataDir, "serve", "server.py");
  const configPath = path.resolve(rcfg.strataDir, rcfg.configFile);
  const tag = path.basename(rcfg.configFile, ".json");
  const logFile = path.join(rcfg.strataDir, `strata-${tag}.log`);

  fs.mkdirSync(rcfg.strataDir, { recursive: true });
  const args = [serverScript, "--engine", "strata", "--config", configPath, "--port", String(port)];
  let child;
  if (process.platform === "win32") {
    // UNTESTED on Windows. No shell redirect: Strata's serve/server.py writes
    // its own engine log, which is what readRecentLogs reads. The AppHost fs
    // sandbox stops us from opening the redirect file ourselves.
    child = spawn(python.path, args, {
      cwd: rcfg.strataDir,
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
  } else {
    // POSIX: a constant shell script execs the interpreter with stdout/stderr
    // appended to the log. Paths travel as separate argv entries, so there is
    // no shell-string injection; `exec` keeps the PID, so child.pid is the
    // Strata process itself.
    const launcher = 'p="$1"; l="$2"; shift 2; exec "$p" "$@" >>"$l" 2>&1';
    child = spawn("/bin/sh", ["-c", launcher, "sh", python.path, logFile, ...args], {
      cwd: rcfg.strataDir,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
  }
  child.unref();
  writePidFile(cfg, child.pid);

  return { started: true, pid: child.pid, state: "starting", logFile };
}

export async function stopService(ctx, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === "darwin") {
    return { stopped: false, unsupported: true, error: "Strata 不支持 macOS" };
  }

  const cfg = await readAllConfig(ctx);

  const parents = new Set(listStrataPids(platform));
  const recorded = readPidFile(cfg);
  if (recorded && isStrataProcess(recorded, platform)) parents.add(recorded);

  // Expand direct children (the engine + vision helpers run as child processes).
  const targets = new Set(parents);
  for (const pid of [...parents]) {
    for (const child of listChildren(pid, platform)) targets.add(child);
  }

  const killed = [];
  // Children first (higher pids), then parents. process.kill is cross-platform:
  // SIGTERM/SIGKILL on POSIX, TerminateProcess on Windows.
  for (const pid of [...targets].sort((a, b) => b - a)) {
    if (killPid(pid, "SIGTERM")) killed.push(pid);
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const forced = [];
  for (const pid of killed) {
    if (pidExists(pid)) {
      killPid(pid, "SIGKILL");
      forced.push(pid);
    }
  }

  if (!listStrataPids(platform).length) clearPidFile(cfg);
  return { stopped: killed.length > 0, killed, forced };
}

export async function restartService(ctx, opts = {}) {
  const stop = await stopService(ctx, opts);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const start = await startService(ctx, opts);
  return { stop, start };
}
