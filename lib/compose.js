// lib/compose.js — the container spec + docker-compose.yml generation.
//
// A container profile used to be launched with a generic `docker run` recipe
// (hard-coded `--gpus all`, `/data` + `/gguf` binds, `PORT`/`GGUF_DIR` env).
// That recipe was itself an image-specific assumption. The profile now carries
// the raw ingredients (binds, ports, devices, env, …) and this module turns
// them into the two artifacts `docker compose` consumes:
//
//   * `docker-compose.yml` — written into the profile's DeployDir. The file is
//     the runtime source of truth: it is (re)written when the profile is saved,
//     bootstrapped when missing, and read back by `docker compose up -d`.
//     Hand edits are therefore honoured until the profile is saved again.
//   * `.env` — the host-held secret channel. The API key never lands in the
//     shareable compose file; `ApiKeyEnv` is emitted as `${STRATA_API_KEY}` and
//     the current key is written into `.env` at start time.
//
// Everything here is dependency-free (a tiny deterministic YAML writer) and the
// pure half (spec → text) is unit-testable without docker.
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as fs from "./fsx.js";
import { imageRef, DEFAULT_MODELS_BIND_DIR } from "./profiles.js";
import { gpuTemplate } from "./gpu.js";

export const COMPOSE_FILE_NAME = "docker-compose.yml";
export const ENV_FILE_NAME = ".env";
export const SERVICE_NAME = "strata";

// Last-resort engine host/container port when the profile leaves both empty
// (kept separate from the general `defaultPort` fallback, which is applied when
// the config is read — see applyActiveProfile in deployer/common.js).
export const FALLBACK_ENGINE_PORT = 8080;

// The variable name the host-owned secret is written into `.env` under. The
// *target* container variable is the profile's ApiKeyEnv; this is only the
// stable interpolation source.
export const API_KEY_SOURCE_VAR = "STRATA_API_KEY";

// Same shape the docker image references accept.
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,255}$/;

