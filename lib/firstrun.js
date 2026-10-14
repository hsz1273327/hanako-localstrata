// lib/firstrun.js — first-launch orchestration (1.1.0 batch 2, local mode).
//
// "Start" already covers the first run: when there is no usable config, the
// same button runs setup and then starts the service. This is the LOCAL source
// path only: spawn `setup.py --setup --yes --no-start [--gguf-dir <dir>]`, wait
// for it to write `strata-<tag>.json`, select that config and start
// `serve/server.py`.
//
// The container profile's own entrypoint performs its setup on first start, so
// this module is intentionally not involved there.
//
// Setup can take minutes to hours (download/convert), so it runs as a
// background job and exposes staged progress through GET /start. Existing
// installations never reach this module: `needsInitialSetup(status)` is false
// and the caller starts the service directly (zero regression).
import { spawn } from "node:child_process";
import path from "node:path";
import * as fs from "./fsx.js";
import { getStatus, startService, readAllConfig, savePluginConfig } from "./strata.js";
import { resolvePython } from "./python.js";
import { listConfigFiles, describeConfigFile, pickConfigFile } from "./deployer/common.js";

// The user-visible stages of a first launch.
export const FIRST_RUN_STAGES = ["download", "convert", "config", "load"];

// Which status means "no usable config, run setup first". A local install with
// no `strata-*.json` is the only such state.
export function needsInitialSetup(status) {
  if (!status || status.state === "unsupported") return false;
  if (status.launch?.method === "docker" || status.method === "docker") return false;
  return status.state === "no-config";
}

// Pure plan used by the route and the tests: what setup would do and whether a
// large download is possible.
export function initialSetupPlan(status, cfg) {
  const ggufDir = String(cfg?.ggufDir || "").trim();
  return {
    needed: needsInitialSetup(status),
    mode: "local",
    ggufDir,
    stages: [...FIRST_RUN_STAGES],
    // Without a GGUF folder setup.py downloads the model (~70-120 GB).
    mayDownload: !ggufDir,
  };
}

// setup.py's own progress markers: "=== Step 5: downloading ... ===" and
// "=== Step 6: preparing the model for Strata ===". Before step 5 the install
// is downloading/preparing too, so it maps to the download stage.
export function classifySetupLine(line) {
  const text = String(line || "");
  const step = /step\s*(\d+)\s*:/i.exec(text);
  if (step) {
    return Number(step[1]) >= 6 ? "convert" : "download";
  }
  const s = text.toLowerCase();
  if (/preparing the model|convert|packing|pack the|\bpack\b|转换|准备/.test(s)) return "convert";
  if (/downloading|download|fetching|下载/.test(s)) return "download";
  if (/writing|config|start script|all set|配置/.test(s)) return "config";
  return null;
}

function idleState() {
  return {
    running: false,
    firstRun: false,
    needed: false,
    mode: null,
    stage: null,
    stageIndex: 0,
    totalStages: FIRST_RUN_STAGES.length,
    stages: [...FIRST_RUN_STAGES],
    mayDownload: false,
    ggufDir: "",
    logFile: null,
    error: null,
    errorTail: [],
    done: false,
    startedAt: null,
    finishedAt: null,
    result: null,
  };
}

// Module-level single job, mirroring routes/update.js: only one first run can
// be in flight per App instance.
let state = idleState();

export function getFirstRunState() {
  return { ...state };
}

export function resetFirstRunState() {
  state = idleState();
  return getFirstRunState();
}

function setStage(stage) {
  const i = state.stages.indexOf(stage);
  if (i < 0) return;
  if (i + 1 < state.stageIndex) return; // never move backwards
  state.stage = stage;
  state.stageIndex = i + 1;
}

function redact(text) {
  return String(text)
    .replace(/sk-strata-[0-9a-f]{16,}/gi, "sk-strata-****")
    .replace(/("api_key"\s*:\s*)"[^"]*"/gi, '$1"***"');
}

function appendLog(logFile, text) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, text);
  } catch {
    /* best effort */
  }
}

function finish(result) {
  state = {
    ...state,
    running: false,
    done: true,
    stage: "done",
    stageIndex: state.stages.length,
    finishedAt: Date.now(),
    result: result || null,
  };
}

function fail(err) {
  const base = String(err?.message || err);
  const tail = Array.isArray(err?.tail) ? err.tail.filter((l) => l.trim()).slice(-8) : [];
  state = {
    ...state,
    running: false,
    error: tail.length ? `${base}\n${tail.join("\n")}` : base,
    errorTail: tail,
    finishedAt: Date.now(),
  };
}

