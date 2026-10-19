// lib/deployer/source.js
//
// The "local source" deployer: the 1.0.0 behaviour, moved out of
// lib/strata.js unchanged. Strata runs as a local `python serve/server.py`
// process; lifecycle is pgrep/kill, config is a writable json, logs are files
// under strataDir.
import * as fs from "../fsx.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolvePython } from "../python.js";
import { listStrataPidsFor, portListening, listChildren, killPid, pidExists } from "../process.js";
import {
  WEB_URL,
  netFetch,
  readApiKey,
  readAllConfig,
  resolveApiKey,
  resolvePort,
  listConfigFiles,
  describeConfigFile,
  pickConfigFile,
  pluginPort,
  mainConfigPath,
  sharedConfigPath,
  readConfigSummary,
  buildConfigView,
  buildNetwork,
  parseJsonText,
  readPidFile,
  writePidFile,
  clearPidFile,
  savePluginConfig,
  isStrataProcess,
  readResources,
  parseMetrics,
  logLinesFromText,
  getLatestVersion,
  validateEdits,
  renderConfigEdits,
  EDIT_KEYS,
  setTopLevelString,
  generateApiKey,
  timestamp,
} from "./common.js";

// ── Source-only helpers ───────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function backupFile(file) {
  const backup = `${file}.bak-${timestamp()}`;
  fs.copyFileSync(file, backup);
  return path.basename(backup);
}

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

// ── The engine's version WITHOUT starting it ───────────────────────────────────
//
// The running server's `/v1/status` is the authoritative answer, but it reports nothing while
// the service is stopped — and "version: —" then used to hide the update action entirely
// (the panel only offered it when a local version was known). Stopping is exactly what the
// update pipeline does first, so that was backwards.
//
// The build writes its version into `<strataDir>/engine/BUILD.json`; read that. No process,
// no git, no HTTP. Never throws — this runs on the status poll path, where an exception
// would take the whole panel down — and it remembers the last value it managed to read.
let engineVersionCache = null;

export function readEngineVersion(cfg) {
  const dir = typeof cfg?.strataDir === "string" ? cfg.strataDir.trim() : "";
  if (!dir) return engineVersionCache;
  try {
    const raw = fs.readFileSync(path.join(dir, "engine", "BUILD.json"), "utf8");
    const version = JSON.parse(raw)?.version;
    if (typeof version === "string" && version.trim()) engineVersionCache = version.trim();
  } catch {
    /* missing / unreadable / not JSON: fall back to what we saw last time */
  }
  return engineVersionCache;
}

