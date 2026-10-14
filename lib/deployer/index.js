// lib/deployer/index.js
//
// Deploy-mode selection + the unified façade. routes/ and tools/ keep calling
// the same names on lib/strata.js; lib/strata.js forwards to here, and this
// module picks the local or docker implementation.
//
// 1.1.0 semantics (v1.1-TASK.md — this overrides the earlier `auto` design):
//   * deployMode ∈ {local, docker}. There is no `auto` and no runtime
//     switching. `""` means "the user has not chosen yet".
//   * The very first time, the default is detected from the IMAGE list only
//     (any of `imageNames` / `imageName` exists → docker, else local) and
//     persisted. Every later call honours the stored explicit choice.
//   * Docker mode is Linux-only. Windows always resolves to local.
import { createDockerAdapter, resolveDockerPath } from "../docker.js";
import { createSourceDeployer, sourceSetHostMode, readRecentLogs } from "./source.js";
import {
  createDockerDeployer,
  envMap,
  containerPort,
  containerPublishesPort,
  sampleRunParams,
  dataVolumeFromRunParams,
} from "./docker.js";
import {
  readAllConfig,
  savePluginConfig,
  unsupportedStatus,
  detectionImageNames,
} from "./common.js";

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

async function persistDeployMode(ctx, mode) {
  try {
    await savePluginConfig(ctx, { deployMode: mode });
  } catch {
    /* detection must never fail because the choice could not be written */
  }
}

// First-run default: does any anchor image exist? Detection deliberately does
// NOT look at containers (v1.1-TASK.md #1).
async function detectDefaultByImage(ctx, cfg, opts) {
  const docker = await acquireDocker(ctx, opts);
  if (!docker || typeof docker.imageExists !== "function") return { mode: "local", docker: null };
  for (const name of detectionImageNames(cfg)) {
    if (docker.imageExists(name)) return { mode: "docker", docker };
  }
  return { mode: "local", docker };
}

// Exported for tests. `opts.docker` injects an adapter; `opts.platform`
// injects the OS branch.
export async function resolveDeployMode(ctx, cfg, opts = {}) {
  const platform = platformOf(opts);

  // Docker mode is offered on Linux only (v1.1-TASK.md #6). A stored docker
  // value from a moved config is ignored on other platforms.
  if (platform !== "linux") {
    if (cfg.deployMode === "docker") await persistDeployMode(ctx, "local");
    return { mode: "local", source: "platform", docker: null, info: null };
  }

  if (cfg.deployMode === "local") {
    return { mode: "local", source: "explicit", docker: null, info: null };
  }

  if (cfg.deployMode === "docker") {
    const docker = await acquireDocker(ctx, opts);
    const info = docker ? docker.inspect(cfg.containerName) : null;
    return { mode: "docker", source: "explicit", docker, info };
  }

  // Not chosen yet: detect once from the image list and persist the default.
  const detected = await detectDefaultByImage(ctx, cfg, opts);
  await persistDeployMode(ctx, detected.mode);
  if (detected.mode === "docker") {
    const info = detected.docker ? detected.docker.inspect(cfg.containerName) : null;
    return { mode: "docker", source: "auto-default", docker: detected.docker, info };
  }
  return { mode: "local", source: "auto-default", docker: null, info: null };
}

// Sampling the run parameters early means a later rebuild has everything it
// needs even if the container is removed in the meantime.
async function rememberRunConfig(ctx, cfg, modeInfo) {
  if (modeInfo.mode !== "docker" || !modeInfo.info) return;
  if (cfg.dockerRunConfig) return;
  const sampled = sampleRunParams(modeInfo.info, cfg.imageName);
  const patch = { dockerRunConfig: JSON.stringify(sampled) };
  // Reflect the real /data volume in the config form so editing it later
  // actually changes the recreate.
  const volume = dataVolumeFromRunParams(sampled);
  if (volume) patch.volumeName = volume;
  try {
    await savePluginConfig(ctx, patch);
  } catch {
    /* best effort */
  }
}

export async function getDeployer(ctx, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const modeInfo = await resolveDeployMode(ctx, cfg, opts);
  await rememberRunConfig(ctx, cfg, modeInfo);
  const deployer =
    modeInfo.mode === "docker"
      ? createDockerDeployer({ ctx, cfg, opts, docker: modeInfo.docker, info: modeInfo.info })
      : createSourceDeployer({ ctx, cfg, opts });
  return { cfg, modeInfo, deployer };
}

function withMode(result, modeInfo, platform) {
  if (result && typeof result === "object") {
    if (result.deployMode === undefined) result.deployMode = modeInfo.mode;
    if (result.deployModeSource === undefined) result.deployModeSource = modeInfo.source;
    if (result.platform === undefined) result.platform = platform;
    if (result.supportedDeployModes === undefined) {
      result.supportedDeployModes = platform === "linux" ? ["local", "docker"] : ["local"];
    }
  }
  return result;
}

