// lib/deployer/common.js
//
// Pure / shared helpers used by BOTH deployers (local source + container).
// Nothing in here knows how Strata is launched; the deployer implementations
// own that. It also owns the multi-environment profile persistence helpers
// (`readAllConfig` / `writeProfiles` / `patchActiveProfile`).
//
// This file is the "one copy" of the helpers (flatConfig, rawSamplingValues,
// applyTextEdit, parseMetrics, isLanExposedAddr, generateApiKey, …). The local
// implementation and the container implementation both import from here so the
// two never drift.
import * as fs from "../fsx.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { processCommandLine, isStrataCommandLine } from "../process.js";
import {
  DEFAULT_MODELS_BIND_DIR,
  ensureProfiles,
  findProfile,
  normalizeProfile,
  needsProfileMigration,
  rawProfileConfigFile,
} from "../profiles.js";

export const DEFAULTS = {
  // Legacy flat local fields. They are the fallback/first profile so existing
  // installs and callers keep working; once `profiles` is saved these mirror
  // the active profile (see readAllConfig).
  strataDir: "",
  pythonPath: "",
  gpu: "",
  // Optional config-file override. Discovered from {strataDir}/strata-*.json;
  // empty means "auto": use the newest existing config, or generate one with
  // setup.py on first launch. It is never typed by hand.
  configFile: "",
  // Model folder holding the GGUF shards (first-run path).
  //   local     → passed to `setup.py --setup --gguf-dir <ggufDir>`
  //   container → bind-mounted at /gguf and exported as GGUF_DIR=/gguf
  // Empty means setup.py / the container downloads the model.
  ggufDir: "",
  // Optional override. 0 / empty means "use the deployment's own port".
  port: 0,
  // General fallbacks from the settings page's General section. They apply
  // when the active profile leaves the matching field empty:
  //   defaultGgufDir empty → no fallback (download on first start)
  //   defaultPort  0       → no fallback (use the deployment's own port)
  defaultGgufDir: "",
  defaultPort: 0,
  autoStart: false,
  refreshSec: 5,
  // The COMPUTED, effective API key for the active profile (readAllConfig
  // overwrites this with `activeProfile.apiKey || defaultApiKey`). It is also
  // the legacy home of the global key — migrated once into `defaultApiKey`
  // below, and kept in DEFAULTS so that legacy value stays readable/writable.
  apiKey: "",
  // The stored global key: the fallback when the active profile has no key of
  // its own. Precedence (both profile types): profile.apiKey → defaultApiKey →
  // (local only) the selected config file's api_key → none.
  defaultApiKey: "",
  // ── Multi-environment profiles ──────────────────────────────────────
  // `profiles` is an array of [{ id, name, type, … }]; there is always at
  // least one. `activeProfileId` is the current/last-used profile. Earlier
  // installs stored the list as a JSON string; readAllConfig migrates that
  // legacy form to an array once, and parseProfiles reads either shape.
  profiles: [],
  activeProfileId: "",
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

function resolveActiveId(list, id) {
  const wanted = String(id || "").trim();
  if (wanted && list.some((p) => p.id === wanted)) return wanted;
  return list[0]?.id || "";
}

// Resolve a container profile's effective field values: the profile's own
// value wins, otherwise a general default applies (the model group is the only
// container field group with a built-in fallback; the engine host port keeps the
// pre-existing defaultPort chain). Shared by readAllConfig and the profile-save
// route so a generated docker-compose.yml and the runtime profile agree.
export function effectiveContainerFields(profile, cfg) {
  const modelDir = String(profile?.ModelDir ?? "").trim() || String(cfg?.defaultGgufDir ?? "").trim();
  const modelsBindDir = String(profile?.ModelsBindDir ?? "").trim() || DEFAULT_MODELS_BIND_DIR;
  const defaultPort = Number(cfg?.defaultPort) > 0 ? Number(cfg.defaultPort) : 0;
  const rawEnginePort = Number(profile?.EnginePort);
  const rawEngineBindPort = Number(profile?.EngineBindPort);
  const enginePort =
    (Number.isInteger(rawEnginePort) && rawEnginePort > 0 ? rawEnginePort : 0) || defaultPort;
  const engineBindPort =
    (Number.isInteger(rawEngineBindPort) && rawEngineBindPort > 0 ? rawEngineBindPort : 0) || enginePort;
  return { ModelDir: modelDir, ModelsBindDir: modelsBindDir, EnginePort: enginePort, EngineBindPort: engineBindPort };
}

// Mirror the active profile onto the legacy flat fields so every existing
// caller (resolvePort, the source deployer, routes/requests.js) keeps working
// without knowing about profiles.
function applyActiveProfile(out) {
  const p = out.activeProfile;
  if (!p) return;
  // Effective value: a local profile no longer carries a model directory of its
  // own — a GGUF folder is an INPUT to a setup run, and it is chosen in the
  // 「运行 setup…」 dialog (or falls back to the general default). A container
  // profile still needs its bind-mount source, and that IS part of its
  // environment definition (see effectiveContainerFields below).
  const profilePort = Number(p.port);
  const effectiveGgufDir = String(out.defaultGgufDir ?? "").trim();
  const effectivePort =
    (Number.isInteger(profilePort) && profilePort > 0 ? profilePort : 0) || out.defaultPort;
  out.ggufDir = effectiveGgufDir;
  out.port = effectivePort;
  // The effective API key: the profile's own key wins, the global default is the
  // fallback (a local deployment keeps the selected config file's `api_key` as
  // the last resort inside resolveApiKey, exactly as before). Mirroring it onto
  // `out.apiKey` means every existing consumer — resolveApiKey, writeEnvFile,
  // defaultRunParams, buildNetwork, the request proxy — follows the profile
  // without a line of its own changing.
  out.apiKey = String(p.apiKey ?? "").trim() || String(out.defaultApiKey ?? "").trim();
  // `activeProfile` is a working copy so the deployers (which receive the
  // profile object itself) see the same effective values without mutating the
  // persisted list in `out.profiles`.
  out.activeProfile = { ...p, ggufDir: effectiveGgufDir, port: effectivePort };
  if (p.type === "container") {
    const effective = effectiveContainerFields(p, out);
    out.ggufDir = effective.ModelDir;
    out.port = effective.EnginePort;
    out.activeProfile = { ...p, ...effective };
    out.configFile = "";
    return;
  }
  out.strataDir = p.strataDir;
  out.pythonPath = p.pythonPath;
  out.gpu = p.gpu;
  // `configFile` is deliberately NOT mirrored from the profile. The selected
  // config is the top-level key ("which setup result is in effect"), shared by
  // every source profile and read straight from the stored config above; a
  // profile only says where Strata runs.
}

export async function readAllConfig(ctx) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = await readConfig(ctx, key);
  out.port = toNum(out.port) ?? 0;
  // General fallbacks accepted from ctx.config as-is; an out-of-range port
  // degrades to 0 ("no fallback") instead of poisoning the deployer.
  out.defaultGgufDir = String(out.defaultGgufDir ?? "").trim();
  const defaultPort = toNum(out.defaultPort);
  out.defaultPort =
    Number.isInteger(defaultPort) && defaultPort > 0 && defaultPort <= 65535 ? defaultPort : 0;
  out.refreshSec = Math.max(1, Number(out.refreshSec) || DEFAULTS.refreshSec);
  for (const key of ["strataDir", "pythonPath", "gpu", "ggufDir", "configFile", "activeProfileId", "apiKey", "defaultApiKey"]) {
    out[key] = String(out[key] ?? "").trim();
  }
  const storedProfiles = out.profiles;
  out.profiles = ensureProfiles(storedProfiles, out);
  out.activeProfileId = resolveActiveId(out.profiles, out.activeProfileId);
  out.activeProfile = findProfile(out.profiles, out.activeProfileId) || out.profiles[0];
  // One-shot: the global key used to live on `apiKey`; it is now the fallback
  // `defaultApiKey` (a profile's own key wins — see applyActiveProfile). Move it
  // once — and clear the legacy slot, so the old secret is not left duplicated
  // in plaintext. Captured BEFORE applyActiveProfile overwrites `out.apiKey`
  // with the effective value.
  const legacyGlobalKey = String(out.apiKey ?? "").trim();
  const keyMigration = !String(out.defaultApiKey ?? "").trim() && !!legacyGlobalKey;
  if (keyMigration) out.defaultApiKey = legacyGlobalKey;
  applyActiveProfile(out);
  // One-shot migrations sharing a single write:
  //   * shape  — earlier releases stored `profiles` as a JSON string; the schema
  //     now declares an array, so rewrite the legacy form the first time we see
  //     it (the guard makes this fire at most once per install).
  //   * config — profiles used to carry their own `configFile`. Promote the
  //     active profile's value into the top-level selection so the user's chosen
  //     setup result is never silently swapped for the newest file (an empty
  //     top-level key means "auto-pick the newest"). normalizeProfile already
  //     drops the per-profile field, so the write also strips it from storage.
  //   * key    — the global key moved from `apiKey` to the fallback
  //     `defaultApiKey` (captured above, before the effective mirror).
  // Never let a failed write break the read: parseProfiles reads both shapes and
  // the caller already has a usable result.
  const shapeMigration = needsProfileMigration(storedProfiles);
  const legacyConfigFile = rawProfileConfigFile(storedProfiles, out.activeProfileId);
  const configMigration = !out.configFile && !!legacyConfigFile;
  if (configMigration) out.configFile = legacyConfigFile;
  if (shapeMigration || configMigration || keyMigration) {
    try {
      const patch = { profiles: out.profiles, activeProfileId: out.activeProfileId };
      if (configMigration) patch.configFile = out.configFile;
      if (keyMigration) {
        patch.defaultApiKey = out.defaultApiKey;
        patch.apiKey = "";
      }
      await savePluginConfig(ctx, patch);
    } catch {
      /* best effort */
    }
  }
  return out;
}

