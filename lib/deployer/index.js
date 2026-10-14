// lib/deployer/index.js — profile-based deployer façade.
//
// There is no `deployMode` and no MI50 special case. The active profile's
// `type` decides everything:
//   * type === "local"     → the local source deployer
//   * type === "container" → the generic container deployer
//
// routes/ and tools/ keep calling the same names on lib/strata.js; this module
// only picks the implementation and decorates the result with profile info so
// the UI can show which configuration is in use.
import path from "node:path";
import * as fs from "../fsx.js";
import { createDockerAdapter, resolveDockerPath } from "../docker.js";
import { resolvePython } from "../python.js";
import { profileSummary, profileReady, missingProfileFields } from "../profiles.js";
import { createSourceDeployer, sourceSetHostMode, readRecentLogs } from "./source.js";
import { createContainerDeployer } from "./docker.js";
import { readAllConfig, clearDockerRuntime, unsupportedStatus, savePluginConfig } from "./common.js";

function platformOf(opts) {
  return opts?.platform || process.platform;
}

async function acquireDocker(ctx, opts) {
  // `opts.docker` is injectable for tests; an explicit null/false means
  // "pretend docker is not installed".
  if (opts && Object.prototype.hasOwnProperty.call(opts, "docker")) return opts.docker || null;
  const bin = await resolveDockerPath(ctx);
  if (!bin) return null;
  return createDockerAdapter(bin);
}

// Local (source) readiness: filesystem-only so it is cheap and side-effect
// free. An empty `strataDir` is a legal, non-erroring state.
export function localReadiness(cfg, platform = process.platform) {
  if (platform === "darwin") return { ready: false, reason: "unsupported" };
  if (!String(cfg?.strataDir || "").trim()) return { ready: false, reason: "unconfigured" };
  const serverScript = path.join(cfg.strataDir, "serve", "server.py");
  if (!fs.existsSync(serverScript)) {
    return { ready: false, reason: "not-installed", serverScript };
  }
  const python = resolvePython(cfg);
  if (!python.path) return { ready: false, reason: "python-missing", error: python.error };
  return { ready: true, reason: null, serverScript, python };
}

// Resolve the active profile, its docker handle/state and readiness.
// `opts.docker` / `opts.info` are injectable for tests.
async function resolveDeployment(ctx, cfg, opts = {}) {
  const platform = platformOf(opts);
  const profile = cfg.activeProfile;
  const isContainer = profile?.type === "container";

  const docker = isContainer ? await acquireDocker(ctx, opts) : null;
  let info;
  if (isContainer) {
    if (Object.prototype.hasOwnProperty.call(opts, "info")) {
      info = opts.info;
    } else if (docker && profile?.containerName && typeof docker.inspect === "function") {
      try {
        info = docker.inspect(profile.containerName);
      } catch {
        info = null;
      }
    } else {
      info = null;
    }
  }

  const local = isContainer ? { ready: false, reason: "container" } : localReadiness(cfg, platform);
  const method = isContainer ? "docker" : "local";
  const containerReady = !!docker && !!profile?.image && !!profile?.containerName;
  const canStart = isContainer ? containerReady : local.ready;

  return { platform, profile, isContainer, docker, info, local, method, canStart };
}

function canStartOf(dep) {
  return dep.canStart;
}

// A profile as the UI needs it: its identity plus the readiness rule applied
// server-side. The status payload used to carry only {id,name,type}, so the
// panel could not tell a filled container profile from an empty one and always
// judged every profile "not ready".
function profileView(profile) {
  if (!profile) return null;
  const view = {
    ...profileSummary(profile),
    ready: profileReady(profile),
    missing: missingProfileFields(profile),
  };
  if (profile.type === "container") {
    // The version and service cards both name the image; expose the two fields
    // so they render the same "name:tag" (they used to disagree: "strata:latest"
    // in one, "strata" in the other).
    view.imageName = profile.imageName || "";
    view.imageTag = profile.imageTag || "";
  }
  return view;
}

function profileList(cfg) {
  return (cfg.profiles || []).map(profileView);
}