function unsupportedResult(result) {
  if (result && typeof result === "object") {
    result.platform = "macos";
    result.supportedDeployModes = [];
  }
  return result;
}

// ── Unified interface ─────────────────────────────────────────────────────

export async function detect(ctx, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const modeInfo = await resolveDeployMode(ctx, cfg, opts);
  return modeInfo.mode;
}

export async function getStatus(ctx, opts = {}) {
  const platform = platformOf(opts);
  if (platform === "darwin") return unsupportedResult(unsupportedStatus());
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const status = await deployer.getStatus();
  return withMode(status, modeInfo, platform);
}

export async function startService(ctx, opts = {}) {
  if (platformOf(opts) === "darwin") {
    return unsupportedResult({ started: false, state: "unsupported", error: "Strata 不支持 macOS" });
  }
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const result = await deployer.start();
  return withMode(result, modeInfo, platformOf(opts));
}

export async function stopService(ctx, opts = {}) {
  if (platformOf(opts) === "darwin") {
    return unsupportedResult({ stopped: false, unsupported: true, error: "Strata 不支持 macOS" });
  }
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const result = await deployer.stop();
  return withMode(result, modeInfo, platformOf(opts));
}

export async function restartService(ctx, opts = {}) {
  if (platformOf(opts) === "darwin") {
    return unsupportedResult({
      stop: { stopped: false, unsupported: true, error: "Strata 不支持 macOS" },
      start: { started: false, state: "unsupported", error: "Strata 不支持 macOS" },
    });
  }
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const result = await deployer.restart();
  return withMode(result, modeInfo, platformOf(opts));
}

export async function getConfigView(ctx, opts = {}) {
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const view = await deployer.readConfig();
  if (view && typeof view === "object") view.deployMode = modeInfo.mode;
  return view;
}

export async function applyConfigEdits(ctx, edits, opts = {}) {
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const result = await deployer.writeConfig(edits);
  return withMode(result, modeInfo, platformOf(opts));
}

export async function readLogs(ctx, lineCount = 10, opts = {}) {
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const log = await deployer.readLogs(lineCount);
  return withMode(log, modeInfo, platformOf(opts));
}

export async function updateService(ctx, tag, opts = {}) {
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const result = await deployer.update(tag);
  return withMode(result, modeInfo, platformOf(opts));
}

// ── Mode switching (mutually exclusive, stop-before-switch) ───────────────
//
// The two modes cannot both run on one machine (memory + port). Switching
// therefore stops the currently-running deployment first, persists the new
// fields, and returns the freshly detected status. The UI is responsible for
// asking the user to confirm before calling this.
export async function switchDeployMode(ctx, target, patch = {}, opts = {}) {
  const platform = platformOf(opts);
  if (target !== "local" && target !== "docker") {
    const err = new Error("deployMode 必须是 local 或 docker");
    err.validation = ["deployMode 必须是 local 或 docker"];
    throw err;
  }
  if (target === "docker" && platform !== "linux") {
    const err = new Error("Docker 模式仅支持 Linux");
    err.validation = ["Docker 模式仅支持 Linux"];
    throw err;
  }

  const before = await readAllConfig(ctx);
  const { modeInfo, deployer } = await getDeployer(ctx, opts);
  const switching = modeInfo.mode !== target;

  let stopped = null;
  if (switching) {
    let status = null;
    try {
      status = await deployer.getStatus();
    } catch {
      status = null;
    }
    if (status && (status.state === "running" || status.state === "starting")) {
      stopped = await deployer.stop();
    }
  }

  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) clean[key] = value;
  }
  clean.deployMode = target;
  await savePluginConfig(ctx, clean);

  const status = await getStatus(ctx, opts);
  return { saved: true, deployMode: target, switched: switching, previousMode: modeInfo.mode, stopped, before, status };
}

// host/api_key are read-only in docker mode in 1.1.0 (changing them requires
// recreating the container with REINSTALL=1; too risky to expose from the UI).
export async function setHostMode(ctx, mode, opts = {}) {
  const { modeInfo } = await getDeployer(ctx, opts);
  if (modeInfo.mode === "docker") {
    const err = new Error(
      "Docker 模式不支持从界面切换网络模式：HOST / API_KEY 在容器创建时固化（默认 HOST=0.0.0.0）。请修改容器环境变量后用 REINSTALL=1 重建容器。",
    );
    err.validation = ["docker 模式下 host / api_key 只读"];
    throw err;
  }
  return sourceSetHostMode(ctx, mode);
}

export { readRecentLogs, envMap, containerPort, containerPublishesPort };
