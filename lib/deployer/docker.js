// lib/deployer/docker.js
//
// The "docker" deployer. Strata runs inside an already-created container
// (App never creates one — see v1.1-TASK.md decision #1). Lifecycle is
// docker start/stop/restart, config lives on the /data volume (read/written
// through `docker exec` / `docker cp`), logs are in the container's writable
// layer (`docker exec tail`) and on stdout (`docker logs`).
import os from "node:os";
import path from "node:path";
import * as fs from "../fsx.js";
import {
  FALLBACK_PORT,
  WEB_URL,
  netFetch,
  readAllConfig,
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
  savePluginConfig,
  timestamp,
} from "./common.js";

// ── Pure helpers (exported for detection + tests) ─────────────────────────

// `docker inspect`'s Config.Env (["K=V", …]) → object.
export function envMap(info) {
  const out = {};
  for (const entry of info?.Config?.Env || []) {
    const i = String(entry).indexOf("=");
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

// Mirrors docker-entrypoint.sh:31-33: qwen has an empty family prefix.
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
  const data = String(env?.STRATA_DATA || "/data").replace(/\/+$/, "") || "/data";
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

// Effective host port the App connects to: plugin override → published host
// port → container port → 8080. The published host port matters when the
// mapping is not 1:1 (e.g. -p 9090:8080).
export function deriveDockerPort(cfg, info, env = envMap(info)) {
  const override = pluginPort(cfg);
  if (override) return override;
  const cPort = containerPort(env);
  return publishedHostPort(info, cPort) ?? cPort;
}

export function summarizeContainer(info, containerName) {
  if (!info) {
    return { cli: true, containerName, state: "missing", running: false };
  }
  const state = info.State || {};
  const env = envMap(info);
  return {
    cli: true,
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

// The run parameters we sample once on first contact and persist so a rebuild
// can recreate the container. `--gpus` shows up in inspect as DeviceRequests,
// so it is collapsed back to "all".
export function sampleRunParams(info, fallbackImage = "strata") {
  const hc = info?.HostConfig || {};
  return {
    image: info?.Config?.Image || fallbackImage,
    env: info?.Config?.Env || [],
    binds: hc.Binds || [],
    ports: hc.PortBindings || {},
    restartPolicy: hc.RestartPolicy || null,
    gpus: Array.isArray(hc.DeviceRequests) && hc.DeviceRequests.length ? "all" : null,
    ulimits: hc.Ulimits || [],
    ipcMode: hc.IpcMode || null,
    shmSize: hc.ShmSize || null,
    networkMode: hc.NetworkMode || null,
    privileged: !!hc.Privileged,
  };
}

// Host side of the `/data` bind in a sampled run-params object, or "" when the
// container does not bind /data (e.g. an anonymous volume).
export function dataVolumeFromRunParams(params) {
  for (const bind of params?.binds || []) {
    const parts = String(bind).split(":");
    if (parts.length >= 2 && parts[1] === "/data") return parts[0];
  }
  return "";
}

// Force the configured volume name onto the /data bind. The sampled params are
// the source of truth for everything else, but the config form exposes the
// volume, so the user's value must win on recreate.
function withDataVolume(params, volumeName) {
  if (!volumeName) return params;
  const binds = Array.isArray(params.binds) ? [...params.binds] : [];
  const bind = `${volumeName}:/data`;
  const i = binds.findIndex((b) => String(b).split(":")[1] === "/data");
  if (i >= 0) binds[i] = bind;
  else binds.push(bind);
  return { ...params, binds };
}

// The app mounts the configured GGUF folder at /gguf and exports GGUF_DIR so
// docker-entrypoint.sh runs `setup.py --setup ... --gguf-dir /gguf` (no model
// download). The config form field is authoritative on create/recreate.
const CONTAINER_GGUF_DIR = "/gguf";
function withGgufDir(params, ggufDir) {
  if (!ggufDir) return params;
  const binds = Array.isArray(params.binds) ? [...params.binds] : [];
  const bind = `${ggufDir}:${CONTAINER_GGUF_DIR}`;
  const i = binds.findIndex((b) => {
    const parts = String(b).split(":");
    return parts[1] === CONTAINER_GGUF_DIR;
  });
  if (i >= 0) binds[i] = bind;
  else binds.push(bind);
  const env = (params.env || []).filter((e) => !String(e).startsWith("GGUF_DIR="));
  env.push(`GGUF_DIR=${CONTAINER_GGUF_DIR}`);
  return { ...params, binds, env };
}

// `docker run` argv from sampled params (no `docker` prefix, no leading
// detached flag duplication). Kept pure so it can be unit-tested.
export function buildRunArgs(name, params) {
  const args = ["run", "-d", "--name", name];
  const policy = params?.restartPolicy?.Name;
  if (policy && policy !== "no") args.push("--restart", policy);
  if (params?.gpus) args.push("--gpus", params.gpus);
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
  if (params?.ipcMode) args.push("--ipc", params.ipcMode);
  if (params?.shmSize) args.push("--shm-size", String(params.shmSize));
  if (params?.networkMode && !["default", "bridge"].includes(params.networkMode)) {
    args.push("--network", params.networkMode);
  }
  if (params?.privileged) args.push("--privileged");
  args.push(params?.image || "strata");
  return args;
}

// Stand-in used when the user chooses Docker mode but the docker CLI is not
// installed. Status reports "not-installed" with a clear hint instead of
// throwing; every mutating call fails with the same message.
function missingDockerAdapter() {
  const fail = () => {
    throw new Error("未找到 docker 命令，无法管理容器（请安装 Docker 或改用本机模式）");
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
    build: fail,
    raw: fail,
  };
}

// Run parameters for a brand-new container when there is no container to
// sample from yet. They mirror the official `docker run` recipe
// (docs/INSTALL.md): `--gpus all`, the /data volume, memlock and the published
// port. The user only names the image, the container and the volume; the rest
// is deliberately not exposed as free-form input.
export function defaultRunParams(cfg, port = FALLBACK_PORT) {
  const image = cfg?.imageName || "strata";
  const binds = cfg?.volumeName ? [`${cfg.volumeName}:/data`] : [];
  // STRATA_DATA is the entrypoint's config/data root (default /data anyway);
  // GGUF_DIR lets the first start skip the model download.
  const env = ["STRATA_DATA=/data"];
  if (cfg?.ggufDir) {
    binds.push(`${cfg.ggufDir}:${CONTAINER_GGUF_DIR}`);
    env.push(`GGUF_DIR=${CONTAINER_GGUF_DIR}`);
  }
  return {
    image,
    env,
    binds,
    ports: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] },
    restartPolicy: { Name: "unless-stopped" },
    gpus: "all",
    ulimits: [{ Name: "memlock", Soft: -1, Hard: -1 }],
    ipcMode: null,
    shmSize: null,
    networkMode: null,
    privileged: false,
  };
}

// ── Deployer ──────────────────────────────────────────────────────────────

export function createDockerDeployer({ ctx, cfg, opts = {}, docker, info } = {}) {
  const platform = opts.platform || process.platform;
  const containerName = cfg.containerName;
  const stopTimeout = cfg.dockerStopTimeoutSec;

  if (!docker) docker = missingDockerAdapter();

  function inspect() {
    if (info !== undefined) return info;
    return docker.inspect(containerName);
  }

  function dockerAvailable() {
    return !(typeof docker.available === "function") || docker.available();
  }

  // Persist the run parameters so a later update can recreate the container
  // even after the original one is gone. Best effort: never fail a lifecycle
  // action because the memo could not be written.
  async function persistRunConfig(params) {
    try {
      await savePluginConfig(ctx, { dockerRunConfig: JSON.stringify(params) });
    } catch {
      /* best effort */
    }
  }

  // Effective run parameters for create/recreate: the memo first (it was
  // sampled from the real container), then the live container, then the
  // official default recipe. The image always follows the configured one so an
  // update actually swaps the image.
  function resolveRunParams() {
    const image = cfg.imageName || "strata";
    const stored = parseJsonText(cfg.dockerRunConfig);
    let params;
    if (stored && typeof stored === "object") params = { ...stored, image };
    else {
      const current = inspect();
      if (current) params = { ...sampleRunParams(current, image), image };
      else return withGgufDir(withDataVolume(defaultRunParams(cfg, pluginPort(cfg) || FALLBACK_PORT), cfg.volumeName), cfg.ggufDir);
    }
    return withGgufDir(withDataVolume(params, cfg.volumeName), cfg.ggufDir);
  }

  function createContainer(params) {
    const image = cfg.imageName || params.image || "strata";
    return docker.raw(buildRunArgs(containerName, { ...params, image }));
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
    if (dockerMissing) summary.cli = false;

    // The image is the deployment anchor in 1.1.0: the first-run default is
    // docker when the image exists, and Docker mode can create the container
    // from it. Surface the tag/build time for the version panel.
    const imageInfo =
      dockerMissing || typeof docker.imageInspect !== "function" ? null : docker.imageInspect(cfg.imageName || "strata");
    const imageVersion = imageInfo
      ? { tag: imageInfo.RepoTags?.[0] || cfg.imageName || null, created: imageInfo.Created || null }
      : null;

    const buildBase = () => {
      const env = current ? envMap(current) : {};
      const configPath = current ? containerConfigPath(env) : null;
      const mainName = configPath ? path.posix.basename(configPath) : null;
      const sharedName = mainName ? mainName.replace(/\.json$/, "") + ".shared-settings.json" : null;
      return { env, configPath, mainName, sharedName, port: current ? deriveDockerPort(cfg, current, env) : FALLBACK_PORT };
    };
    const { env, mainName, sharedName, port } = buildBase();

    const settings = {
      strataDir: cfg.strataDir || "",
      pythonPath: cfg.pythonPath || "",
      configFile: mainName || cfg.configFile || "",
      ggufDir: cfg.ggufDir || "",
      port: pluginPort(cfg),
      containerName,
      imageName: cfg.imageName || "",
      imageNames: Array.isArray(cfg.imageNames) ? cfg.imageNames : [],
      volumeName: cfg.volumeName || "",
      dockerStopTimeoutSec: stopTimeout,
    };

    const base = {
      state: "stopped",
      port,
      webUrl: WEB_URL(port),
      refreshSec: cfg.refreshSec,
      resources: readResources(platform),
      checkedAt: Date.now(),
      settings,
      version: { local: null, ...versionCheck },
      imageVersion,
      docker: { ...summary, imageVersion },
    };

    if (!current) {
      if (dockerMissing) {
        return {
          ...base,
          state: "not-installed",
          error: "未找到 docker 命令，无法管理容器（请安装 Docker 或改用本机模式）",
        };
      }
      if (!imageInfo) {
        return {
          ...base,
          state: "not-installed",
          error: `未找到镜像 ${cfg.imageName || "strata"}，请先 docker build / docker pull`,
        };
      }
      // Image present, container not created yet: Docker mode can create it
      // from the sampled/default run parameters when the user presses start.
      return { ...base, state: "stopped" };
    }

    const { mainText, sharedText } = await readConfigText();
    const apiKey = configApiKey(cfg, env, mainText);
    rememberDockerRuntime(containerName, { port, apiKey });

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

    // Container not running → stopped (with exit code for the UI).
    if (!summary.running) {
      return {
        ...readyBase,
        state: "stopped",
        docker: { ...summary, exitCode: Number.isInteger(summary.exitCode) ? summary.exitCode : null },
      };
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

    // Running container whose HTTP API is not answering yet: model load takes
    // minutes (Dockerfile healthcheck start-period is 600s).
    return { ...readyBase, state: "starting" };
  }

  async function start() {
    const status = await getStatus();
    if (status.state === "running" || status.state === "starting") {
      return { started: false, already: true, state: status.state, ...status };
    }
    if (status.state === "not-installed") {
      return { started: false, state: "not-installed", error: status.error };
    }
    if (!dockerAvailable()) {
      return { started: false, state: "not-installed", error: "未找到 docker 命令，无法启动容器" };
    }

    // App owns deployment: when the container does not exist yet, create it
    // from the sampled/default run parameters (v1.1.0 principle).
    if (!inspect()) {
      const params = resolveRunParams();
      const runRes = createContainer(params);
      if (!runRes.ok) {
        return { started: false, state: "stopped", error: (runRes.stderr || runRes.stdout || "docker run 失败").trim() };
      }
      await persistRunConfig({ ...params, image: cfg.imageName || params.image });
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
    const res = docker.stop(containerName, stopTimeout);
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
    const res = docker.restart(containerName, stopTimeout);
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
    const sharedName = path.posix.basename(containerConfigPath(env)).replace(/\.json$/, "") + ".shared-settings.json";
    const before = buildConfigView({ configFile: path.posix.basename(containerConfigPath(env)), mainName: path.posix.basename(containerConfigPath(env)), sharedName, mainText, sharedText }).values;

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
      const tmp = path.join(os.tmpdir(), `hanako-strata-${process.pid}-${Date.now()}-${path.posix.basename(containerPath)}`);
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

  // 1.1.0 update: swap the image (rebuild from the source checkout when one is
  // configured) and recreate the container from the sampled/default run
  // parameters. The App owns creation in 1.1.0; a failed recreate rolls the
  // previous container back under its original name.
  async function update() {
    if (!dockerAvailable()) throw new Error("未找到 docker 命令，无法更新容器");

    const current = inspect();
    const params = resolveRunParams();
    const image = cfg.imageName || params.image || "strata";

    let built = false;
    if (cfg.strataDir && fs.existsSync(path.join(cfg.strataDir, "Dockerfile"))) {
      const buildRes = docker.build(image, cfg.strataDir);
      if (!buildRes.ok) throw new Error(`docker build 失败: ${(buildRes.stderr || buildRes.stdout || "").trim()}`);
      built = true;
    }

    if (!current) {
      const runRes = createContainer({ ...params, image });
      if (!runRes.ok) throw new Error(`docker run 失败: ${(runRes.stderr || runRes.stdout || "").trim()}`);
      await persistRunConfig({ ...params, image });
      return { done: true, method: built ? "build+create" : "create", container: containerName };
    }

    // Keep the previous container around under a suffix so a failed recreate
    // can be rolled back by hand; App never deletes the only good container.
    const previousName = `${containerName}.prev-${timestamp()}`;
    if (current.State?.Running) docker.stop(containerName, stopTimeout);
    const rename = docker.raw(["rename", containerName, previousName]);
    if (!rename.ok) throw new Error(`重命名旧容器失败: ${(rename.stderr || rename.stdout || "").trim()}`);

    const runRes = createContainer({ ...params, image });
    if (!runRes.ok) {
      const error = (runRes.stderr || runRes.stdout || "").trim();
      // Best-effort rollback: bring the old container back under its name.
      docker.raw(["rm", "-f", containerName]);
      docker.raw(["rename", previousName, containerName]);
      docker.start(containerName);
      const err = new Error(`重建容器失败，已尝试回滚: ${error}`);
      err.rollbackHint = `旧容器已恢复为 ${containerName}`;
      throw err;
    }
    await persistRunConfig({ ...params, image });

    return {
      done: true,
      method: built ? "build+recreate" : "recreate",
      container: containerName,
      previousContainer: previousName,
    };
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
