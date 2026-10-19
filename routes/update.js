// POST /update  { tag?: "0.1.42" }  — 启动更新（异步，立即返回进度状态）
// GET  /update                     — 轮询更新进度 / 结果
// GET  /update/log                 — 读取 {strataDir}/strata-update.log 的尾部
//
// 只做本机（源码）更新管线。容器配置不支持应用内更新（没有镜像构建/重建
// 管线），这里会明确拒绝（不做任何 docker 转发）。
//
// 本机更新流程全部在插件后端执行（不依赖 shell 脚本交互）：
//   1) 读插件配置（strataDir/pythonPath/configFile/port）
//   2) 判断 CUDA 环境（python 环境自带 nvcc 则用它的，否则用系统 CUDA）
//   3) 停止服务（复用 lib/strata.js 的精确匹配 + 排除自身）
//   4) git fetch --tags --force origin
//   5) git checkout <tag>
//   6) {pythonPath} {strataDir}/setup.py --update --yes --no-browser --data-dir {dataDir}
//      （仅当环境自带 CUDA 时注入 STRATA_NVCC / NVCC_PREPEND_FLAGS / LDFLAGS）
//   7) 重启服务
//   全过程写日志到 {strataDir}/strata-update.log（stdout+stderr，脱敏）。

import * as fs from "../lib/fsx.js";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
  readAllConfig,
  stopService,
  startService,
  getLatestVersion,
  resolvePort,
  getStatus,
} from "../lib/strata.js";
import { resolvePython } from "../lib/python.js";
import { commandExists } from "../lib/process.js";
import {
  describeSetupEnv,
  ensureSetupSettings,
  profileDataDir,
  profileStrataDir,
  setupSettingsPath,
  withSetupConfigEnv,
} from "../lib/setup-env.js";

const UPDATE_LOG_NAME = "strata-update.log";

const STEPS = [
  { id: "backup", label: "备份配置" },
  { id: "cuda", label: "判断 CUDA 环境" },
  { id: "stop", label: "停止服务" },
  { id: "fetch", label: "拉取代码" },
  { id: "checkout", label: "切换版本" },
  { id: "build", label: "编译引擎" },
  { id: "restart", label: "重启服务" },
];

function ts() {
  return new Date().toISOString();
}

// The argv the update's setup run gets. Pure and exported so the test can pin the
// one thing that matters here: `--no-browser`, for the same reason the first-run
// job passes it (lib/firstrun.js's setupArgs) — the plugin is its own UI, so a
// browser window popping up out of an update is noise. setup.py accepts the flag
// on the `--update` branch too (one parser, setup.py:4610).
export function updateSetupArgs(setupPy, dataDir) {
  return [setupPy, "--update", "--yes", "--no-browser", "--data-dir", dataDir];
}

function idleState() {
  return {
    running: false,
    step: 0,
    stepId: null,
    stepLabel: null,
    totalSteps: STEPS.length,
    steps: STEPS.map((s) => s.label),
    tag: null,
    oldVersion: null,
    error: null,
    failedStep: null,
    errorTail: [],
    rollbackHint: null,
    logFile: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    done: false,
  };
}

let state = idleState();
let activeLogPath = null;

function log(text) {
  if (activeLogPath) {
    try {
      fs.appendFileSync(activeLogPath, text);
    } catch {
      /* best effort */
    }
  }
}

function openLog(cfg) {
  fs.mkdirSync(cfg.strataDir, { recursive: true });
  const logFile = path.join(cfg.strataDir, UPDATE_LOG_NAME);
  activeLogPath = logFile;
  return logFile;
}

function closeLog() {
  activeLogPath = null;
}