const defaultIO = {
  getStatus: (ctx, opts) => getStatus(ctx, opts),
  startService: (ctx, opts) => startService(ctx, opts),
  readAllConfig: (ctx) => readAllConfig(ctx),
  // The selected config is the top-level `configFile`, not a profile field.
  saveSelectedConfig: (ctx, file) => savePluginConfig(ctx, { configFile: file }),
  spawn,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Start the first-run job. Returns immediately with the progress state; poll
// GET /start for updates. `opts.io` is injectable for tests.
export async function beginFirstRun(ctx, opts = {}) {
  const io = { ...defaultIO, ...(opts.io || {}) };
  const status = await io.getStatus(ctx, opts);
  const cfg = await io.readAllConfig(ctx);
  const plan = initialSetupPlan(status, cfg);

  if (!plan.needed) {
    return { ...getFirstRunState(), needed: false, plan };
  }
  if (state.running) {
    return { ...state, alreadyRunning: true, plan };
  }

  state = {
    ...idleState(),
    running: true,
    firstRun: true,
    needed: true,
    mode: plan.mode,
    stage: FIRST_RUN_STAGES[0],
    stageIndex: 1,
    mayDownload: plan.mayDownload,
    ggufDir: plan.ggufDir,
    startedAt: Date.now(),
  };

  Promise.resolve()
    .then(() => runLocalFirstRun(io, ctx, cfg, plan, opts))
    .catch((err) => fail(err));

  return { ...state, plan };
}

function runSetupProcess(io, cmd, args, { cwd, logFile, onLine }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = io.spawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const tail = [];
    const consume = (chunk) => {
      const text = redact(chunk.toString("utf8"));
      appendLog(logFile, text);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        onLine?.(line);
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`setup.py 失败（退出码 ${code}）`);
        err.tail = tail;
        reject(err);
      }
    });
  });
}

async function waitForRunning(io, ctx, opts, { stoppedGraceMs = 20000 } = {}) {
  const pollMs = opts.pollMs || 2500;
  const timeoutMs = opts.maxWaitMs || 12 * 3600 * 1000;
  const deadline = Date.now() + timeoutMs;
  let stoppedSince = 0;
  while (Date.now() < deadline) {
    await io.sleep(pollMs);
    let st = null;
    try {
      st = await io.getStatus(ctx, opts);
    } catch {
      continue;
    }
    if (st?.state === "running") return st;
    if (st?.state === "starting") {
      setStage("load");
      stoppedSince = 0;
      continue;
    }
    if (st?.state === "stopped") {
      if (!stoppedSince) stoppedSince = Date.now();
      if (Date.now() - stoppedSince > stoppedGraceMs) {
        throw new Error(st.error || "服务在启动后退出");
      }
    }
  }
  throw new Error("首次启动超时");
}

async function runLocalFirstRun(io, ctx, cfg, plan, opts) {
  const python = resolvePython(cfg);
  if (!python.path) throw new Error(python.error || "未找到可用的 Python 解释器");

  const setupPy = path.join(cfg.strataDir, "setup.py");
  if (!fs.existsSync(setupPy)) throw new Error(`找不到 setup.py: ${setupPy}`);
  const logFile = path.join(cfg.strataDir, "strata-setup.log");
  state.logFile = logFile;
  try {
    fs.mkdirSync(cfg.strataDir, { recursive: true });
  } catch {
    /* best effort */
  }

  const args = [setupPy, "--setup", "--yes", "--no-start"];
  if (plan.ggufDir) args.push("--gguf-dir", plan.ggufDir);
  appendLog(logFile, `\n[${new Date().toISOString()}] setup.py ${args.join(" ")}\n`);

  await runSetupProcess(io, python.path, args, {
    cwd: cfg.strataDir,
    logFile,
    onLine: (line) => {
      const next = classifySetupLine(line);
      if (next) setStage(next);
    },
  });

  // setup.py wrote strata-<tag>.json; pick it and make it the explicit
  // selection so the start below (and later launches) use it.
  setStage("config");
  const candidates = listConfigFiles(cfg.strataDir).map((f) => describeConfigFile(cfg.strataDir, f));
  const selected = candidates.some((c) => c.file === cfg.configFile)
    ? cfg.configFile
    : pickConfigFile(cfg.strataDir, candidates);
  if (selected && selected !== cfg.configFile) {
    try {
      await io.saveSelectedConfig(ctx, selected);
    } catch {
      /* best effort */
    }
  }

  setStage("load");
  const started = await io.startService(ctx, { ...opts, launchMethod: "local" });
  if (started && started.started === false && !started.already) {
    throw new Error(started.error || "启动失败");
  }
  await waitForRunning(io, ctx, opts);
  finish({ started });
}