// Persist the profile list and the active selection.
export async function writeProfiles(ctx, profiles, activeProfileId) {
  const list = ensureProfiles(profiles);
  const active = resolveActiveId(list, activeProfileId);
  // Persist the array itself — the schema declares `profiles` as an array, so
  // an old string-shaped value left by an earlier release is replaced here too.
  await savePluginConfig(ctx, { profiles: list, activeProfileId: active });
  return { profiles: list, activeProfileId: active };
}

// Patch fields on the active profile (used by the first-run flow after setup
// writes a new strata-*.json). Returns the updated list.
export async function patchActiveProfile(ctx, patch) {
  const cfg = await readAllConfig(ctx);
  const list = cfg.profiles.map((p) =>
    p.id === cfg.activeProfileId ? normalizeProfile({ ...p, ...patch }) : p,
  );
  return writeProfiles(ctx, list, cfg.activeProfileId);
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

// ── Container runtime cache ───────────────────────────────────────────────
//
// routes/requests.js calls resolvePort(cfg) / resolveApiKey(cfg) with only the
// plugin config in hand — no ctx, no container handle. When a container profile
// is the active deployment, the deployer records the port/key it discovered
// here and those helpers consult the cache. Process-local memo, never a second
// source of truth; cleared whenever the local deployer is the active one.
const dockerRuntime = { active: false, port: null, apiKey: null };

export function rememberDockerRuntime({ port, apiKey } = {}) {
  dockerRuntime.active = true;
  if (port !== undefined) dockerRuntime.port = port;
  if (apiKey !== undefined) dockerRuntime.apiKey = apiKey;
}

export function clearDockerRuntime() {
  dockerRuntime.active = false;
  dockerRuntime.port = null;
  dockerRuntime.apiKey = null;
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

// Effective port: plugin override → container runtime cache → selected
// config file → 8080.
export function resolvePort(cfg) {
  const override = pluginPort(cfg);
  if (override) return override;
  if (dockerRuntime.active && Number.isInteger(dockerRuntime.port) && dockerRuntime.port > 0) {
    return dockerRuntime.port;
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
    // The expert-memory knobs live in `args` (absent = the engine's default).
    expertCache: argsValue(main?.args, "--expert-cache"),    residentBudget: toNum(argsValue(main?.args, "--resident-budget-gib")),
    // The tuning knobs (B1 of the field audit): engine args, restart to apply.
    vramReserve: toNum(argsValue(main?.args, "--vram-reserve-mib")),
    prefill: argsValue(main?.args, "--prefill"),
    poolWorkers: toNum(argsValue(main?.args, "--pool-workers")),
    specMinP: toNum(argsValue(main?.args, "--spec-min-p")),
    suffixDraft: toNum(argsValue(main?.args, "--suffix-draft")),
    conversationSlots: toNum(argsValue(main?.args, "--conversation-cache-slots")),
    // A bare flag: present = on, absent = off (the engine's default).
    vramElastic: Array.isArray(main?.args) && main.args.includes("--vram-elastic") ? "on" : "",
    lowRamMode: lowRamModeOf(main?.args),
    // Presence of this one IS the config-side "KV streaming on" switch. The engine
    // has no `--kv-streaming` (0 hits in the 0.1.x binary, while `--kv` /
    // `--kv-resident` / `--kv-grow` are there), so streaming is expressed by this
    // flag; setup.py:5382-5411 writes the literal 32768 on exactly
    // `kv_streaming_wanted(model, ctx, kv, ram)`, and the launcher's preset diff
    // compares a config's `--kv-resident` with a preset's "auto" through that same
    // function (setup.py:3318-3325). It is an attended-window size that setup
    // owns: a re-run rebuilds it, WSL strips it (setup.py:3995-3999).
    kvResident: toNum(argsValue(main?.args, "--kv-resident")),
    // WHERE THIS CONFIG READS ITS MODEL FROM: the directory of the `--native`
    // shard. The editor shows it as the CURRENT value (not a system default) and
    // diffs the model-directory field against it, so an untouched field is never
    // an edit.
    modelDir: modelDirOf(main?.args),
    modelFile: modelShardPath(main?.args),
    // Requests decoded at once: a TOP-LEVEL key, and an absent one means the engine's
    // default of 1 (`setup.py` writes the key only for `>=2`). Reading it as 1 keeps an
    // untouched field out of the diff.
    parallel: toNum(main?.parallel) ?? 1,
  };
}

// The first model shard this config reads (`--native`). Deliberately NOT the same
// thing as `--pack` / `tokenizer` / `--mtp` / `--expert-profile`: those live under
// the data directory and they are not the model.
export function modelShardPath(args) {
  const p = argsValue(args, "--native");
  return typeof p === "string" && p.trim() ? p.trim() : undefined;
}

// The directory the model shards are read from.
export function modelDirOf(args) {
  const p = modelShardPath(args);
  return p ? path.dirname(p) : undefined;
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

// The facts a setup run DECIDED that have no editable field anywhere: the model
// it installed, the engine backend it picked, and the cards it wrote down. Kept
// out of `flatConfig` (which is about the values that CAN be edited) so the
// "setup's settings" table cannot drift into the params editor's territory.
//
// Absent means "setup did not record it" (this install's config has no `backend`,
// for instance) — the table shows that rather than guessing.
export function setupFacts(main) {
  const m = main && typeof main === "object" ? main : {};
  const gpu = m.gpu;
  return {
    model: typeof m.model_name === "string" && m.model_name.trim() ? m.model_name.trim() : undefined,
    backend: typeof m.backend === "string" && m.backend.trim() ? m.backend.trim() : undefined,
    // A layer split records a LIST here; a single card records a number (0 is a
    // real card, not "unset").
    gpu: Array.isArray(gpu) ? gpu.join(",") : gpu === undefined || gpu === null || gpu === "" ? undefined : String(gpu),
  };
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
  // A config file is only "selected" when its text was actually read AND parsed:
  // the values below come from that object. Anything else — an empty read, or the
  // raw `docker cp` stream (a tar blob) that a failed read used to hand back — is
  // not a config, and saying otherwise made the editor open as a blank, editable
  // form that also reported a full list of phantom changes.
  const selected = !!configFile && !!main && typeof main === "object";
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
    // What this config FILE was built as (read-only): the model setup installed,
    // its backend and cards, plus the two setup-only switches read out of the
    // args (values.lowRamMode / values.kvResident).
    setup: setupFacts(main),
  };
}

// ── Config edits (shared text surgery) ────────────────────────────────────

export const EDIT_KEYS = {
  context: { kind: "number", restart: true },
  kv: { kind: "string", restart: true },
  sessionCache: { kind: "number", restart: true },
  mtp: { kind: "number", restart: true },
  temperature: { kind: "number", restart: true },
  top_p: { kind: "number", restart: true },
  top_k: { kind: "number", restart: true },
  min_p: { kind: "number", restart: true },
  presence_penalty: { kind: "number", restart: true },
  max_tokens: { kind: "number", restart: false },
  reasoning_effort: { kind: "string", restart: false },
  // How the model's experts are held. Both are engine args, so they take effect
  // on the next start (restart: true), and both may legitimately be ABSENT from a
  // config (that is what the engine's default means) — the writer adds them in.
  expertCache: { kind: "string", restart: true },
  residentBudget: { kind: "number", restart: true },
  // The tuning knobs a normal deployment DOES touch (B1 of the field audit).
  // All are engine args → a restart applies them; none is setup-only.
  vramReserve: { kind: "number", restart: true },
  prefill: { kind: "string", restart: true },
  poolWorkers: { kind: "number", restart: true },
  specMinP: { kind: "number", restart: true },
  suffixDraft: { kind: "number", restart: true },
  conversationSlots: { kind: "number", restart: true },
  // A flag that takes no value: "on" writes it, empty means "leave it off" (an
  // absent flag IS off). Removing it again is not supported yet — see the
  // technical-debt note in docs/dev/v1.1-layering-notes.md.
  vramElastic: { kind: "flag", restart: true },
  // WHERE THIS CONFIG READS ITS MODEL FROM — the shard directory. Unlike every
  // other key here it is not one value: `--native` (shard 1), `--ple-gguf` (the
  // shard with the PLE table) and `vision.model` (shard 1 again, for the image
  // encoder) all point at it, and all three move together. Restart to apply: the
  // engine reads the paths once, at startup.
  modelDir: { kind: "modelDir", restart: true },
  // HOW MANY REQUESTS DECODE AT ONCE — a TOP-LEVEL config key (`"parallel": N`), not an
  // engine arg. 1 is the engine's default (one at a time, the rest queue) and is written
  // as an ABSENT key, like setup does (`>=2` only, setup.py:5489-5491). Restart to apply.
  // The cap here is 3 by product decision (the engine's own window is 8): each slot takes
  // ~0.59 GiB of VRAM from the expert cache and every extra one is ~3.6 GB of RAM at this
  // config's 256K context.
  parallel: { kind: "number", restart: true, top: true },
  // No `lowRam` and no `port` here, deliberately:
  //   * `--low-ram` is setup's flag — the config carries `--resident-experts` /
  //     `--mmap-experts` instead (see lowRamModeOf), so a field would write a flag
  //     the engine does not know;
  //   * the config's `port` is the THIRD fallback in resolvePort (profile override →
  //     container runtime → the file → 8080), and the profile already has its own
  //     port field, so a second knob here would silently lose to it.
};

// The container cannot change its published port from the config file
// (the port mapping is fixed at container creation, and the entrypoint always
// passes `--port "$PORT"`). `port` is therefore read-only there.
// The container side keeps the same set: the port is no longer an edit key for
// EITHER side (see EDIT_KEYS), so there is nothing left to exclude here. Kept as
// a name because the container deployer reads it.
export const DOCKER_EDIT_KEYS = EDIT_KEYS;

export const REASONING_EFFORTS = ["off", "low", "medium", "xhigh"];
export const KV_VALUES = ["int8", "q4_0", "k8v4"];
// The low-RAM mode lives in the config as ONE of these two flags, never as
// `--low-ram`: that spelling belongs to setup, which TRANSLATES it at generation
// time (setup.py:5364 `args += ["--resident-experts" if resident else
// "--mmap-experts"]`), and the engine's own flags are these two — `--resident-experts`
// is even documented in its own help as "the low-RAM PC's resident mode (setup)".
// Writing `--low-ram` into a config would hand the engine a flag it does not know.
// So the mode is read out of the args and reported, never offered as a field.
export const LOW_RAM_MODE_FLAGS = ["--resident-experts", "--mmap-experts"];

export function lowRamModeOf(args) {
  // An unreadable config has no args to read: say nothing rather than "auto",
  // which would be a claim about a file we could not open.
  if (!Array.isArray(args)) return undefined;
  // Presence, not a value: both flags stand alone (setup writes them bare).
  if (args.includes("--resident-experts")) return "resident";
  if (args.includes("--mmap-experts")) return "mmap";
  // Neither flag = setup's `auto` found the experts fit, i.e. the normal path.
  return "auto";
}

// `--expert-cache` is a budget in slots, and `auto` (the default) means "size it
// from the card and check it fits" (docs/DETAILS.md, "the expert cache size is a
// budget").
export const EXPERT_CACHE_AUTO = "auto";

export function validateEdits(edits, keys = EDIT_KEYS) {
  const clean = {};
  const errors = [];
  for (const [key, raw] of Object.entries(edits || {})) {
    const spec = keys[key];
    if (!spec) {
      errors.push(`未知字段: ${key}`);
      continue;
    }
    if (spec.kind === "modelDir") {
      const s = String(raw ?? "").trim();
      if (!s) {
        errors.push("modelDirEmpty");
        continue;
      }
      clean[key] = s;
      continue;
    }
    if (spec.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push(`${key} 需要数字`);
        continue;
      }
      if (key === "residentBudget" && !(n > 0)) {
        errors.push("常驻专家量必须是正数（GiB）");
        continue;
      }
      if (key === "vramReserve" && !(n >= 0 && n <= 8192)) {
        errors.push("显存保留必须是 0..8192（MiB）");
        continue;
      }
      if (key === "poolWorkers" && !(n >= 0 && n <= 256)) {
        errors.push("CPU 专家线程数必须是 0..256");
        continue;
      }
      if (key === "specMinP" && !(n >= 0 && n <= 1)) {
        errors.push("草稿确信度必须是 0..1");
        continue;
      }
      if (key === "suffixDraft" && !(n >= 0 && n <= 8)) {
        errors.push("SUFFIX 草稿长度必须是 0..8");
        continue;
      }
      if (key === "conversationSlots" && !(n >= 1 && n <= 16)) {
        errors.push("停放槽位必须是 1..16");
        continue;
      }
      if (key === "parallel" && !(Number.isInteger(n) && n >= 1 && n <= 8)) {
        errors.push("并发数必须是 1..8（1 = 关闭；引擎上限 8，界面按显存分档上限）");
        continue;
      }
      clean[key] = n;
    } else {
      const s = String(raw);
      if (key === "prefill" && !(s === "auto" || /^auto:[1-9]\d*$/.test(s) || /^[1-9]\d*$/.test(s))) {
        errors.push("prompt 分块必须是 auto、auto:N 或正整数");
        continue;
      }
      if (key === "vramElastic" && s !== "on") {
        errors.push("显存弹性只有「不写」或 on");
        continue;
      }
      if (key === "reasoning_effort" && !REASONING_EFFORTS.includes(s)) {
        errors.push(`思考档位必须是 ${REASONING_EFFORTS.join("/")}`);
        continue;
      }
      if (key === "kv" && !KV_VALUES.includes(s)) {
        errors.push(`KV 量化必须是 ${KV_VALUES.join("/")}`);
        continue;
      }
      if (key === "expertCache" && s !== EXPERT_CACHE_AUTO && !/^\d+$/.test(s)) {
        errors.push(`专家缓存必须是 ${EXPERT_CACHE_AUTO} 或槽数（整数）`);
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

// Append `"--flag", "value"` to the config's `args` array. The surgical writer
// could previously only REWRITE a flag that was already there (it threw
// otherwise), which is not enough for flags whose absence means "setup left it at
// its default" — `--low-ram auto`, or `--resident-budget-gib` on a model whose
// experts fit. The scan is string-aware so a `]` inside a path cannot close the
// array early.
function insertArgPair(text, flag, value) {
  const start = text.indexOf('"args"');
  if (start < 0) throw new Error("配置里没有 args 数组");
  const open = text.indexOf("[", start);
  if (open < 0) throw new Error("配置里的 args 不是数组");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error("配置里的 args 数组没有闭合");
  const body = text.slice(open + 1, close).trim();
  // `undefined` is a FLAG that takes no value (`--vram-elastic`).
  const pair = value === undefined
    ? JSON.stringify(flag)
    : `${JSON.stringify(flag)}, ${JSON.stringify(String(value))}`;
  const inject = body ? `, ${pair}` : pair;
  return `${text.slice(0, close)}${inject}${text.slice(close)}`;
}

// Surgical JSON text edit: only the target field value is rewritten, so the
// rest of the file (including number formatting like 1.0) is left untouched.
export function applyTextEdit(text, op) {
  const key = escapeRegExp(op.key);
  // A BARE flag (`--vram-elastic`): it takes no value, so presence IS the whole
  // state. The value-pair rewrite below cannot match it, and without this branch
  // a second `arg-add` would append a duplicate flag.
  if (op.type === "arg-add" && op.value === undefined) {
    if (new RegExp(`"${key}"`).test(text)) return text;
    return insertArgPair(text, op.key, undefined);
  }
  if (op.type === "top-key") return setTopLevelValue(text, op.key, op.value);
  if (op.type === "arg" || op.type === "arg-add") {
    const re = new RegExp(`("${key}"\\s*,\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    // MATCH decides, not "did the text change": writing back a value that is already
    // there is a legitimate no-op (the identity rewrite), and comparing texts made
    // it look like the flag was missing.
    if (re.test(text)) return text.replace(re, `$1"${op.value}"`);
    // `arg` demands the flag be there; `arg-add` takes its absence as "use the
    // default" and writes it in (the existing pair wins when present).
    if (op.type === "arg-add") return insertArgPair(text, op.key, op.value);
    throw new Error(`配置中找不到参数 ${op.key}`);
  }
  const reStr = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (reStr.test(text)) return text.replace(reStr, `$1"${op.value}"`);
  const reNum = new RegExp(`("${key}"\\s*:\\s*)-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`);
  if (!reNum.test(text)) throw new Error(`配置中找不到字段 ${op.key}`);
  return text.replace(reNum, `$1${op.value}`);
}

// ── A TOP-LEVEL key (`"parallel": N`) ─────────────────────────────────────────
//
// Every other value op matches `"key": …` ANYWHERE in the file. That is fine for a
// name that can only occur once (``"port"``) and unsafe for a word like `parallel`,
// which could sit in a nested block too. This one:
//   * refuses when the key appears more than once in the file (nothing to disambiguate
// by);
//   * rewrites the existing member in place, or inserts a missing one at the END of
//     the root object in the file's own indentation;
//   * deletes the member for `value === undefined` (that is how a field goes back to
// the engine default instead of writing it), and both the leading and trailing comma
//     cases are covered;
//   * and after every edit, parses the result, checks the key's value and checks that
//     the rest of the top-level object is unchanged.
const JSON_LITERAL = `(?:-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null|"(?:[^"\\\\]|\\\\.)*")`;

// Every occurrence of the key token with its nesting depth (1 = a member of the root
// object). String-aware: a brace inside a path must not move the depth.
function keyDepths(text, key) {
  const out = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') break;
        else j += 1;
      }
      const raw = text.slice(i, j + 1);
      if (raw === JSON.stringify(key)) out.push(depth);
      i = j + 1;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    i += 1;
  }
  return out;
}

export function setTopLevelValue(text, key, value) {
  const escaped = escapeRegExp(key);
  const depths = keyDepths(text, key);
  // A nested `"parallel"` and a root one cannot be told apart by a text edit: refuse
  // rather than risk rewriting the wrong one (the insert branch would also make the
  // next edit ambiguous).
  if (depths.some((d) => d !== 1)) {
    throw new Error(`配置里的 ${key} 不只在顶层（嵌套位置也出现了），无法安全修改`);
  }
  if (depths.length > 1) {
    throw new Error(`配置里 ${key} 出现了 ${depths.length} 次，无法确定要改哪一个`);
  }
  const before = JSON.parse(text);
  const had = Object.prototype.hasOwnProperty.call(before, key);
  const memberRe = new RegExp(`("${escaped}"\\s*:\\s*)${JSON_LITERAL}`);
  let next;

  if (value === undefined) {
    // Delete: the field means "the engine default", and an absent key IS that.
    const found = memberRe.exec(text);
    if (!found) return text; // nothing to delete
    const memberStart = found.index;
    const memberEnd = memberStart + found[0].length;
    const rest = text.slice(memberEnd);
    const lead = text.slice(0, memberStart);
    if (/^\s*,/.test(rest)) {
      // a following comma: eat it and any blank line it leaves behind
      next = lead + rest.replace(/^\s*,\s*/, "");
    } else if (/,\s*$/.test(lead)) {
      // the last member: drop the comma that precedes it
      next = lead.replace(/,\s*$/, "") + rest;
    } else {
      // the only member
      next = lead + rest;
    }
  } else if (had) {
    const found = memberRe.exec(text);
    if (!found) throw new Error(`配置里 ${key} 不是可以改写的数字`);
    next = text.slice(0, found.index) + found[1] + String(value) + text.slice(found.index + found[0].length);
  } else {
    // Insert at the end of the root object, in the file's own indentation.
    const close = text.lastIndexOf("}");
    if (close < 0) throw new Error("配置不是 JSON 对象");
    const indent = (text.match(/\n([ \t]+)"/) || [])[1] || "  ";
    const body = text.slice(text.indexOf("{") + 1, close);
    const empty = !body.trim();
    const member = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    next = empty
      ? `${text.slice(0, close).replace(/\s*$/, "")}\n${indent}${member}\n${text.slice(close)}`
      : `${text.slice(0, close).replace(/\s*$/, ",")}\n${indent}${member}\n${text.slice(close)}`;
  }

  // Verify: the key's value is what we asked for (or gone), and nothing else moved.
  const after = JSON.parse(next);
  if (value === undefined) {
    if (Object.prototype.hasOwnProperty.call(after, key)) throw new Error(`删除 ${key} 失败`);
  } else if (Number(after[key]) !== Number(value)) {
    throw new Error(`写入 ${key} 后读回的是 ${JSON.stringify(after[key])}`);
  }
  const keysBefore = Object.keys(before).filter((k) => k !== key);
  const keysAfter = Object.keys(after).filter((k) => k !== key);
  if (keysBefore.join("\u0000") !== keysAfter.join("\u0000")) {
    throw new Error(`写 ${key} 时动到了其它顶层键`);
  }
  return next;
}

// ── Changing the model's directory (one field, three paths) ──────────────────
//
// The shards a config reads are named in `--native` (shard 1) and `--ple-gguf`
// (the shard holding the PLE table — the LAST shard of the original release, the
// FIRST of Swift's), and the vision block repeats shard 1 in `vision.model` so the
// image encoder loads the same weights. `--pack` / `tokenizer` / `--mtp` /
// `--expert-profile` / `exe` are NOT shard paths (they live under the data
// directory) and are deliberately left where they are: moving the model is not
// moving the install.
//
// The new directory is searched BY NAME rather than by prefix concatenation, so a
// renamed or re-split upload is found instead of a path that does not exist being
// written out silently. Anything ambiguous, incomplete, or of a different shard
// count is refused. That last check is exactly what setup.py:1420 lacks: its
// `gguf_dir_shards` takes the folder's only `-00001-of-` file whatever
// quantization it is (and `gguf_dir_problem` at :1465 only checks that the file is
// runnable), which is how an IQ3_S file set ended up inside a config tagged
// IQ3_XXS while a `packs/iq3_xxs` was rebuilt from those very files.
const SHARD_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(?:^|-)((?:UD-)?(?:I?Q\d+(?:_[A-Za-z0-9]+)*)|BF16|F16|F32)(?=[-.]|$)/i;

// The quantization a shard/single-file name declares ("IQ3_S", "UD-Q4_K_XL", …),
// or "" when the name does not say — the last hit wins (the quant is at the end).
function quantOf(name) {
  const stem = String(name).replace(SHARD_RE, "$1").replace(/\.gguf$/i, "");
  const hits = [...stem.matchAll(new RegExp(QUANT_RE.source, "gi"))];
  return hits.length ? hits[hits.length - 1][1].toUpperCase() : "";
}

// The folder's gguf files grouped into shard sets (stem → {total, files}) plus the
// suffix-less single files. Splitting by STEM is what makes two complete models of
// the same quantization in one folder detectable instead of arbitrarily picked.
function shardSets(names) {
  const sets = new Map();
  const singles = [];
  for (const n of names) {
    const m = SHARD_RE.exec(n);
    if (!m) {
      singles.push(n);
      continue;
    }
    let s = sets.get(m[1]);
    if (!s) {
      s = { stem: m[1], total: Number(m[3]), files: new Map() };
      sets.set(m[1], s);
    }
    s.files.set(Number(m[2]), n);
  }
  return { sets, singles };
}

// { error, message, hint? } when the directory cannot be used, else { ops, dir,
// files } where `ops` rewrites the three paths. Read-only: it stats, lists and
// returns text edits, never writes.
export function resolveModelDirOps(mainText, dir) {
  const main = parseJsonText(mainText);
  const args = Array.isArray(main?.args) ? main.args : [];
  const native = modelShardPath(args);
  if (!native) {
    return { error: "modelDirNoNative", message: "配置里没有 --native，无法确定这份配置现在读的模型" };
  }
  if (!path.isAbsolute(native)) {
    return { error: "modelDirNotAbsolute", message: `当前模型分片不是绝对路径：${native}` };
  }
  const target = String(dir ?? "").trim();
  if (!path.isAbsolute(target)) {
    return { error: "modelDirNotAbsolute", message: `模型目录必须是绝对路径：${target}` };
  }
  let st = null;
  try {
    st = fs.statSync(target);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    return { error: "modelDirBadDir", message: `模型目录不存在或不是目录：${target}` };
  }
  let entries = null;
  try {
    entries = fs.readdirSync(target);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) {
    return { error: "modelDirBadDir", message: `模型目录不可读：${target}` };
  }
  const gguvs = entries.filter((n) => /\.gguf$/i.test(n) && !/^mmproj/i.test(n));
  const curName = path.basename(native);
  const curShard = SHARD_RE.exec(curName);
  const want = curShard ? Number(curShard[3]) : 1;
  const wantQuant = quantOf(curName);
  const { sets, singles } = shardSets(gguvs);

  let found = null; // { stem, total, files: Map }
  if (gguvs.includes(curName)) {
    found = curShard
      ? sets.get(curShard[1]) || null
      : { stem: curName.replace(/\.gguf$/i, ""), total: 1, files: new Map([[1, curName]]) };
  } else {
    // No file of that name: look for a set (or single file) with the SAME
    // quantization — a renamed or re-split upload still works, a different model
    // does not silently take its place.
    const cands = [];
    for (const s of sets.values()) {
      if (wantQuant && quantOf(s.stem) === wantQuant) cands.push({ set: s, name: s.stem });
    }
    for (const n of singles) {
      if (wantQuant && quantOf(n) === wantQuant) {
        cands.push({ set: { stem: n.replace(/\.gguf$/i, ""), total: 1, files: new Map([[1, n]]) }, name: n });
      }
    }
    if (!cands.length) {
      return {
        error: "modelDirBadShards",
        message: `${target} 里没有与当前配置匹配的模型分片（需要量化 ${wantQuant || "?"} 的 ${want} 段）`,
        hint: gguvs.slice(0, 6),
      };
    }
    if (cands.length > 1) {
      return {
        error: "modelDirAmbiguous",
        message: `${target} 里有多个同量化的候选模型，无法确定用哪个`,
        hint: cands.map((c) => c.name).slice(0, 6),
      };
    }
    found = cands[0].set;
  }

  if (!found) {
    return { error: "modelDirBadShards", message: `${target} 里没有当前模型的分片` };
  }
  if (found.total !== want) {
    return {
      error: "modelDirCountMismatch",
      message: `分片数与当前配置不一致：需要 ${want} 段，${target} 里是 ${found.total} 段`,
    };
  }
  const shardNames = [];
  for (let i = 1; i <= found.total; i += 1) {
    const n = found.files.get(i);
    if (!n) {
      return {
        error: "modelDirBadShards",
        message: `${target} 里的 ${found.stem} 分片不完整（缺第 ${i} 段，共 ${found.total} 段）`,
      };
    }
    shardNames.push(n);
  }

  const at = (i) => path.join(target, shardNames[i - 1]);
  const ops = [{ type: "arg", key: "--native", value: at(1) }];
  // The PLE table's shard keeps its INDEX: the shard count is required to match, so
  // the index maps exactly onto the new set.
  const ple = argsValue(args, "--ple-gguf");
  if (typeof ple === "string" && ple.trim() && path.isAbsolute(ple)) {
    const pm = SHARD_RE.exec(path.basename(ple));
    const idx = pm ? Number(pm[2]) : 1;
    if (idx >= 1 && idx <= found.total) {
      ops.push({ type: "arg", key: "--ple-gguf", value: at(idx) });
    }
  }
  // `vision.model` repeats shard 1 — but only rewrite it while it IS shard 1 today
  // (a vision block pointing elsewhere is not ours to guess about).
  const vmodel = main?.vision && typeof main.vision === "object" ? main.vision.model : null;
  if (typeof vmodel === "string" && vmodel.trim() && path.resolve(vmodel) === path.resolve(native)) {
    ops.push({ type: "str", key: "model", value: at(1) });
  }
  return { ops, dir: target, files: shardNames };
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
  if ("expertCache" in clean) mainOps.push({ type: "arg-add", key: "--expert-cache", value: clean.expertCache });
  if ("residentBudget" in clean) mainOps.push({ type: "arg-add", key: "--resident-budget-gib", value: String(clean.residentBudget) });
  if ("vramReserve" in clean) mainOps.push({ type: "arg-add", key: "--vram-reserve-mib", value: String(clean.vramReserve) });
  if ("prefill" in clean) mainOps.push({ type: "arg-add", key: "--prefill", value: clean.prefill });
  if ("poolWorkers" in clean) mainOps.push({ type: "arg-add", key: "--pool-workers", value: String(clean.poolWorkers) });
  if ("specMinP" in clean) mainOps.push({ type: "arg-add", key: "--spec-min-p", value: String(clean.specMinP) });
  if ("suffixDraft" in clean) mainOps.push({ type: "arg-add", key: "--suffix-draft", value: String(clean.suffixDraft) });
  if ("conversationSlots" in clean) mainOps.push({ type: "arg-add", key: "--conversation-cache-slots", value: String(clean.conversationSlots) });
  // A bare flag: `undefined` makes the writer insert just the flag itself.
  if ("parallel" in clean) {
    // 1 means "the engine's default": the key is REMOVED rather than written as 1, so a
    // config that never had it stays byte-identical (see setTopLevelValue).
    mainOps.push({
      type: "top-key",
      key: "parallel",
      value: Number(clean.parallel) >= 2 ? Number(clean.parallel) : undefined,
    });
  }
  if ("modelDir" in clean) {
    const r = resolveModelDirOps(mainText, clean.modelDir);
    if (r.error) {
      const err = new Error(r.message);
      err.validation = [r.error];
      if (r.hint) err.data = { hint: r.hint };
      throw err;
    }
    mainOps.push(...r.ops);
  }
  if ("vramElastic" in clean) mainOps.push({ type: "arg-add", key: "--vram-elastic", value: undefined });
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
  const file = configFilePath(cfg);
  const main = file ? readJson(file) : null;
  if (main && main.api_key !== undefined && main.api_key !== null && main.api_key !== "") {
    return String(main.api_key).trim();
  }
  return "";
}

// The config file a local deployment actually uses: the explicit selection, or —
// when it is empty, which the schema documents as "auto" — the newest existing
// one, using the SAME rule the deployer applies when it resolves a config. This
// matters for the key (and only the key today): reading `path.resolve(dir, "")`
// silently resolves to the directory and would lose the `api_key` a setup-
// generated config already carries.
export function effectiveConfigFile(cfg) {
  const dir = String(cfg?.strataDir ?? "").trim();
  if (!dir) return "";
  const explicit = String(cfg?.configFile ?? "").trim();
  if (explicit) return explicit;
  return pickConfigFile(dir, listConfigFiles(dir).map((file) => ({ file })));
}

// Absolute path of that file, or "" when there is none.
function configFilePath(cfg) {
  const dir = String(cfg?.strataDir ?? "").trim();
  const name = effectiveConfigFile(cfg);
  return dir && name ? path.resolve(dir, name) : "";
}

// The `vision` block a setup.py run wrote into a LOCAL config: whether the image
// encoder is configured, whether it runs on the GPU or the CPU, and which mmproj
// it loads. READ-ONLY by design — setup.py owns this block (it is one of its
// SETUP_KEYS, and it downloads the encoder, pins `vision.gpu` and writes the
// mmproj path), so the app reports it rather than editing it.
//
// `available: null` means "not readable from here" — a container keeps its config
// inside the container, so the host cannot answer for it.
export function readVisionInfo(cfg) {
  const file = configFilePath(cfg);
  if (!file) return null;
  const main = readJson(file);
  if (!main) return null;
  const v = main.vision && typeof main.vision === "object" ? main.vision : null;
  if (!v) return { available: false, encoder: "", mmproj: "", exe: "" };
  const encoder = v.gpu === true ? "gpu" : v.gpu === false ? "cpu" : "";
  const mmproj = v.mmproj ? path.basename(String(v.mmproj)) : "";
  const exe = v.exe ? path.basename(String(v.exe)) : "";
  // A block with neither an encoder nor an mmproj is "off" rather than "on":
  // there would be nothing to run.
  return { available: !!(mmproj || exe), encoder, mmproj, exe };
}

// Keys whose value must never reach a MODEL-facing payload. The status object
// carries secrets by construction: `network.apiKey` (the effective key, kept for
// the panel's copy action) and `docker.env` (the running container's whole
// environment, which holds its own API_KEY). The tools report state and metrics,
// so their payloads pass through here first.
const MODEL_UNSAFE_KEYS = new Set(["apiKey", "defaultApiKey", "api_key", "env", "environment"]);

// Deep copy of a status/result payload with the secret-bearing keys removed.
// Pure, and safe on anything (non-objects pass through).
export function redactSecretsForModel(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecretsForModel(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (MODEL_UNSAFE_KEYS.has(key)) continue;
    out[key] = redactSecretsForModel(item, depth + 1);
  }
  return out;
}

// Effective API key, in precedence order:
//   profile.apiKey → global defaultApiKey → (local) config file api_key
//   → container runtime cache (the key read out of a running container)
// The first two already arrive merged on `cfg.apiKey` (see applyActiveProfile),
// so the remaining branches only matter when neither is set.
export function resolveApiKey(cfg) {
  const fromPlugin = String(cfg?.apiKey || "").trim();
  if (fromPlugin) return fromPlugin;
  if (dockerRuntime.active && dockerRuntime.apiKey) return String(dockerRuntime.apiKey).trim();
  return readApiKey(cfg);
}

// Builds the `network` block shown to the UI. `fallbackHost` is the config
// file's `host` for local mode, and the container HOST for a container profile.
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