function decorate(result, cfg, dep) {
  if (result && typeof result === "object") {
    if (result.platform === undefined) result.platform = dep.platform;
    if (result.method === undefined) result.method = dep.method;
    if (result.profile === undefined) result.profile = profileView(dep.profile);
    if (result.profiles === undefined) result.profiles = profileList(cfg);
    if (result.activeProfileId === undefined) result.activeProfileId = cfg.activeProfileId;
    if (result.launch === undefined) {
      result.launch = {
        method: dep.method,
        canStart: canStartOf(dep),
        canChoose: false,
        allowed: [dep.method],
        localReady: dep.local.ready,
        reason: dep.local.ready ? null : dep.local.reason,
      };
    }
  }
  return result;
}

function unsupportedResult(result) {
  if (result && typeof result === "object") {
    result.platform = "macos";
    result.launch = { method: null, canStart: false, canChoose: false, allowed: [], localReady: false, reason: "unsupported" };
    result.profiles = [];
    result.activeProfileId = "";
    result.profile = null;
  }
  return result;
}

function deployerFor(ctx, cfg, dep, opts) {
  if (dep.isContainer) {
    return createContainerDeployer({
      ctx,
      cfg,
      profile: dep.profile,
      opts,
      docker: dep.docker,
      info: dep.info,
    });
  }
  clearDockerRuntime();
  return createSourceDeployer({ ctx, cfg, opts });
}

// Re-read the config with `profileId` active (persisting the choice). Returns
// null when the id does not exist.
async function selectActive(ctx, profileId) {
  const cfg = await readAllConfig(ctx);
  if (!cfg.profiles.some((p) => p.id === profileId)) return null;
  if (cfg.activeProfileId !== profileId) {
    await savePluginConfig(ctx, { activeProfileId: profileId });
  }
  return readAllConfig(ctx);
}

// ── Unified interface ─────────────────────────────────────────────────────

export async function getStatus(ctx, opts = {}) {
  const platform = platformOf(opts);
  if (platform === "darwin") return unsupportedResult(unsupportedStatus());
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const status = await deployer.getStatus();
  return decorate(status, cfg, dep);
}

export async function startService(ctx, opts = {}) {
  const platform = platformOf(opts);
  if (platform === "darwin") {
    return unsupportedResult({ started: false, state: "unsupported", error: "Strata 不支持 macOS" });
  }
  let cfg = await readAllConfig(ctx);
  if (opts.profileId) {
    const selected = await selectActive(ctx, opts.profileId);
    if (selected) cfg = selected;
  }
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const result = await deployer.start();
  return decorate(result, cfg, dep);
}

export async function stopService(ctx, opts = {}) {
  const platform = platformOf(opts);
  if (platform === "darwin") {
    return unsupportedResult({ stopped: false, unsupported: true, error: "Strata 不支持 macOS" });
  }
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const result = await deployer.stop();
  return decorate(result, cfg, dep);
}

export async function restartService(ctx, opts = {}) {
  const platform = platformOf(opts);
  if (platform === "darwin") {
    return unsupportedResult({
      stop: { stopped: false, unsupported: true, error: "Strata 不支持 macOS" },
      start: { started: false, state: "unsupported", error: "Strata 不支持 macOS" },
    });
  }
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const result = await deployer.restart();
  return decorate(result, cfg, dep);
}

export async function getConfigView(ctx, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const view = await deployer.readConfig();
  if (view && typeof view === "object") view.method = dep.method;
  return view;
}

export async function applyConfigEdits(ctx, edits, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const result = await deployer.writeConfig(edits);
  return decorate(result, cfg, dep);
}

export async function readLogs(ctx, lineCount = 10, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  const deployer = deployerFor(ctx, cfg, dep, opts);
  const log = await deployer.readLogs(lineCount);
  return decorate(log, cfg, dep);
}

// host/api_key are read-only for a container profile (changing them requires
// recreating the container; too risky to expose from the UI).
export async function setHostMode(ctx, mode, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const dep = await resolveDeployment(ctx, cfg, opts);
  if (dep.isContainer) {
    const err = new Error(
      "容器配置不支持从界面切换网络模式：HOST / API_KEY 在容器创建时固化（默认 HOST=0.0.0.0）。",
    );
    err.validation = ["容器配置下 host / api_key 只读"];
    throw err;
  }
  return sourceSetHostMode(ctx, mode);
}

// Persist a new active profile (used by routes/settings.js).
export async function selectProfile(ctx, profileId) {
  const cfg = await selectActive(ctx, profileId);
  if (!cfg) {
    const err = new Error("配置不存在");
    err.validation = ["配置不存在"];
    throw err;
  }
  return { activeProfileId: cfg.activeProfileId, profiles: profileList(cfg) };
}

export { readRecentLogs };