// 日志里绝不落盘 API Key 之类的敏感信息。
function redact(text) {
  return String(text)
    .replace(/sk-strata-[0-9a-f]{16,}/gi, "sk-strata-****")
    .replace(/("api_key"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,"']+/gi, "$1***");
}

function displayCmd(cmd, args) {
  return redact([cmd, ...args].join(" "));
}

function runCommand(label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`[${ts()}] ${label}: ${displayCmd(cmd, args)}\n`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const tail = [];
    const consume = (chunk) => {
      const text = redact(chunk.toString("utf8"));
      log(text);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          tail.push(line);
          if (tail.length > 40) tail.shift();
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    child.on("error", (err) => {
      log(`[${ts()}] ${label}: 无法启动命令: ${err.message}\n`);
      reject(err);
    });
    child.on("close", (code) => {
      log(`[${ts()}] ${label}: 退出码 ${code}\n`);
      if (code === 0) resolve({ code, tail });
      else {
        const err = new Error(`${label} 失败（退出码 ${code}）`);
        err.code = code;
        err.tail = tail;
        reject(err);
      }
    });
  });
}

function setStep(step) {
  const s = STEPS[step - 1];
  state.step = step;
  state.stepId = s?.id || null;
  state.stepLabel = s?.label || null;
  log(`\n[${ts()}] === 步骤 ${step}/${STEPS.length}：${s?.label || ""} ===\n`);
}

// 判断 python 环境是否自带 CUDA（直接看同环境里有没有 nvcc，不用 sys.prefix）。
// pythonPath 为空（用系统 python3）时没有专属环境，直接走系统 CUDA 分支。
export function detectCuda(cfg, platform = process.platform) {
  const configured = String(cfg.pythonPath || "").trim();
  const envRoot = configured ? path.dirname(path.dirname(configured)) : "";
  const nvccInEnv = envRoot ? envNvccPath(envRoot, platform) : "";
  const hasOwnCuda = !!nvccInEnv && fs.existsSync(nvccInEnv);
  let nvcc = null;
  if (hasOwnCuda) {
    nvcc = nvccInEnv;
  } else {
    for (const cand of systemNvccCandidates(platform)) {
      if (fs.existsSync(cand)) {
        nvcc = cand;
        break;
      }
    }
  }
  return { hasOwnCuda, envRoot, nvccInEnv, nvcc };
}

// nvcc lives in <env>/bin on POSIX, but conda-forge's CUDA toolkit on Windows
// installs it under <env>/Library/bin. UNTESTED on Windows.
function envNvccPath(envRoot, platform) {
  if (platform === "win32") {
    for (const rel of [["Library", "bin", "nvcc.exe"], ["bin", "nvcc.exe"]]) {
      const p = path.join(envRoot, ...rel);
      if (fs.existsSync(p)) return p;
    }
    return path.join(envRoot, "Library", "bin", "nvcc.exe");
  }
  return path.join(envRoot, "bin", "nvcc");
}

// System CUDA locations. On Windows the versioned toolkit directories are
// discovered rather than hard-coded. UNTESTED on Windows.
function systemNvccCandidates(platform) {
  if (platform === "win32") {
    const out = [];
    const base = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
    try {
      for (const name of fs.readdirSync(base)) out.push(path.join(base, name, "bin", "nvcc.exe"));
    } catch {
      /* toolkit not installed */
    }
    out.sort().reverse(); // newest version directory first
    return out;
  }
  return ["/usr/local/cuda/bin/nvcc", "/usr/bin/nvcc"];
}

function buildEnv(cfg, cuda) {
  if (!cuda.hasOwnCuda) return process.env;
  return {
    ...process.env,
    STRATA_NVCC: cuda.nvccInEnv,
    NVCC_PREPEND_FLAGS: "-Xlinker --allow-shlib-undefined",
    LDFLAGS: "-Wl,--allow-shlib-undefined",
  };
}

// What a setup / install class process gets: the CUDA hints above plus THIS
// deployment's own settings location (lib/setup-env.js). The service start does
// not go through here — it never reads setup's settings file, so it must not
// carry the variable.
//
// Exported for the tests: the branch is the whole point (XDG_CONFIG_HOME on
// POSIX, APPDATA on Windows), and it can be checked without a real setup run.
export function setupRunEnv(cfg, cuda, platform = process.platform) {
  return withSetupConfigEnv(buildEnv(cfg, cuda), profileStrataDir(cfg), platform);
}

function envSummary(cfg, cuda) {
  if (cuda.hasOwnCuda) {
    return `python 环境自带 CUDA: STRATA_NVCC=${cuda.nvccInEnv}, NVCC_PREPEND_FLAGS="-Xlinker --allow-shlib-undefined", LDFLAGS="-Wl,--allow-shlib-undefined"`;
  }
  return `使用系统 CUDA: ${cuda.nvcc || "未找到 nvcc"}`;
}

// 从插件配置 + Strata 自己的 settings.json 推导数据目录，不新增配置项。
// 优先级：配置自己的 dataDir（必填字段，上一轮已经接管这件事）→ 这套部署自己的
// settings.json（setup 每次都会把 data_dir 写回）→ 旧的全局 settings.json（老部署）
// → 启动配置里 --pack/--native 指向的目录 → 兜底默认。
function deriveDataDir(cfg, platform = process.platform) {
  const fromProfile = profileDataDir(cfg);
  if (fromProfile) return fromProfile;

  for (const settingsPath of strataSettingsPaths(cfg, platform)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (typeof s?.data_dir === "string" && s.data_dir) return s.data_dir;
    } catch {
      /* try the next location */
    }
  }

  // 兜底：从启动配置的 --pack/--native 等路径里找 Strata-data / *-data。
  try {
    const main = JSON.parse(fs.readFileSync(path.resolve(cfg.strataDir, cfg.configFile), "utf8"));
    for (const a of Array.isArray(main?.args) ? main.args : []) {
      if (typeof a !== "string") continue;
      const m = a.match(/^(.*?Strata-data)(?:[\\/]|$)/) || a.match(/^(.*?-data)(?:[\\/]|$)/);
      if (m) return m[1];
    }
  } catch {
    /* fall through */
  }

  return path.resolve(cfg.strataDir, "..", "Strata-data");
}

