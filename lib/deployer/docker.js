// lib/deployer/docker.js — the container deployer.
//
// A `container` profile is just another way to run Strata. The profile carries
// the raw ingredients (image, binds, ports, devices, env, …); this deployer
// turns them into a docker-compose.yml and manages the deployment with
// `docker compose` (up / stop / restart / logs), tracking the config through
// `docker exec` / `docker cp` as before. There is no MI50-specific recipe and
// no image build/rebuild pipeline.
//
// Two fallbacks keep older installs working:
//   * no `docker compose` on the host → the legacy `docker run` / `docker
//     start` / `docker stop` lifecycle (built from the same spec).
//   * a container created by an earlier release (no compose labels) → kept on
//     the legacy lifecycle, because `docker compose up` cannot adopt a foreign
//     container name.
import os from "node:os";
import path from "node:path";
import * as fs from "../fsx.js";
import {
  containerSpec,
  composeFilePath,
  writeComposeFile,
  writeEnvFile,
  dedupeMounts,
} from "../compose.js";
import {
  FALLBACK_PORT,
  WEB_URL,
  netFetch,
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
const CONTAINER_DATA_DIR = "/data";

// The engine host port a container profile asks for (already resolved with the
// general defaultPort fallback by applyActiveProfile).
function profileEnginePort(profile) {
  const p = toNum(profile?.EnginePort);
  return Number.isInteger(p) && p > 0 ? p : null;
}

// A container compose created carries the project label; anything else was
// created by `docker run` (an earlier release) and must not be re-created by
// `docker compose up` (the fixed container_name would conflict).
export function isComposeManaged(info) {
  return !!info?.Config?.Labels?.["com.docker.compose.project"];
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
  const data =
    String(env?.STRATA_DATA || env?.DATA_DIR || CONTAINER_DATA_DIR).replace(/\/+$/, "") ||
    CONTAINER_DATA_DIR;
  return `${data}/config/strata-${containerTag(env)}.json`;
}

// The container-internal listening port. The official image reads `PORT`; the
// MI50 community image reads `ENGINE_PORT`. Either wins over the 8080 default.
export function containerPort(env) {
  for (const key of ["ENGINE_PORT", "PORT"]) {
    const p = toNum(env?.[key]);
    if (Number.isInteger(p) && p > 0) return p;
  }
  return FALLBACK_PORT;
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
  const override = profileEnginePort(profile);
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

// `name=soft:hard` / `name=value` → the docker-CLI ulimit triple.
export function parseUlimitEntry(entry) {
  const text = String(entry ?? "").trim();
  const eq = text.indexOf("=");
  if (eq < 0) return null;
  const Name = text.slice(0, eq).trim();
  const value = text.slice(eq + 1).trim();
  if (!Name || !value) return null;
  if (value.includes(":")) {
    const [soft, hard] = value.split(":");
    const s = Number(soft);
    const h = Number(hard);
    return { Name, Soft: Number.isFinite(s) ? s : soft, Hard: Number.isFinite(h) ? h : hard };
  }
  const n = Number(value);
  return { Name, Soft: Number.isFinite(n) ? n : value, Hard: Number.isFinite(n) ? n : value };
}

// The legacy `docker run` recipe, used only when `docker compose` is not
// available. It is built from the same profile spec the compose file is, so the
// two paths can never disagree about binds / ports / devices / env.
export function defaultRunParams(profile, { apiKey = "" } = {}) {
  const spec = containerSpec(profile);
  const binds = [];
  if (spec.modelDir) binds.push(`${spec.modelDir}:${spec.modelsBindDir}`);
  binds.push(...spec.volumeBinds);
  const env = [...spec.environment];
  if (spec.apiKeyEnv && apiKey) env.push(`${spec.apiKeyEnv}=${apiKey}`);
  return {
    image: spec.image,
    env,
    // Deduped exactly like the compose file, so the two paths agree on the
    // mount set (see compose.dedupeMounts).
    binds: dedupeMounts(binds),
    ports: {
      [`${spec.engineBindPort}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(spec.enginePort) }],
    },
    portBinds: spec.portBinds,
    // The GPU primitives come from the vendor template (never the profile).
    gpus: spec.cliGpus,
    devices: spec.devices,
    deviceCgroupRules: spec.deviceCgroupRules,
    securityOpt: spec.securityOpt,
    ulimits: spec.ulimits.map(parseUlimitEntry).filter(Boolean),
    shmSize: spec.shmSize,
    restartPolicy: { Name: "unless-stopped" },
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
  for (const rule of params?.deviceCgroupRules || []) args.push("--device-cgroup-rule", rule);
  for (const opt of params?.securityOpt || []) args.push("--security-opt", opt);
  for (const bind of params?.binds || []) args.push("-v", bind);
  for (const [containerPortKey, bindings] of Object.entries(params?.ports || {})) {
    const cPort = containerPortKey.split("/")[0];
    for (const b of bindings || []) {
      if (!b || !b.HostPort) continue;
      const hostIp = b.HostIp && b.HostIp !== "0.0.0.0" ? `${b.HostIp}:` : "";
      args.push("-p", `${hostIp}${b.HostPort}:${cPort}`);
    }
  }
  for (const pb of params?.portBinds || []) args.push("-p", pb);
  for (const entry of params?.env || []) {
    if (typeof entry === "string" && entry.includes("=")) args.push("-e", entry);
  }
  for (const u of params?.ulimits || []) {
    if (u?.Name) args.push("--ulimit", `${u.Name}=${u.Soft}:${u.Hard}`);
  }
  if (params?.shmSize) args.push("--shm-size", params.shmSize);
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

  // Is the compose path usable? Probed once per adapter (memoized in
  // lib/docker.js) and false on the missing-docker stand-in.
  function composeUsable() {
    return typeof docker.compose?.available === "function" && docker.compose.available();
  }

  function spec() {
    return containerSpec(profile);
  }

  // Logs from whichever lifecycle owns the container.
  function containerLogText(lineCount) {
    try {
      if (composeUsable() && isComposeManaged(inspect())) {
        const res = docker.compose.logs(spec().deployDir, Math.max(50, lineCount));
        return `${res?.stdout || ""}${res?.stderr || ""}`;
      }
    } catch {
      /* fall back to `docker logs` */
    }
    return docker.logs(containerName, Math.max(50, lineCount));
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
    const stdoutText = containerLogText(lineCount);
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

    const cSpec = spec();
    const deployDir = cSpec.deployDir;
    const composeFile = composeFilePath(deployDir);
    const composeAvailable = composeUsable();
    const composeExists = fs.existsSync(composeFile);
    const port = current ? deriveDockerPort(profile, current, env) : cSpec.enginePort || FALLBACK_PORT;

    const settings = {
      configFile: mainName || "",
      ggufDir: cSpec.modelDir,
      dataDir: "",
      modelDir: cSpec.modelDir,
      modelsBindDir: cSpec.modelsBindDir,
      image: cSpec.image,
      containerName,
      port: cSpec.enginePort,
      engineBindPort: cSpec.engineBindPort,
      deployDir,
      composeFile,
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
      // Where the compose file lives and whether compose can even be used.
      compose: {
        available: composeAvailable,
        deployDir,
        file: composeFile,
        exists: composeExists,
        managed: isComposeManaged(current),
      },
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

    const current = inspect();
    const cSpec = spec();

    // A container an earlier release created (no compose labels) cannot be
    // adopted by `docker compose up` — the fixed container_name would conflict
    // — so keep it on the legacy lifecycle instead of failing the start.
    if (composeUsable() && current && !isComposeManaged(current)) {
      const res = docker.start(containerName);
      if (!res.ok) {
        return { started: false, state: "stopped", error: (res.stderr || res.stdout || "docker start 失败").trim() };
      }
      return { started: true, state: "starting", container: containerName, via: "docker" };
    }

    if (composeUsable()) {
      // Materialize the host-held secret, then write the compose file only if it
      // is missing: the file is the runtime source of truth, so hand edits are
      // honoured at start. Saving the profile is what regenerates it.
      try {
        writeEnvFile(profile, cfg?.apiKey, { spec: cSpec });
      } catch {
        /* the key is optional; never block a start on it */
      }
      try {
        writeComposeFile(profile, { force: false });
      } catch (e) {
        return { started: false, state: "stopped", error: `无法写入 docker-compose.yml: ${e?.message || e}` };
      }
      const res = docker.compose.up(cSpec.deployDir);
      if (!res.ok) {
        return { started: false, state: "stopped", error: (res.stderr || res.stdout || "docker compose up 失败").trim() };
      }
      return {
        started: true,
        state: "starting",
        container: containerName,
        created: !current,
        via: "compose",
        deployDir: cSpec.deployDir,
      };
    }

    // Legacy fallback: this host has no `docker compose`.
    if (!current) {
      const pulled = await ensureImage();
      if (!pulled && !(typeof docker.imageExists === "function" && docker.imageExists(profile.image))) {
        return {
          started: false,
          state: "not-installed",
          error: `未找到镜像 ${profile.image}，且 docker pull 失败`,
        };
      }
      const params = defaultRunParams(profile, { apiKey: cfg?.apiKey });
      const runRes = docker.raw(buildRunArgs(containerName, params));
      if (!runRes.ok) {
        return {
          started: false,
          state: "stopped",
          error: (runRes.stderr || runRes.stdout || "docker run 失败").trim(),
        };
      }
      return { started: true, state: "starting", container: containerName, created: true, via: "docker" };
    }

    const res = docker.start(containerName);
    if (!res.ok) {
      return { started: false, state: "stopped", error: (res.stderr || res.stdout || "docker start 失败").trim() };
    }
    return { started: true, state: "starting", container: containerName, via: "docker" };
  }

  async function stop() {
    const current = inspect();
    if (!current) {
      return { stopped: false, state: "not-installed", error: `未找到容器 ${containerName}` };
    }
    // `compose stop` (not `down`): the container is kept, so the status machine
    // and the UI still see a stopped-but-present deployment. `down` removes the
    // container and is reserved for tearing a deployment apart.
    if (composeUsable() && isComposeManaged(current)) {
      const res = docker.compose.stop(spec().deployDir, CONTAINER_STOP_TIMEOUT_SEC);
      if (res.ok) return { stopped: true, container: containerName, via: "compose" };
      // e.g. the compose file was removed by hand — fall through to docker stop.
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
    if (composeUsable() && isComposeManaged(current)) {
      const res = docker.compose.restart(spec().deployDir, CONTAINER_STOP_TIMEOUT_SEC);
      if (res.ok) {
        return {
          stop: { stopped: true, container: containerName },
          start: { started: true, state: "starting", container: containerName, via: "compose" },
        };
      }
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
