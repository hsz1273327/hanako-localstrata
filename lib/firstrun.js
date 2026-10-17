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
import { FAMILIES, MODEL_ORDER, modelFamilies } from "./model-tiers.js";

const FAMILY_KEYS = FAMILIES.map((f) => f.key);

// The user-visible stages of a first launch.
export const FIRST_RUN_STAGES = ["download", "convert", "config", "load"];

// What a setup re-run may be ASKED to change, and the values setup itself
// accepts (setup.py:4584-4664). Everything else setup decides: the hardware
// side (`--backend`, `--gpu(s)`), the paths that belong to the profile
// (`--gguf-dir`, `--data-dir`, `--port`), and what it derives from the RAM/VRAM
// (`--resident-budget-gib`, `--vram-reserve-mib`).
//
// `context`/`kv` are in this list because a re-run REBUILDS `args` — measured
// against setup's own `write_setup_config`: a hand-set `--max-context` came back
// as setup's answer, and hand-added engine options were dropped (setup prints
// which). Passing them here is how the user keeps them.
export const SETUP_PARAMS = {
  // WHICH MODEL this run installs. Both are setup's own flags (setup.py:4574-4575,
  // `choices=list(FAMILIES)` / `list(MODELS)`), and passing them is the only way to
  // stop a re-run from picking a size of its own: with `--yes` and no `--model`,
  // setup takes its recommendation (RAM ≥ 60 GB → IQ3_XXS, setup.py:4988), which is
  // how an IQ3_S deployment got rebuilt as an IQ3_XXS one. `--family` only matters
  // for a size that ships in more than one release; it is passed only when the
  // size is single-release (otherwise setup's own family menu decides).
  family: { flag: "--family", values: FAMILY_KEYS },
  model: { flag: "--model", values: MODEL_ORDER },
  // Which GGUF folder THIS run reads its model from. It is setup's own flag, and
  // it is the one input a local profile no longer carries: a model folder belongs
  // to a setup run (an environment keeps its own bind mount; see
  // lib/profiles.js). Empty = the general default, then a download.
  ggufDir: { flag: "--gguf-dir", path: true },
  vision: { flag: "--vision", values: ["no", "yes", "gpu", "cpu"] },
  lowRam: { flag: "--low-ram", values: ["auto", "on", "off", "resident", "mmap"] },
  kvStreaming: { flag: "--kv-streaming", values: ["auto", "on", "off"] },
  // setup takes a plain int for the context (no choices). The list is what the UI
  // offers; `anyPositiveInt` keeps a context the config already holds acceptable,
  // so a value we do not list is never silently replaced by setup's answer.
  context: { flag: "--context", values: ["8192", "32768", "65536", "131072", "262144", "524288"], anyPositiveInt: true },
  kv: { flag: "--kv", values: ["int8", "q4_0", "k8v4"] },
};

// Whitelist + value domain, in one place: the route validates with this and the
// job builds the command from the same spec. Returns `{ clean, errors }`, where
// `clean` holds only the parameters actually asked for (absent = let setup decide).
export function validateSetupParams(input) {
  const clean = {};
  const errors = [];
  if (input === undefined || input === null) return { clean, errors };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { clean, errors: ["setup 参数必须是一个对象"] };
  }
  for (const [key, raw] of Object.entries(input)) {
    const spec = SETUP_PARAMS[key];
    if (!spec) {
      errors.push(`setup 不接受参数: ${key}`);
      continue;
    }
    const value = String(raw ?? "").trim();
    if (!value) continue; // "let setup decide" is expressed by omission
    // A path is free text here; whether it EXISTS is checked where the filesystem
    // is (routes/config.js), so this stays a pure function.
    if (spec.path) {
      clean[key] = value;
      continue;
    }
    const numeric = spec.anyPositiveInt && /^\d+$/.test(value) && Number(value) > 0;
    if (!numeric && !spec.values.includes(value)) {
      errors.push(`${key} 必须是 ${spec.values.join("/")}`);
      continue;
    }
    clean[key] = value;
  }
  // `--model` is fine alone (setup's family menu then decides, which is what its
  // own `--yes` run does); `--family` alone is not: it names a release without
  // naming a size, and setup's size menu would pick one the user never chose.
  if (clean.family && !clean.model) {
    errors.push("family 需要和 model 一起传");
    delete clean.family;
  }
  if (clean.model && clean.family && !modelFamilies(clean.model).includes(clean.family)) {
    errors.push(`${clean.model} 不在 ${clean.family} 这一支里`);
    delete clean.model;
    delete clean.family;
  }
  return { clean, errors };
}