// Strata stores its settings.json under the platform config dir. Windows uses
// %APPDATA% (roaming) with %LOCALAPPDATA% as a fallback; POSIX uses XDG.
// The Windows locations are UNTESTED.
//
// This deployment's own file comes FIRST: it is where a run started by this App
// writes (setup gets XDG_CONFIG_HOME / APPDATA pointing there, see
// lib/setup-env.js), and on a machine with more than one deployment the shared
// per-user file belongs to whichever one ran last.
function strataSettingsPaths(cfg, platform = process.platform) {
  const own = setupSettingsPath(profileStrataDir(cfg), platform);
  const shared = [];
  if (platform === "win32") {
    const bases = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
    if (!bases.length) bases.push(path.join(os.homedir(), "AppData", "Roaming"));
    shared.push(...bases.map((b) => path.join(b, "Strata", "settings.json")));
  } else {
    shared.push(
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "strata",
        "settings.json",
      ),
    );
  }
  return own ? [own, ...shared] : shared;
}

function backupConfigFiles(cfg) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backups = [];
  let files = [];
  try {
    files = fs.readdirSync(cfg.strataDir).filter((f) => /^strata-.*\.json$/.test(f));
  } catch {
    /* fall through */
  }
  for (const f of files) {
    const src = path.join(cfg.strataDir, f);
    const dst = path.join(cfg.strataDir, `${f}.bak-update-${stamp}`);
    try {
      fs.copyFileSync(src, dst);
      backups.push(path.basename(dst));
    } catch {
      /* best effort */
    }
  }
  return backups;
}

