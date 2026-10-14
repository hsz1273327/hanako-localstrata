// lib/deployer/docker.js — the generic container deployer.
//
// A `container` profile is just another way to run Strata: the app manages a
// named container by image, tracking its config/logs through `docker exec` /
// `docker cp`. There is no MI50-specific recipe and no image build/rebuild
// pipeline: the container profile stores image/containerName/dataDir/ggufDir/
// port, and the app creates the container from a generic Strata recipe when it
// does not exist yet (or, for special hardware, the user can pre-create it).
import os from "node:os";
import path from "node:path";
import * as fs from "../fsx.js";
import {
  FALLBACK_PORT,
  WEB_URL,
  netFetch,
  pluginPort,
  toNum,
  buildConfigView,
  configSummaryFromText,
  buildNetwork,
  parseJsonText,
  parseMetrics,
  logLinesFromText,
  EMPTY_METRICS,
  getLatestVersion,
  validateEdits,
  renderConfigEdits,
  DOCKER_EDIT_KEYS,
  rememberDockerRuntime,
  readResources,
  timestamp,
  resolveApiKey,
} from "./common.js";

const CONTAINER_STOP_TIMEOUT_SEC = 60;
const CONTAINER_GGUF_DIR = "/gguf";
const CONTAINER_DATA_DIR = "/data";