// Which status means "no usable config, run setup first". A local install with
// no `strata-*.json` is the only such state.
export function needsInitialSetup(status) {
  if (!status || status.state === "unsupported") return false;
  if (status.launch?.method === "docker" || status.method === "docker") return false;
  return status.state === "no-config";
}

// Pure plan used by the routes and the tests: what setup would do and whether a
// large download is possible. `opts.force` is `/config/setup`'s "build a NEW
// config even though one already exists"; `opts.startAfter` is whether the job
// ends by starting the service (a first launch does; a manual rebuild does not,
// leaving the user to start it).
export function initialSetupPlan(status, cfg, { force = false, startAfter = true, setup = {} } = {}) {
  const docker = status?.launch?.method === "docker" || status?.method === "docker";
  const { clean, errors } = validateSetupParams(setup);
  // The folder setup will read the model from: what this run asked for, else the
  // general default (the chain a local profile used to take part in), else empty
  // = setup downloads it.
  const ggufDir = String(clean.ggufDir || cfg?.ggufDir || "").trim();
  return {
    needed: force ? !docker && status?.state !== "unsupported" : needsInitialSetup(status),
    mode: docker ? "docker" : "local",
    ggufDir,
    stages: [...FIRST_RUN_STAGES],
    // Without a GGUF folder setup.py downloads the model (~70-120 GB).
    mayDownload: !ggufDir,
    startAfter,
    // Echoed so the caller (and the UI) can see exactly what will be passed;
    // `errors` is empty unless someone sent a value setup does not accept.
    setup: clean,
    setupErrors: errors,
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
  const plan = initialSetupPlan(status, cfg, {
    force: opts.force === true,
    startAfter: opts.startAfter !== false,
    setup: opts.setup,
  });

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
  // The parameters the user asked to change THIS run (setup-only ones, plus the
  // args a re-run would otherwise rebuild from its own answers). Omitted = setup
  // decides. `ggufDir` is skipped here: plan.ggufDir above already carries it
  // (the requested folder, else the general default).
  for (const [key, value] of Object.entries(plan.setup || {})) {
    if (key === "ggufDir") continue;
    args.push(SETUP_PARAMS[key].flag, String(value));
  }
  appendLog(logFile, `\n[${new Date().toISOString()}] setup.py ${args.join(" ")}\n`);

  // Snapshot the configs BEFORE setup so we can tell which file it produced.
  const configsBefore = new Set(listConfigFiles(cfg.strataDir));

  await runSetupProcess(io, python.path, args, {
    cwd: cfg.strataDir,
    logFile,
    onLine: (line) => {
      const next = classifySetupLine(line);
      if (next) setStage(next);
    },
  });

  // setup.py wrote strata-<tag>.json. Select the file THIS run produced (a
  // rebuild must land on its own result, never the config it replaced); fall
  // back to the existing selection, then to the newest. Record it as the
  // explicit top-level selection so the start below (and later launches) use it.
  setStage("config");
  const candidates = listConfigFiles(cfg.strataDir).map((f) => describeConfigFile(cfg.strataDir, f));
  const produced = candidates.filter((c) => !configsBefore.has(c.file));
  const selected = produced.length
    ? pickConfigFile(cfg.strataDir, produced)
    : candidates.some((c) => c.file === cfg.configFile)
      ? cfg.configFile
      : pickConfigFile(cfg.strataDir, candidates);
  if (selected && selected !== cfg.configFile) {
    try {
      await io.saveSelectedConfig(ctx, selected);
    } catch {
      /* best effort */
    }
  }

  // `/config/setup` (startAfter:false) builds the config and stops there; the
  // user starts it explicitly. A first launch continues into the service start.
  if (!plan.startAfter) {
    finish({ started: null, configFile: selected || null });
    return;
  }

  setStage("load");
  const started = await io.startService(ctx, { ...opts, launchMethod: "local" });
  if (started && started.started === false && !started.already) {
    throw new Error(started.error || "启动失败");
  }
  await waitForRunning(io, ctx, opts);
  finish({ started });
}