function currentVersion(cwd) {
  try {
    return execFileSync("git", ["describe", "--tags", "--always"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function normalizeTag(tag) {
  const t = String(tag).trim();
  return t.startsWith("v") ? t : `v${t}`;
}

function resolveTargetTag(ctx, cfg, tag) {
  if (tag) return normalizeTag(tag);
  // 版本检查（GitHub latest release）是“最新版本”的唯一来源，与 UI 显示一致。
  const latest = getLatestVersion(ctx).latest;
  if (latest) return normalizeTag(latest);
  // 网络检查失败时，退回本地 git 里最新的语义化 tag。
  try {
    const out = execFileSync("git", ["tag", "--sort=-version:refname"], {
      cwd: cfg.strataDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const first = out.split("\n").filter(Boolean)[0];
    return first ? normalizeTag(first) : null;
  } catch {
    return null;
  }
}

async function performUpdate(ctx, cfg, tag) {
  const python = resolvePython(cfg);
  if (!python.path) throw new Error(python.error || "未找到可用的 Python 解释器");

  const logFile = openLog(cfg);
  state.logFile = logFile;
  log(`\n[${ts()}] ============ Strata 更新开始 ============\n`);
  log(`[${ts()}] 配置: strataDir=${cfg.strataDir}, python=${python.path} (${python.source}), configFile=${cfg.configFile}, port=${resolvePort(cfg)}\n`);

  // 1. 备份配置文件（setup.py --update 会升级这些文件）。
  setStep(1);
  const backups = backupConfigFiles(cfg);
  log(`[${ts()}] 备份配置文件: ${backups.join(", ") || "（无 strata-*.json 可备份）"}\n`);

  // 2. 判断 CUDA 环境。
  setStep(2);
  const cuda = detectCuda(cfg);
  log(`[${ts()}] CUDA 判断: ${envSummary(cfg, cuda)}\n`);

  // 3. 停止服务（精确匹配 + 排除自身，复用已有逻辑）。
  setStep(3);
  const stopped = await stopService(ctx);
  log(`[${ts()}] 停止服务结果: ${JSON.stringify(stopped)}\n`);

  // 4. 拉取最新 tag。
  setStep(4);
  await runCommand("git fetch", "git", ["fetch", "--tags", "--force", "origin"], { cwd: cfg.strataDir });

  // 5. 确定目标 tag 并切换。
  const targetTag = resolveTargetTag(ctx, cfg, tag);
  if (!targetTag) throw new Error("无法确定目标版本（显式 tag、GitHub 最新 release、本地 tag 都不可用）");
  state.tag = targetTag;
  state.oldVersion = currentVersion(cfg.strataDir);
  log(`[${ts()}] 目标版本: ${targetTag}（当前: ${state.oldVersion || "未知"}）\n`);

  setStep(5);
  await runCommand("git checkout", "git", ["checkout", targetTag], { cwd: cfg.strataDir });

  // 6. 执行更新（编译引擎）。
  setStep(6);
  const dataDir = deriveDataDir(cfg);
  const strataDir = profileStrataDir(cfg);
  // setup.py 的 settings.json 只属于这套部署（lib/setup-env.js）：缺失时补一个
  // 正确起点，已存在就交给 setup 自己维护；写不进去只记一行，不中断更新。
  const settings = ensureSetupSettings({ strataDir, dataDir });
  const env = setupRunEnv(cfg, cuda);
  log(`[${ts()}] dataDir=${dataDir}\n`);
  for (const line of describeSetupEnv({ strataDir, settings })) log(`[${ts()}] ${line}\n`);
  await runCommand(
    "setup.py --update",
    python.path,
    updateSetupArgs(path.join(cfg.strataDir, "setup.py"), dataDir),
    { cwd: cfg.strataDir, env },
  );

  // 7. 重启服务。
  setStep(7);
  const started = await startService(ctx);
  log(`[${ts()}] 重启服务结果: ${JSON.stringify(started)}\n`);

  state = {
    ...state,
    running: false,
    step: STEPS.length,
    stepId: "done",
    stepLabel: "完成",
    finishedAt: Date.now(),
    result: { stopped, started },
  };
  log(`[${ts()}] ============ 更新完成 ============\n`);
  closeLog();
}

function handleUpdateError(err) {
  const error = String(err?.message || err);
  log(`[${ts()}] ✗ 更新失败（步骤 ${state.step}/${STEPS.length} ${state.stepLabel || ""}）: ${error}\n`);
  if (err?.tail?.length) {
    log(`[${ts()}] 失败命令最后输出:\n${err.tail.map((l) => `    ${l}`).join("\n")}\n`);
  }
  state = {
    ...state,
    running: false,
    error,
    errorTail: Array.isArray(err?.tail) ? [...err.tail] : [],
    failedStep: state.stepId,
    rollbackHint: state.oldVersion ? `可运行 git checkout ${state.oldVersion} 回滚` : null,
    finishedAt: Date.now(),
  };
  log(`[${ts()}] ============ 更新失败 ============\n`);
  closeLog();
}

function readTail(file, maxBytes = 64 * 1024) {
  return fs.readTailSync(file, maxBytes);
}

export default function registerUpdateRoutes(app, ctx) {
  app.post("/update", async (c) => {
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      /* body 可选 */
    }
    const tag = typeof body?.tag === "string" && body.tag.trim() ? body.tag.trim() : null;

    try {
      if (state.running) {
        return c.json({ error: "已有更新正在进行中", alreadyRunning: true, ...state }, 409);
      }
      if (process.platform === "darwin") {
        return c.json({ ...state, error: "Strata 不支持 macOS" }, 400);
      }
      // Container profiles have no in-app build/rebuild pipeline; refuse the
      // updater instead of forwarding it to docker.
      const status = await getStatus(ctx);
      if (status.profile?.type === "container" || status.launch?.method === "docker") {
        return c.json(
          { ...state, error: "容器配置不支持应用内更新：请在应用外更新镜像/重建容器后重启" },
          400,
        );
      }

      const cfg = await readAllConfig(ctx);
      if (!fs.existsSync(cfg.strataDir)) {
        return c.json({ error: `Strata 目录不存在: ${cfg.strataDir}`, ...state }, 500);
      }
      if (!fs.existsSync(path.join(cfg.strataDir, "setup.py"))) {
        return c.json({ error: `找不到更新脚本: ${path.join(cfg.strataDir, "setup.py")}`, ...state }, 500);
      }
      const python = resolvePython(cfg);
      if (!python.path) {
        return c.json({ error: python.error || "未找到可用的 Python 解释器", ...state }, 500);
      }
      // The update flow fetches a tag with git before running setup.py. git may
      // simply not be installed (common on Windows), so fail with a clear
      // message here instead of deep inside the async update.
      if (!commandExists("git")) {
        return c.json(
          { ...state, error: "未找到 git，无法更新 Strata（更新需要 git 拉取代码）" },
          500,
        );
      }

      state = { ...idleState(), running: true, startedAt: Date.now(), tag: tag || null };
      performUpdate(ctx, cfg, tag).catch(handleUpdateError);
      return c.json(state);
    } catch (e) {
      return c.json({ error: String(e?.message || e), ...state }, 500);
    }
  });

  app.get("/update", (c) => c.json(state));

  app.get("/update/log", (c) => {
    const logFile = state.logFile;
    if (!logFile) return c.json({ path: null, tail: "" });
    return c.json({ path: logFile, tail: readTail(logFile) });
  });
}