function namedVolume(profile) {
  const name = String(profile?.containerName || "").trim() || "strata";
  return `${name}-data`;
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

// `docker inspect`'s Config.Env (["K=V", …]) → object.
export function envMap(info) {
  const out = {};
  for (const entry of info?.Config?.Env || []) {
    const i = String(entry).indexOf("=");
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

// Mirrors docker-entrypoint.sh: qwen has an empty family prefix.
export function containerTag(env) {
  const fam = env?.FAMILY || "qwen";
  const model = env?.MODEL || "IQ2_XS";
  const prefix = fam === "qwen" ? "" : `${fam}-`;
  return `${prefix}${String(model).toLowerCase()}`;
}

// Volume config path: explicit CONFIG wins, else
// $STRATA_DATA/config/strata-<tag>.json.
export function containerConfigPath(env) {
  if (env?.CONFIG && String(env.CONFIG).trim()) return String(env.CONFIG).trim();
  const data = String(env?.STRATA_DATA || CONTAINER_DATA_DIR).replace(/\/+$/, "") || CONTAINER_DATA_DIR;
  return `${data}/config/strata-${containerTag(env)}.json`;
}

// The container-internal listening port (entrypoint default 8080).
export function containerPort(env) {
  const p = toNum(env?.PORT);
  return Number.isInteger(p) && p > 0 ? p : FALLBACK_PORT;
}

// First non-empty host binding for a container port, or null.
export function publishedHostPort(info, cPort) {
  const bindings = info?.NetworkSettings?.Ports?.[`${cPort}/tcp`];
  if (!Array.isArray(bindings) || !bindings.length) return null;
  const chosen = bindings.find((b) => b && b.HostPort) || bindings[0];
  const hostPort = toNum(chosen?.HostPort);
  return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
}

export function containerPublishesPort(info, cPort) {
  const bindings = info?.NetworkSettings?.Ports?.[`${cPort}/tcp`];
  return Array.isArray(bindings) && bindings.some((b) => b && b.HostPort);
}

// Effective host port the App connects to: profile override → published host
// port → container port → 8080.
export function deriveDockerPort(profile, info, env = envMap(info)) {
  const override = pluginPort(profile);
  if (override) return override;
  const cPort = containerPort(env);
  return publishedHostPort(info, cPort) ?? cPort;
}

export function summarizeContainer(info, containerName) {
  if (!info) {
    return { containerName, state: "missing", running: false, image: null };
  }
  const state = info.State || {};
  const env = envMap(info);
  return {
    containerName,
    id: info.Id ? String(info.Id).slice(0, 12) : null,
    name: String(info.Name || containerName).replace(/^\//, ""),
    image: info.Config?.Image || null,
    state: String(state.Status || "unknown").toLowerCase(),
    running: !!state.Running,
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null,
    ports: info.NetworkSettings?.Ports || null,
    env,
  };
}

function configApiKey(cfg, env, mainText) {
  const fromPlugin = String(cfg?.apiKey || "").trim();
  if (fromPlugin) return fromPlugin;
  const fromEnv = String(env?.API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const main = parseJsonText(mainText);
  if (main && main.api_key !== undefined && main.api_key !== null && main.api_key !== "") {
    return String(main.api_key).trim();
  }
  return "";
}

// Log file: the config's `log` field when present, else ROOT=/opt/strata.
export function deriveLogPath(env, mainText) {
  const main = parseJsonText(mainText);
  if (main && typeof main.log === "string" && main.log.trim()) return main.log.trim();
  return `/opt/strata/strata-${containerTag(env)}.log`;
}

// The generic Strata run recipe used when the container does not exist yet:
// NVIDIA GPUs via `--gpus all`, the host directory (or named volume) mounted
// at /data, the GGUF folder at /gguf with GGUF_DIR, and the published port.
// Special hardware (e.g. AMD ROCm community images) can be used by
// pre-creating the container; the app then only starts/stops it.
export function defaultRunParams(profile, port = FALLBACK_PORT) {
  const dataDir = String(profile?.dataDir || "").trim();
  const binds = [dataDir ? `${dataDir}:${CONTAINER_DATA_DIR}` : `${namedVolume(profile)}:${CONTAINER_DATA_DIR}`];
  const env = [
    `STRATA_DATA=${CONTAINER_DATA_DIR}`,
    "HOST=0.0.0.0",
    `PORT=${port}`,
  ];
  const ggufDir = String(profile?.ggufDir || "").trim();
  if (ggufDir) {
    binds.push(`${ggufDir}:${CONTAINER_GGUF_DIR}`);
    env.push(`GGUF_DIR=${CONTAINER_GGUF_DIR}`);
  }
  return {
    image: String(profile?.image || "").trim(),
    env,
    binds,
    ports: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] },
    restartPolicy: { Name: "unless-stopped" },
    gpus: "all",
    ulimits: [{ Name: "memlock", Soft: -1, Hard: -1 }],
    privileged: false,
  };
}

// `docker run` argv from run params (no `docker` prefix). Pure, unit-testable.
export function buildRunArgs(name, params) {
  const args = ["run", "-d", "--name", name];
  const policy = params?.restartPolicy?.Name;
  if (policy && policy !== "no") args.push("--restart", policy);
  if (params?.gpus) args.push("--gpus", params.gpus);
  for (const dev of params?.devices || []) args.push("--device", dev);
  for (const g of params?.groupAdd || []) args.push("--group-add", g);
  for (const opt of params?.securityOpt || []) args.push("--security-opt", opt);
  if (params?.ipcMode) args.push("--ipc", params.ipcMode);
  for (const bind of params?.binds || []) args.push("-v", bind);
  for (const [containerPortKey, bindings] of Object.entries(params?.ports || {})) {
    const cPort = containerPortKey.split("/")[0];
    for (const b of bindings || []) {
      if (!b || !b.HostPort) continue;
      const hostIp = b.HostIp && b.HostIp !== "0.0.0.0" ? `${b.HostIp}:` : "";
      args.push("-p", `${hostIp}${b.HostPort}:${cPort}`);
    }
  }
  for (const entry of params?.env || []) {
    if (typeof entry === "string" && entry.includes("=")) args.push("-e", entry);
  }
  for (const u of params?.ulimits || []) {
    if (u?.Name) args.push("--ulimit", `${u.Name}=${u.Soft}:${u.Hard}`);
  }
  if (params?.privileged) args.push("--privileged");
  args.push(params?.image || "");
  return args;
}

// Stand-in used when a container profile is active but docker is missing.
function missingDockerAdapter() {
  const fail = () => {
    throw new Error("未找到 docker 命令，无法管理容器（请安装 Docker 或改用本机配置）");
  };
  return {
    available: () => false,
    inspect: () => null,
    imageInspect: () => null,
    imageExists: () => false,
    env: () => ({}),
    start: fail,
    stop: fail,
    restart: fail,
    logs: () => "",
    exec: fail,
    execRaw: fail,
    cp: fail,
    catFile: () => null,
    pull: fail,
    raw: fail,
  };
}

// ── Deployer ──────────────────────────────────────────────────────────────

export function createContainerDeployer({ ctx, cfg, profile, opts = {}, docker, info } = {}) {
  const platform = opts.platform || process.platform;
  const containerName = String(profile?.containerName || "").trim();

  if (!docker) docker = missingDockerAdapter();

  function inspect() {
    if (info !== undefined) return info;
    if (!containerName) return null;
    return docker.inspect(containerName);
  }

  function dockerAvailable() {
    return !(typeof docker.available === "function") || docker.available();
  }

  // Read a file from the container. `docker exec` works only while running;
  // fall back to `docker cp ... -` so a stopped container's config is still
  // readable.
  function readFileInContainer(filePath) {
    try {
      return docker.exec(containerName, ["cat", filePath]);
    } catch {
      if (typeof docker.catFile === "function") {
        const text = docker.catFile(containerName, filePath);
        if (text !== null && text !== undefined) return text;
      }
      return null;
    }
  }

  async function readConfigText() {
    const current = inspect();
    if (!current) return { mainText: null, sharedText: null, mainName: null, sharedName: null, env: {} };
    const env = envMap(current);
    const configPath = containerConfigPath(env);
    const mainName = path.posix.basename(configPath);
    const sharedName = mainName.replace(/\.json$/, "") + ".shared-settings.json";
    const sharedPath = path.posix.join(path.posix.dirname(configPath), sharedName);
    const mainText = readFileInContainer(configPath);
    const sharedText = readFileInContainer(sharedPath);
    return { mainText, sharedText, mainName, sharedName, env };
  }

  async function readLogs(lineCount = 10, pre = {}) {
    let env = pre.env;
    let mainText = pre.mainText;
    if (!env || mainText === undefined) {
      const read = await readConfigText();
      env = read.env;
      mainText = read.mainText;
    }
    const logPath = deriveLogPath(env, mainText);
    let engineText = "";
    try {
      engineText = docker.exec(containerName, ["tail", "-c", "524288", logPath]);
    } catch {
      /* log file may not exist yet */
    }
    const stdoutText = docker.logs(containerName, Math.max(50, lineCount));
    const text = engineText || stdoutText;
    const metrics = text ? parseMetrics(text) : { ...EMPTY_METRICS };
    return {
      file: path.posix.basename(logPath),
      lines: logLinesFromText(text, lineCount),
      metrics,
    };
  }

  async function getStatus() {
    const versionCheck = getLatestVersion(ctx);
    const dockerMissing = typeof docker.available === "function" && !docker.available();
    const current = dockerMissing ? null : inspect();
    const summary = summarizeContainer(current, containerName);
    summary.cli = !dockerMissing;

    const imageInfo =
      dockerMissing || typeof docker.imageInspect !== "function" || !profile?.image
        ? null
        : docker.imageInspect(profile.image);
    const imageVersion = imageInfo
      ? { tag: imageInfo.RepoTags?.[0] || profile.image, created: imageInfo.Created || null }
      : null;

    const env = current ? envMap(current) : {};
    const configPath = current ? containerConfigPath(env) : null;
    const mainName = configPath ? path.posix.basename(configPath) : null;
    const sharedName = mainName ? mainName.replace(/\.json$/, "") + ".shared-settings.json" : null;
    const port = current ? deriveDockerPort(profile, current, env) : pluginPort(profile) || FALLBACK_PORT;

    const settings = {
      configFile: mainName || "",
      ggufDir: profile?.ggufDir || "",
      dataDir: profile?.dataDir || "",
      image: profile?.image || "",
      containerName,
      port: pluginPort(profile),
    };

    const base = {
      state: "stopped",
      port,
      webUrl: WEB_URL(port),
      refreshSec: cfg?.refreshSec,
      resources: readResources(platform),
      checkedAt: Date.now(),
      settings,
      version: { local: null, ...versionCheck },
      imageVersion,
      docker: { ...summary, imageVersion },
    };

    if (!profile?.containerName || !profile?.image) {
      return {
        ...base,
        state: "not-installed",
        error: "容器配置不完整：请填写镜像名与容器名",
      };
    }

    if (!current) {
      if (dockerMissing) {
        return {
          ...base,
          state: "not-installed",
          error: "未找到 docker 命令，无法管理容器（请安装 Docker 或改用本机配置）",
        };
      }
      if (!imageInfo && typeof docker.imageExists === "function" && !docker.imageExists(profile.image)) {
        return {
          ...base,
          state: "not-installed",
          error: `未找到镜像 ${profile.image}，启动时将尝试 docker pull`,
        };
      }
      // Image present, container not created yet: start can create it.
      return { ...base, state: "stopped" };
    }

    const { mainText, sharedText } = await readConfigText();
    const apiKey = configApiKey(cfg, env, mainText);
    rememberDockerRuntime({ port, apiKey });

    const configView = buildConfigView({
      configFile: mainName,
      mainName,
      sharedName,
      mainText,
      sharedText,
    });
    const network = buildNetwork({
      port,
      platform,
      fallbackHost: String(env.HOST || "0.0.0.0"),
      apiKey,
      published: containerPublishesPort(current, containerPort(env)),
    });
    let log = { file: null, lines: [], metrics: { ...EMPTY_METRICS } };
    try {
      log = await readLogs(10, { env, mainText });
    } catch {
      /* logs are best-effort */
    }
    const readyBase = {
      ...base,
      configFile: mainName,
      hasConfig: mainText !== null && mainText !== undefined,
      network,
      metrics: log.metrics,
      log: { file: log.file, lines: log.lines },
      configSummary: mainText !== null ? configSummaryFromText(mainText, sharedText) : null,
      values: configView.values,
    };

    if (!summary.running) {
      return { ...readyBase, state: "stopped" };
    }

    // Running: the HTTP contract is unchanged. 401/403 still means "up".
    try {
      const res = await netFetch(ctx, `http://127.0.0.1:${port}/v1/status`, {
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
      if (res.status === 401 || res.status === 403) {
        return { ...readyBase, state: "running", authFailed: true };
      }
    } catch {
      /* still loading */
    }

    return { ...readyBase, state: "starting" };
  }

  async function ensureImage() {
    if (!profile?.image) return false;
    if (typeof docker.imageExists !== "function" || docker.imageExists(profile.image)) return true;
    if (typeof docker.pull !== "function") return false;
    const res = docker.pull(profile.image);
    return !!(res && res.ok);
  }

  async function start() {
    const status = await getStatus();
    if (status.state === "running" || status.state === "starting") {
      return { started: false, already: true, state: status.state, ...status };
    }
    if (!profile?.image || !profile?.containerName) {
      return { started: false, state: "not-installed", error: "容器配置不完整：请填写镜像名与容器名" };
    }
    if (!dockerAvailable()) {
      return { started: false, state: "not-installed", error: "未找到 docker 命令，无法启动容器" };
    }

    if (!inspect()) {
      const pulled = await ensureImage();
      if (!pulled && !(typeof docker.imageExists === "function" && docker.imageExists(profile.image))) {
        return {
          started: false,
          state: "not-installed",
          error: `未找到镜像 ${profile.image}，且 docker pull 失败`,
        };
      }
      const params = defaultRunParams(profile, pluginPort(profile) || FALLBACK_PORT);
      const runRes = docker.raw(buildRunArgs(containerName, params));
      if (!runRes.ok) {
        return {
          started: false,
          state: "stopped",
          error: (runRes.stderr || runRes.stdout || "docker run 失败").trim(),
        };
      }
      return { started: true, state: "starting", container: containerName, created: true };
    }

    const res = docker.start(containerName);
    if (!res.ok) {
      return { started: false, state: "stopped", error: (res.stderr || res.stdout || "docker start 失败").trim() };
    }
    return { started: true, state: "starting", container: containerName };
  }

  async function stop() {
    const current = inspect();
    if (!current) {
      return { stopped: false, state: "not-installed", error: `未找到容器 ${containerName}` };
    }
    const res = docker.stop(containerName, CONTAINER_STOP_TIMEOUT_SEC);
    if (!res.ok) {
      return { stopped: false, error: (res.stderr || res.stdout || "docker stop 失败").trim() };
    }
    return { stopped: true, container: containerName };
  }

  async function restart() {
    const current = inspect();
    if (!current) {
      const startResult = await start();
      return {
        stop: { stopped: false, error: `未找到容器 ${containerName}` },
        start: startResult,
      };
    }
    const res = docker.restart(containerName, CONTAINER_STOP_TIMEOUT_SEC);
    if (!res.ok) {
      const error = (res.stderr || res.stdout || "docker restart 失败").trim();
      return { stop: { stopped: false, error }, start: { started: false, error } };
    }
    return {
      stop: { stopped: true, container: containerName },
      start: { started: true, state: "starting", container: containerName },
    };
  }

  async function readConfig() {
    const { mainText, sharedText, mainName, sharedName } = await readConfigText();
    return buildConfigView({ configFile: mainName, mainName, sharedName, mainText, sharedText });
  }

  async function writeConfig(edits) {
    if (!inspect()) throw new Error(`未找到容器 ${containerName}，无法保存配置`);
    const { clean, errors } = validateEdits(edits, DOCKER_EDIT_KEYS);
    if (errors.length) {
      const err = new Error(errors.join("; "));
      err.validation = errors;
      throw err;
    }

    const { mainText, sharedText, env } = await readConfigText();
    if (mainText === null) throw new Error("容器内配置文件读取失败，无法保存");
    const mainName = path.posix.basename(containerConfigPath(env));
    const sharedName = mainName.replace(/\.json$/, "") + ".shared-settings.json";
    const before = buildConfigView({ configFile: mainName, mainName, sharedName, mainText, sharedText }).values;

    const result = renderConfigEdits({
      clean,
      before,
      mainText,
      sharedText: sharedText ?? "{}",
      keys: DOCKER_EDIT_KEYS,
    });
    if (!result.diff.length) {
      return { saved: false, diff: [], backups: [], restartRequired: false, note: "没有变化" };
    }

    const baseDir = path.posix.dirname(containerConfigPath(env));
    const mainPath = containerConfigPath(env);
    const sharedPath = path.posix.join(baseDir, sharedName);
    const backups = [];

    const pushBackup = (containerPath) => {
      const name = `${containerPath}.bak-${timestamp()}`;
      const res = docker.execRaw(containerName, ["cp", containerPath, name]);
      if (!res.ok) throw new Error(`容器内备份失败: ${(res.stderr || res.stdout || "").trim()}`);
      backups.push(path.posix.basename(name));
    };

    const writeIn = (containerPath, text) => {
      const tmp = path.join(
        os.tmpdir(),
        `hanako-strata-${process.pid}-${Date.now()}-${path.posix.basename(containerPath)}`,
      );
      try {
        fs.writeFileSync(tmp, text);
        const res = docker.cp(tmp, `${containerName}:${containerPath}`);
        if (!res.ok) throw new Error(`写入容器配置失败: ${(res.stderr || res.stdout || "").trim()}`);
      } finally {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best effort */
        }
      }
    };

    if (result.mainOps.length) {
      pushBackup(mainPath);
      writeIn(mainPath, result.newMainText);
    }
    if (result.sharedOps.length) {
      pushBackup(sharedPath);
      writeIn(sharedPath, result.newSharedText);
    }

    return { saved: true, diff: result.diff, backups, restartRequired: result.restartRequired };
  }

  // No in-app image build/rebuild pipeline: the app only manages the existing
  // container. Rebuild it out of band (pull/build + recreate) then restart.
  async function update() {
    const err = new Error("容器配置不支持应用内更新：请在应用外更新镜像/重建容器后重启");
    err.notSupported = true;
    throw err;
  }

  return {
    mode: "docker",
    detect: async () => "docker",
    getStatus,
    start,
    stop,
    restart,
    readConfig,
    writeConfig,
    readLogs,
    update,
  };
}

// Re-exported so callers that only need the effective key do not have to reach
// into common.js directly.
export { resolveApiKey };
