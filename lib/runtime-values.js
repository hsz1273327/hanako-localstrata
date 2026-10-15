// lib/runtime-values.js — "what is actually in effect right now" for the
// settings page's read-only "view" drawer.
//
// The stored profile is the user's intent; a running service may have been
// started with a different config file, python path, port or GGUF folder. When
// the drawer opens in read-only mode (service running) the page shows those
// live values, tagged with where they came from. Everything here is pure and
// dependency-injectable so it can be unit tested without docker or processes.
import path from "node:path";
import * as fs from "./fsx.js";
import { DEFAULT_MODELS_BIND_DIR } from "./profiles.js";
import { readAllConfig, readPidFile } from "./deployer/common.js";
import { getStatus } from "./deployer/index.js";
import { processCommandLine } from "./process.js";
import { resolveDockerPath, createDockerAdapter } from "./docker.js";
import { envMap, containerPort, publishedHostPort, deriveDockerPort } from "./deployer/docker.js";

export const RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

function str(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return String(value).trim() !== "";
}

// Split a command line into argv. `processCommandLine` already replaced the
// /proc/<pid>/cmdline NUL bytes with spaces, but a raw NUL-separated string is
// still accepted (and preserves arguments that contain spaces).
export function splitCmdline(text) {
  const raw = String(text || "");
  if (raw.includes("\0")) {
    return raw.split("\0").map((s) => s.trim()).filter(Boolean);
  }
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function basenameOf(p) {
  const text = String(p || "").replace(/[/\\]+$/, "");
  const i = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return i >= 0 ? text.slice(i + 1) : text;
}

function dirnameOf(p) {
  const text = String(p || "").replace(/[/\\]+$/, "");
  const i = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return "/";
  return text.slice(0, i);
}

function argValue(tokens, flag) {
  const i = tokens.indexOf(flag);
  return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : undefined;
}

function toPort(value) {
  if (value === undefined || value === null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : String(value).trim();
}

// The top-level GGUF folder of a persisted config file: an explicit string
// field wins, else the folder of the `--native` (or `--model`) shard path.
export function ggufDirFromConfig(configJson) {
  const obj = configJson && typeof configJson === "object" ? configJson : null;
  if (!obj) return "";
  for (const key of ["gguf_dir", "model_dir", "model_path"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const args = Array.isArray(obj.args) ? obj.args : [];
  for (const flag of ["--native", "--model"]) {
    const value = argValue(args, flag);
    if (value !== undefined && String(value).trim()) return dirnameOf(String(value).trim());
  }
  return "";
}

// Prefer the persisted profile (cfg.profiles[activeProfileId]) over
// cfg.activeProfile, whose ggufDir / port have already been mirrored to the
// effective values by readAllConfig. The user wants to see the raw intent.
function originalProfileOf(cfg) {
  const profiles = Array.isArray(cfg?.profiles) ? cfg.profiles : [];
  const id = str(cfg?.activeProfileId);
  if (id) {
    const found = profiles.find((p) => p && p.id === id);
    if (found) return found;
  }
  if (profiles.length) return profiles[0];
  return cfg?.activeProfile || cfg?.profile || {};
}

function setField(values, sources, field, value, source) {
  values[field] = value;
  sources[field] = source;
}

// Values + provenance for a running LOCAL source deployment. Priority per
// field: cmdline → the actual config file → the stored profile → general
// default. `sources[field]` is "runtime" | "profile" | "default".
export function localRuntimeValues({ cmdline, configJson, cfg, status } = {}) {
  const profile = originalProfileOf(cfg);
  const tokens = splitCmdline(cmdline);
  const serverIdx = tokens.findIndex((t) => /(^|[/\\])serve[/\\]server\.py$/i.test(t));

  let strataDir = "";
  if (serverIdx >= 0) strataDir = dirnameOf(dirnameOf(tokens[serverIdx]));

  let pythonPath = "";
  if (serverIdx > 0) {
    const candidate = tokens[serverIdx - 1];
    if (candidate && !candidate.startsWith("-") && /python/i.test(basenameOf(candidate))) {
      pythonPath = candidate;
    }
  }

  const cmdConfig = argValue(tokens, "--config");
  const configFile = cmdConfig !== undefined ? basenameOf(cmdConfig) : "";

  const cmdPort = argValue(tokens, "--port");
  const port = cmdPort !== undefined ? toPort(cmdPort) : "";

  const cmdGpu = argValue(tokens, "--gpu");
  const gpu = cmdGpu !== undefined ? String(cmdGpu).trim() : "";

  const configGguf = ggufDirFromConfig(configJson);
  const configPort = configJson && typeof configJson === "object" ? configJson.port : undefined;
  const resolvedPython = status?.settings?.pythonResolved;

  const values = {};
  const sources = {};

  if (str(strataDir)) setField(values, sources, "strataDir", strataDir, "runtime");
  else if (str(profile.strataDir)) setField(values, sources, "strataDir", str(profile.strataDir), "profile");

  if (str(pythonPath)) setField(values, sources, "pythonPath", pythonPath, "runtime");
  else if (str(resolvedPython)) setField(values, sources, "pythonPath", str(resolvedPython), "runtime");
  else if (str(profile.pythonPath)) setField(values, sources, "pythonPath", str(profile.pythonPath), "profile");

  if (str(configFile)) setField(values, sources, "configFile", configFile, "runtime");
  else if (str(status?.configFile)) setField(values, sources, "configFile", str(status.configFile), "runtime");

  if (isPresent(port)) setField(values, sources, "port", port, "runtime");
  else if (isPresent(configPort)) setField(values, sources, "port", Number(configPort), "runtime");
  else if (Number(profile.port) > 0) setField(values, sources, "port", Number(profile.port), "profile");
  else if (Number(cfg?.defaultPort) > 0) setField(values, sources, "port", Number(cfg.defaultPort), "default");

  if (str(gpu)) setField(values, sources, "gpu", gpu, "runtime");
  else if (str(profile.gpu)) setField(values, sources, "gpu", str(profile.gpu), "profile");

  if (str(configGguf)) setField(values, sources, "ggufDir", configGguf, "runtime");
  else if (str(profile.ggufDir)) setField(values, sources, "ggufDir", str(profile.ggufDir), "profile");
  else if (str(cfg?.defaultGgufDir)) setField(values, sources, "ggufDir", str(cfg.defaultGgufDir), "default");

  return { values, sources };
}

function mountFor(info, destination) {
  const mounts = Array.isArray(info?.Mounts) ? info.Mounts : [];
  const mount = mounts.find((m) => m && m.Destination === destination);
  if (!mount) return null;
  if (mount.Type === "bind") {
    const value = str(mount.Source);
    return value ? { value, source: "runtime" } : null;
  }
  if (mount.Type === "volume") {
    const value = str(mount.Name);
    return value ? { value, source: "runtime-volume" } : null;
  }
  return null;
}

// Values + provenance for a running container deployment, read from the
// `docker inspect` object. A `null` info (container absent) yields empty maps.
export function containerRuntimeValues(info, profile, cfg) {
  const values = {};
  const sources = {};
  if (!info || typeof info !== "object") return { values, sources };

  if (str(info.Config?.Image)) setField(values, sources, "image", str(info.Config.Image), "runtime");
  else if (str(profile?.image)) setField(values, sources, "image", str(profile.image), "profile");

  const name = String(info.Name || "").replace(/^\//, "").trim();
  if (str(name)) setField(values, sources, "containerName", name, "runtime");
  else if (str(profile?.containerName)) setField(values, sources, "containerName", str(profile.containerName), "profile");

  // The model bind is the only mount the profile names semantically; its
  // container path comes from ModelsBindDir (default /models).
  const modelBindDir = str(profile?.ModelsBindDir) || DEFAULT_MODELS_BIND_DIR;
  const modelMount = mountFor(info, modelBindDir);
  if (modelMount) setField(values, sources, "modelDir", modelMount.value, modelMount.source);
  else if (str(profile?.ModelDir)) setField(values, sources, "modelDir", str(profile.ModelDir), "profile");
  else if (str(cfg?.defaultGgufDir)) setField(values, sources, "modelDir", str(cfg.defaultGgufDir), "default");

  const env = envMap(info);
  const published = publishedHostPort(info, containerPort(env));
  if (published != null) {
    setField(values, sources, "port", deriveDockerPort(profile, info, env), "runtime");
  } else if (Number(profile?.EnginePort) > 0) {
    setField(values, sources, "port", Number(profile.EnginePort), "profile");
  } else if (Number(cfg?.defaultPort) > 0) {
    setField(values, sources, "port", Number(cfg.defaultPort), "default");
  }

  return { values, sources };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Absolute report for the read-only drawer. `opts` is fully injectable:
// cfg / status / cmdline / configJson / pid / docker / info.
export async function buildRunningReport(ctx, opts = {}) {
  const cfg = opts.cfg || (await readAllConfig(ctx));
  const status = opts.status !== undefined ? opts.status : await getStatus(ctx, opts);
  const state = status?.state || null;
  const running = RUNNING_STATES.has(state);
  const profile = originalProfileOf(cfg);
  const method = profile?.type === "container" ? "docker" : "local";
  const defaultPort = Number(cfg?.defaultPort);

  const report = {
    running,
    state,
    method,
    profileId: str(cfg?.activeProfileId) || str(profile?.id),
    profileName: str(profile?.name),
    profileType: profile?.type === "container" ? "container" : "local",
    values: {},
    sources: {},
    defaults: {
      defaultGgufDir: str(cfg?.defaultGgufDir),
      defaultPort: Number.isInteger(defaultPort) && defaultPort > 0 ? defaultPort : 0,
    },
  };

  // Stopped: nothing live to read; the drawer falls back to profile + defaults.
  if (!running) return report;

  if (method === "docker") {
    let info = opts.info;
    if (info === undefined) {
      let docker = opts.docker;
      if (!docker) {
        const bin = await resolveDockerPath(ctx);
        docker = bin ? createDockerAdapter(bin) : null;
      }
      info = docker && profile?.containerName ? docker.inspect(profile.containerName) : null;
    }
    const { values, sources } = containerRuntimeValues(info, profile, cfg);
    report.values = values;
    report.sources = sources;
    // Where the compose file lives (and whether compose can be used at all).
    if (status?.compose) report.compose = status.compose;
    report.details = {
      container: info
        ? {
            name: String(info.Name || profile?.containerName || "").replace(/^\//, ""),
            id: info.Id ? String(info.Id).slice(0, 12) : null,
            state: String(info.State?.Status || "unknown").toLowerCase(),
          }
        : null,
    };
    return report;
  }

  // Local source deployment.
  const pid = opts.pid !== undefined ? opts.pid : readPidFile(cfg) ?? status?.pids?.[0] ?? null;
  const platform = opts.platform || process.platform;
  const cmdline =
    opts.cmdline !== undefined ? opts.cmdline : pid ? processCommandLine(pid, platform) : "";
  let configJson = opts.configJson;
  if (configJson === undefined) {
    const configName = str(status?.configFile) || str(cfg?.configFile);
    configJson = configName ? readJsonFile(path.resolve(str(cfg?.strataDir), configName)) : null;
  }
  const { values, sources } = localRuntimeValues({ cmdline, configJson, cfg, status });
  report.values = values;
  report.sources = sources;
  report.details = {
    cmdline: cmdline || "",
    configFile: str(status?.configFile) || str(cfg?.configFile),
  };
  return report;
}