function cleanList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const s = String(item ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

// De-duplicated union of two string lists, template entries first.
function unionList(a, b) {
  const out = [];
  for (const item of [...(a || []), ...(b || [])]) {
    const s = String(item ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// The variable name of a `KEY=value` env entry (or the whole entry when it has
// no `=`), used to collapse duplicates by key.
function envKey(entry) {
  const s = String(entry ?? "");
  const i = s.indexOf("=");
  return i < 0 ? s : s.slice(0, i);
}

// Merge the model's required environment with the user's own entries. The
// user wins on a key conflict (an explicit override is intent, not a mistake);
// the template only fills the keys the user left unset. User entries keep their
// order, template extras follow.
export function mergeEnv(templateEnv, userEnv) {
  const seen = new Set();
  const out = [];
  for (const group of [userEnv || [], templateEnv || []]) {
    for (const entry of group) {
      const s = String(entry ?? "").trim();
      if (!s) continue;
      const key = envKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// A filesystem-safe single path segment for the fallback DeployDir.
function segment(value, fallback) {
  const s = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

// Where a profile's docker-compose.yml lives. An explicit DeployDir wins;
// otherwise a stable per-profile folder under the user's home (the profile id
// would be uglier to type, and the container name is what the user recognises).
export function resolveDeployDir(profile) {
  const raw = String(profile?.DeployDir ?? "").trim();
  if (raw) return raw;
  const name = segment(profile?.containerName, "") || segment(profile?.id, "strata");
  return path.join(os.homedir(), ".hanako-localstrata", name);
}

export function composeFilePath(deployDir) {
  return path.join(String(deployDir || "."), COMPOSE_FILE_NAME);
}

export function envFilePath(deployDir) {
  return path.join(String(deployDir || "."), ENV_FILE_NAME);
}

// Normalize a container profile into the flat spec the compose writer, the
// legacy `docker run` fallback and the status payload all consume. The profile
// arriving here is expected to already carry the *effective* ModelDir /
// EnginePort values (applyActiveProfile resolves the general defaults).
export function containerSpec(profile = {}) {
  const enginePort = positiveInt(profile.EnginePort) || FALLBACK_ENGINE_PORT;
  const engineBindPort = positiveInt(profile.EngineBindPort) || positiveInt(profile.EnginePort) || FALLBACK_ENGINE_PORT;
  // The GPU primitives are template-expanded from the card model; `devices`
  // and the model's cgroup rules / env are never stored on the profile.
  const gpu = gpuTemplate(profile?.GpuModel, profile?.GpuIds);
  return {
    serviceName: SERVICE_NAME,
    image: imageRef(profile) || String(profile?.image ?? "").trim(),
    imageName: String(profile?.imageName ?? "").trim(),
    imageTag: String(profile?.imageTag ?? "").trim(),
    containerName: String(profile?.containerName ?? "").trim(),
    modelDir: String(profile?.ModelDir ?? "").trim(),
    modelsBindDir: String(profile?.ModelsBindDir ?? "").trim() || DEFAULT_MODELS_BIND_DIR,
    volumeBinds: cleanList(profile?.VolumeBinds),
    portBinds: cleanList(profile?.PortBinds),
    enginePort,
    engineBindPort,
    gpuModel: gpu.key,
    gpuVendor: gpu.vendor,
    devices: gpu.devices,
    deviceCgroupRules: unionList(gpu.deviceCgroupRules, cleanList(profile?.device_cgroup_rules)),
    deployDevices: gpu.deployDevices,
    // The `--gpus` value for the legacy `docker run` fallback (null = none).
    cliGpus: gpu.cliGpus,
    ulimits: cleanList(profile?.ulimits),
    securityOpt: cleanList(profile?.security_opt),
    // Model env first, user env overriding per key (see mergeEnv).
    environment: mergeEnv(gpu.env, cleanList(profile?.environment)),
    apiKeyEnv: String(profile?.ApiKeyEnv ?? "").trim(),
    deployDir: resolveDeployDir(profile),
  };
}

// The compose `environment` list, with the API-key passthrough appended when the
// profile names a target variable. The value is interpolated from `.env` so the
// compose file itself never carries the secret.
export function specEnvironment(spec) {
  const env = [...(spec?.environment || [])];
  const target = String(spec?.apiKeyEnv || "").trim();
  if (target && !env.some((e) => e.slice(0, e.indexOf("=")) === target)) {
    env.push(`${target}=${"${" + API_KEY_SOURCE_VAR + "}"}`);
  }
  return env;
}

// A JSON double-quoted string is also a valid YAML double-quoted scalar, so this
// is a safe emitter for our keys/values (paths, images, env entries, …).
function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function numericOrQuoted(value) {
  const s = String(value ?? "").trim();
  return /^-?\d+$/.test(s) ? s : yamlScalar(s);
}

function splitUlimit(entry) {
  const eq = entry.indexOf("=");
  if (eq < 0) return { name: entry.trim(), value: "" };
  return { name: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() };
}

// Pure: spec → docker-compose.yml text. Deterministic so a diff is meaningful.
export function renderComposeFile(spec, { profileName = "", generatedAt = null } = {}) {
  const lines = [];
  lines.push(`# Generated by Strata Console${profileName ? ` from profile "${profileName}"` : ""}.`);
  lines.push("# The file is the runtime source of truth: Strata Console writes it when the");
  lines.push("# profile is saved and reads it back on start. Hand edits are honoured until");
  lines.push("# the profile is saved again.");
  if (generatedAt) lines.push(`# generated-at: ${new Date(generatedAt).toISOString()}`);
  lines.push("services:");
  lines.push(`  ${spec.serviceName}:`);
  lines.push(`    image: ${yamlScalar(spec.image)}`);
  lines.push(`    container_name: ${yamlScalar(spec.containerName)}`);
  lines.push("    restart: unless-stopped");

  const ports = [];
  if (spec.enginePort && spec.engineBindPort) ports.push(`${spec.enginePort}:${spec.engineBindPort}`);
  ports.push(...spec.portBinds);
  if (ports.length) {
    lines.push("    ports:");
    for (const p of ports) lines.push(`      - ${yamlScalar(p)}`);
  }

  const volumes = [];
  if (spec.modelDir) volumes.push(`${spec.modelDir}:${spec.modelsBindDir}`);
  volumes.push(...spec.volumeBinds);
  if (volumes.length) {
    lines.push("    volumes:");
    for (const v of volumes) lines.push(`      - ${yamlScalar(v)}`);
  }

  const env = specEnvironment(spec);
  if (env.length) {
    lines.push("    environment:");
    for (const e of env) lines.push(`      - ${yamlScalar(e)}`);
  }

  if (spec.devices.length) {
    lines.push("    devices:");
    for (const d of spec.devices) lines.push(`      - ${yamlScalar(d)}`);
  }
  if (spec.deviceCgroupRules.length) {
    lines.push("    device_cgroup_rules:");
    for (const r of spec.deviceCgroupRules) lines.push(`      - ${yamlScalar(r)}`);
  }

  // ── NVIDIA GPU reservation ───────────────────────────────────────────
  // We emit `deploy.resources.reservations.devices`, not the newer top-level
  // `gpus:` shorthand. Measured on the reference host (Docker 29.9.0 / Compose
  // v5.6.0): both allocate the same GPUs, but `deploy…devices` is part of the
  // Compose Specification, so it parses on every Compose v2, whereas the
  // `gpus:` key requires Compose >= 2.30.0 and is absent from the published
  // schema. It also expresses "all GPUs" and an explicit id list with one shape.
  //   `docker compose config` on the reference host:
  //     deploy…count: all      → {Driver:"nvidia", Count:-1, Capabilities:[["gpu"]]}
  //     deploy…device_ids:[0]  → {Driver:"nvidia", Count:0, DeviceIDs:["0"], …}
  //   the pre-compose `docker run --gpus all` produced {Driver:"", Count:-1}: the
  //   empty driver and "nvidia" resolve to the same allocated set.
  // Minimum compose: any Compose v2 (no 2.30 floor). The legacy `docker run`
  // fallback still passes `--gpus` directly, so a compose-less host is unaffected.
  if (spec.deployDevices?.length) {
    lines.push("    deploy:");
    lines.push("      resources:");
    lines.push("        reservations:");
    lines.push("          devices:");
    for (const d of spec.deployDevices) {
      lines.push(`            - driver: ${yamlScalar(d.driver)}`);
      if (Array.isArray(d.deviceIds) && d.deviceIds.length) {
        lines.push("              device_ids:");
        for (const id of d.deviceIds) lines.push(`                - ${yamlScalar(String(id))}`);
      } else if (d.count != null) {
        lines.push(`              count: ${d.count === "all" ? "all" : numericOrQuoted(d.count)}`);
      }
      lines.push("              capabilities:");
      for (const c of d.capabilities || ["gpu"]) lines.push(`                - ${yamlScalar(c)}`);
    }
  }

  if (spec.securityOpt.length) {
    lines.push("    security_opt:");
    for (const s of spec.securityOpt) lines.push(`      - ${yamlScalar(s)}`);
  }
  if (spec.ulimits.length) {
    lines.push("    ulimits:");
    for (const u of spec.ulimits) {
      const { name, value } = splitUlimit(u);
      if (!name) continue;
      if (value.includes(":")) {
        const [soft, hard] = value.split(":");
        lines.push(`      ${name}:`);
        lines.push(`        soft: ${numericOrQuoted(soft)}`);
        lines.push(`        hard: ${numericOrQuoted(hard)}`);
      } else {
        lines.push(`      ${name}: ${numericOrQuoted(value)}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── File IO (host-side; goes through lib/fsx.js, never node:fs) ───────────

// Write (or overwrite) the compose file for a profile. `force` decides whether
// an existing file — possibly hand-edited — is replaced. Returns the file path.
export function writeComposeFile(profile, { force = false } = {}) {
  const spec = containerSpec(profile);
  const file = composeFilePath(spec.deployDir);
  if (!force && fs.existsSync(file)) return { written: false, file, spec };
  fs.mkdirSync(spec.deployDir);
  const text = renderComposeFile(spec, { profileName: profile?.name || "", generatedAt: Date.now() });
  fs.writeFileSync(file, text);
  return { written: true, file, spec };
}

// Best-effort chmod so `.env` (which holds the key) is not world-readable.
function restrictFile(file) {
  if (process.platform === "win32") return;
  try {
    execFileSync("chmod", ["600", file], { stdio: "ignore", windowsHide: true });
  } catch {
    /* best effort: some filesystems refuse chmod */
  }
}

// Materialize the host-held secret into `.env`. Always written (even empty) when
// the profile names an ApiKeyEnv, so `docker compose up` never warns about an
// unset interpolation variable.
export function writeEnvFile(profile, apiKey, { spec = null } = {}) {
  const s = spec || containerSpec(profile);
  if (!s.apiKeyEnv) return { written: false, file: envFilePath(s.deployDir) };
  const file = envFilePath(s.deployDir);
  fs.mkdirSync(s.deployDir);
  fs.writeFileSync(file, `${API_KEY_SOURCE_VAR}=${String(apiKey ?? "")}\n`);
  restrictFile(file);
  return { written: true, file };
}

export default {
  COMPOSE_FILE_NAME,
  ENV_FILE_NAME,
  FALLBACK_ENGINE_PORT,
  API_KEY_SOURCE_VAR,
  resolveDeployDir,
  composeFilePath,
  envFilePath,
  containerSpec,
  specEnvironment,
  renderComposeFile,
  writeComposeFile,
  writeEnvFile,
};