// `/v1/status` reports the engine version; anything that is not a non-empty string means
// "not reported" (`??` alone would let an empty string win over the BUILD.json fallback).
function reportedEngineVersion(data) {
  const v = data?.engine;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function getNetwork(cfg, port, platform = process.platform) {
  const main = readJson(mainConfigPath(cfg));
  const fallbackHost = typeof main?.host === "string" && main.host ? main.host : "127.0.0.1";
  return buildNetwork({ port, platform, fallbackHost, apiKey: resolveApiKey(cfg) });
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

export function readRecentLogs(cfg, lineCount = 10) {
  // THE CONFIG DECLARES ITS LOG (`log`, written by setup.py: …/strata-<model>.log), so
  // read THAT one first. The install folder also collects the ENGINE's own log
  // (`strata-strata-<model>.log`, written by the engine binary in a different format:
  // `[strata] done: 220 tokens in 7 s (49.2 tok/s)`, which `parseMetrics` does not
  // match) plus `strata-setup.log`. Choosing "the newest of them" by mtime flipped
  // between the two several times a minute: the Performance rows went empty whenever
  // the engine's log was the last one written, and the panel's block appeared and
  // disappeared with it (reported 2026-10-17). The declared path is stable.
  const given = typeof cfg.logPath === "string" && cfg.logPath.trim() ? cfg.logPath.trim() : declaredLogPath(cfg);
  const candidates = [];
  if (given) candidates.push(path.resolve(cfg.strataDir, given));
  for (const f of listLogFiles(cfg.strataDir)) {
    if (!candidates.includes(f)) candidates.push(f);
  }
  for (const file of candidates) {
    const tail = readTail(file);
    if (!tail) continue;
    const metrics = parseMetrics(tail);
    const lines = logLinesFromText(tail, lineCount);
    return { file: path.basename(file), lines, metrics };
  }
  return {
    file: null,
    lines: [],
    metrics: { pp: null, tg: null, expertCacheHit: null, kvHit: null, ppLast: null, tgLast: null, samples: {} },
  };
}

// The `log` a setup-produced config names, or "" when it names none / cannot be read.
function declaredLogPath(cfg) {
  try {
    const main = readJson(mainConfigPath(cfg));
    return typeof main?.log === "string" ? main.log.trim() : "";
  } catch {
    return "";
  }
}

// ── Deployer ──────────────────────────────────────────────────────────────

// The argv a start gets. Pure and exported so the test can pin the contract that
// the plugin is its own UI: `--open` (setup.py's run-<model>.sh spelling) must
// NEVER appear here. serve/server.py opens a browser only when it sees `--open`
// (serve/server.py:5865), so a start from the plugin opens nothing, whatever the
// config's `open_browser` says.
export function serverStartArgs({ serverScript, configPath, port, gpu }) {
  const args = [serverScript, "--engine", "strata", "--config", configPath, "--port", String(port)];
  if (String(gpu || "").trim()) args.push("--gpu", String(gpu).trim());
  return args;
}

export function createSourceDeployer({ ctx, cfg, opts = {} }) {
  const platform = opts.platform || process.platform;
  // Process helpers, injectable through `opts.processes` the same way the
  // container deployer takes `opts.docker` (opt-in, for tests).
  // `list` takes the deployment's own strataDir: a machine-wide scan is never
  // what a lifecycle decision wants (see lib/process.js).
  const procs = {
    list: listStrataPidsFor,
    listening: portListening,
    children: listChildren,
    kill: killPid,
    alive: pidExists,
    isStrata: isStrataProcess,
    ...(opts.processes || {}),
  };

  async function getStatus() {
    const versionCheck = getLatestVersion(ctx);
    const python = resolvePython(cfg);
    const settings = {
      strataDir: cfg.strataDir || "",
      pythonPath: cfg.pythonPath || "",
      gpu: cfg.gpu || "",
      configFile: cfg.configFile || "",
      ggufDir: cfg.ggufDir || "",
      port: pluginPort(cfg),
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
      version: { local: readEngineVersion(cfg), ...versionCheck },
    };

    // 1. Unconfigured: only strataDir is required.
    if (!cfg.strataDir) {
      return { ...base, state: "unconfigured" };
    }

    // 2. Not installed: the Strata server entrypoint is missing.
    const serverScript = path.join(cfg.strataDir, "serve", "server.py");
    if (!fs.existsSync(serverScript)) {
      return { ...base, state: "not-installed", serverScript };
    }

    // 3. The configured python must exist, or a system python3 be available.
    if (!python.path) {
      return { ...base, state: "python-missing", serverScript, error: python.error };
    }

    // 4. Discover config files. A stored selection is only valid when the
    //    file still exists. When the override is empty the newest config is
    //    picked automatically ("auto"), so an existing install starts with no
    //    setup pass. Only a really missing config reaches the first-run path.
    const configCandidates = listConfigFiles(cfg.strataDir).map((f) => describeConfigFile(cfg.strataDir, f));
    if (!configCandidates.length) {
      return { ...base, state: "no-config", serverScript, configCandidates, firstRun: true };
    }
    let selected = configCandidates.some((c) => c.file === cfg.configFile) ? cfg.configFile : "";
    let autoSelected = false;
    if (!selected) {
      selected = pickConfigFile(cfg.strataDir, configCandidates);
      autoSelected = !!selected;
      // Remember the auto pick so the config editor / port helpers (which read
      // cfg.configFile) work without an explicit selection. Best effort.
      if (autoSelected) {
        try {
          await savePluginConfig(ctx, { configFile: selected });
        } catch {
          /* detection must not fail on a write */
        }
      }
    }
    if (!selected) {
      return { ...base, state: "needs-config", serverScript, configCandidates };
    }

    const rcfg = { ...cfg, configFile: selected };
    const port = resolvePort(rcfg);
    const readyBase = {
      ...base,
      port,
      webUrl: WEB_URL(port),
      configFile: selected,
      autoSelected,
      configCandidates,
      network: getNetwork(rcfg, port, platform),
      ...collectExtras(rcfg),
    };

    // 5. Try the running server.
    const apiKey = resolveApiKey(rcfg);
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
          version: { local: reportedEngineVersion(data) ?? readEngineVersion(cfg), ...versionCheck },
        };
      }
      if (res.status === 401 || res.status === 403) {
        return { ...readyBase, state: "running", authFailed: true };
      }
    } catch {
      /* server not reachable */
    }

    // 6. Otherwise decide between "starting" and "stopped" from evidence that
    //    belongs to THIS deployment only. Two independent signals, both
    //    read-only:
    //      · a process whose command line (or cwd) is under this strataDir;
    //      · a TCP listener on THIS profile's port.
    //    A sibling deployment has its own folder and its own port, so neither
    //    signal can see it. That is the whole point: the machine-wide scan this
    //    replaced made a stopped profile report 启动中 and its 启动 button
    //    return `already: true` whenever a second Strata ran on the host.
    const pids = procs.list(cfg.strataDir, platform);
    if (pids.length) return { ...readyBase, state: "starting", pids };

    // Nothing of ours is alive, yet our port answers: something else holds it
    // (the likeliest cause is a second deployment whose port resolution lands
    // on the same number). Saying "starting" here would resurrect the same
    // bug, so this is reported as a conflict instead, and start() refuses with
    // an explanation rather than spawning a server that cannot bind.
    if (await procs.listening(port)) return { ...readyBase, state: "stopped", portConflict: true };

    // 7. Configured, installed and selected, but nothing is running.
    return readyBase;
  }

  async function start() {
    const status = await getStatus();
    if (status.state === "running" || status.state === "starting") {
      return { started: false, already: true, state: status.state, ...status };
    }
    if (status.portConflict) {
      return {
        started: false,
        state: "stopped",
        portConflict: true,
        error: `端口 ${status.port} 已被其他进程占用（可能是另一份 Strata 部署），当前环境无法启动；请先在占用它的地方停止，或改用其他端口。`,
      };
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
    const args = serverStartArgs({ serverScript, configPath, port, gpu: rcfg.gpu });
    let child;
    if (process.platform === "win32") {
      child = spawn(python.path, args, {
        cwd: rcfg.strataDir,
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
      });
    } else {
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

  async function stop() {
    if (platform === "darwin") {
      return { stopped: false, unsupported: true, error: "Strata 不支持 macOS" };
    }

    const parents = new Set(procs.list(cfg.strataDir, platform));
    const recorded = readPidFile(cfg);
    if (recorded && procs.isStrata(recorded, platform)) parents.add(recorded);

    const targets = new Set(parents);
    for (const pid of [...parents]) {
      for (const child of procs.children(pid, platform)) targets.add(child);
    }

    const killed = [];
    const denied = [];
    for (const pid of [...targets].sort((a, b) => b - a)) {
      if (procs.kill(pid, "SIGTERM")) killed.push(pid);
      // Alive but unsignalable: the process belongs to someone else (a service
      // running in a container, a root-owned daemon). Silently returning
      // `stopped:false` here made the failure invisible, because the panel only
      // looks at the HTTP status of POST /stop.
      else if (procs.alive(pid)) denied.push(pid);
    }

    const forced = [];
    if (killed.length) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (const pid of killed) {
        if (procs.alive(pid)) {
          procs.kill(pid, "SIGKILL");
          forced.push(pid);
        }
      }
    }

    if (!procs.list(cfg.strataDir, platform).length) clearPidFile(cfg);
    if (killed.length) return { stopped: true, killed, forced };
    if (denied.length) {
      return {
        stopped: false,
        killed,
        denied,
        error:
          `找到 ${denied.length} 个 Strata 进程但无法停止（PID ${denied.join(", ")}）：` +
          "它们不属于当前用户，可能由容器或其他用户启动；请到启动它们的地方停止，或改用对应的容器配置。",
      };
    }
    // Nothing local to stop: idempotent, not an error.
    return { stopped: false, killed, already: true };
  }

  async function restart() {
    const stopResult = await stop();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const startResult = await start();
    return { stop: stopResult, start: startResult };
  }

  async function readConfig() {
    const mainPath = mainConfigPath(cfg);
    const sharedPath = sharedConfigPath(cfg);
    const mainName = cfg.configFile ? path.basename(mainPath) : "";
    const sharedName = cfg.configFile ? path.basename(sharedPath) : "";
    return buildConfigView({
      configFile: cfg.configFile || "",
      mainName,
      sharedName,
      mainText: readText(mainPath),
      sharedText: readText(sharedPath),
    });
  }

  async function writeConfig(edits) {
    if (!cfg.configFile) throw new Error("尚未选择配置文件，无法保存参数");
    const { clean, errors } = validateEdits(edits, EDIT_KEYS);
    if (errors.length) {
      const err = new Error(errors.join("; "));
      err.validation = errors;
      throw err;
    }

    const mainPath = mainConfigPath(cfg);
    const sharedPath = sharedConfigPath(cfg);
    const mainText = readText(mainPath);
    const sharedText = readText(sharedPath);
    if (
      mainText === null ||
      sharedText === null ||
      !parseJsonText(mainText) ||
      !parseJsonText(sharedText)
    ) {
      throw new Error("配置文件读取失败，无法保存");
    }

    const before = (await readConfig()).values;
    const result = renderConfigEdits({ clean, before, mainText, sharedText, keys: EDIT_KEYS });
    if (!result.diff.length) {
      return { saved: false, diff: [], backups: [], restartRequired: false, note: "没有变化" };
    }

    const backups = [];
    if (result.mainOps.length) {
      backups.push(backupFile(mainPath));
      fs.writeFileSync(mainPath, result.newMainText);
    }
    if (result.sharedOps.length) {
      backups.push(backupFile(sharedPath));
      fs.writeFileSync(sharedPath, result.newSharedText);
    }

    return { saved: true, diff: result.diff, backups, restartRequired: result.restartRequired };
  }

  async function readLogs(lineCount = 10) {
    return readRecentLogs(cfg, lineCount);
  }

  // Source updates are orchestrated by routes/update.js (git fetch/checkout +
  // setup.py). The deployer method exists to satisfy the unified interface but
  // deliberately defers to that pipeline.
  async function update() {
    const err = new Error("源码模式更新由 /update 路由处理，不通过 deployer.update()");
    err.notSupported = true;
    throw err;
  }

  return {
    mode: "source",
    detect: async () => "source",
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

// Switch the Strata listener between local-only (127.0.0.1) and LAN-exposed
// (0.0.0.0). Source-only: docker host/api_key are read-only in 1.1.0.
export async function sourceSetHostMode(ctx, mode) {
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
