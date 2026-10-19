// lib/setup-env.js — setup.py's settings file, kept inside the deployment.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// `setup.py:settings_path()` keeps ONE settings file per USER, and setup reads
// exactly two keys out of it:
//
//   { "data_dir": "<the last --data-dir>", "installs": ["<every folder setup ran from>", …] }
//
// `data_folder()` (its "move the model files here" step) then treats the
// remembered `data_dir` AND every entry of `installs` as places an older
// installation left `models` / `packs` / `mtp` in, and MOVES them into the
// current run's `--data-dir`. One file per user therefore means one file for
// every deployment on the machine: two source checkouts (say `strata-cuda` +
// `cudadata`, `strata-rocm` + `rocmdata`) overwrite each other's value, and the
// next setup run of the other one "migrates" the first one's data into its own
// folder. That has happened twice for real.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
// A per-deployment environment, not another field for the user to fill in: a
// local profile's setup run gets its config home pointed inside its own Strata
// directory, so setup reads and writes `<strataDir>/.config/...` and never sees
// the shared file again. Nothing appears in the UI; a container profile is
// untouched (its setup runs inside the container, against `/gguf` and its own
// mounts).
//
// ── THE PLATFORM BRANCH IS setup.py's, NOT OURS ──────────────────────────
// setup.py:3478 reads:
//
//   if WIN:  %APPDATA%/Strata/settings.json          ← capital S, XDG is IGNORED
//   else:    $XDG_CONFIG_HOME/strata/settings.json   ← lower case
//
// So Windows must be given APPDATA (setting XDG_CONFIG_HOME there does
// nothing), and the leaf folder differs in case. Both are decided by
// `process.platform === "win32"`, the same test the rest of lib/ uses.
import path from "node:path";
import * as fs from "./fsx.js";

// The folder we put the config home in, inside the deployment's own directory.
export const CONFIG_HOME_DIR = ".config";

// The leaf folder setup.py itself asks for. Same names as `settings_path()`.
const LEAF = { win32: "Strata", posix: "strata" };

function isWin(platform) {
  return platform === "win32";
}

function leafOf(platform) {
  return isWin(platform) ? LEAF.win32 : LEAF.posix;
}

// The Strata directory a profile runs from. A local profile owns it; the flat
// `cfg.strataDir` mirrors the active profile (see readAllConfig), so one of the
// two is always the answer.
export function profileStrataDir(cfg) {
  return String(cfg?.activeProfile?.strataDir || cfg?.strataDir || "").trim();
}

// Where THIS deployment's setup keeps its `data_dir` memory (the field the
// profile owns, required for a local profile).
export function profileDataDir(cfg) {
  return String(cfg?.activeProfile?.dataDir ?? "").trim();
}

// `<strataDir>/.config`, or "" when there is no Strata directory yet. The home
// itself is the same on every platform; only the variable that points at it, and
// the leaf folder inside it, differ.
export function setupConfigHome(strataDir) {
  const dir = String(strataDir ?? "").trim();
  if (!dir) return "";
  return path.join(dir, CONFIG_HOME_DIR);
}

// The exact file setup.py will read and write for this deployment.
export function setupSettingsPath(strataDir, platform = process.platform) {
  const home = setupConfigHome(strataDir);
  if (!home) return "";
  return path.join(home, leafOf(platform), "settings.json");
}

// The environment variable setup.py actually consults on this platform, for log
// lines ("XDG_CONFIG_HOME=…" / "APPDATA=…").
export function setupConfigVarName(platform = process.platform) {
  return isWin(platform) ? "APPDATA" : "XDG_CONFIG_HOME";
}

// The one-variable patch a setup/install run needs. Empty when the deployment
// has no directory yet (nothing to point at — setup's own default stands).
export function setupConfigEnv(strataDir, platform = process.platform) {
  const home = setupConfigHome(strataDir);
  if (!home) return {};
  return { [setupConfigVarName(platform)]: home };
}

// The environment for a setup-class child process: what the caller already
// wanted (its own hints, `process.env`) plus this deployment's config home.
// Always a NEW object — `buildEnv` may hand back `process.env` itself, and
// mutating that would leak the variable into every later spawn (including the
// service start, which must not see it).
export function withSetupConfigEnv(env, strataDir, platform = process.platform) {
  return { ...(env || process.env), ...setupConfigEnv(strataDir, platform) };
}

// First-run bootstrap of `<strataDir>/.config/<leaf>/settings.json`.
//
//   missing      → write `{ data_dir, installs: [strataDir] }`, setup's own shape
//                  (indent 1, the two keys it maintains);
//   already there → leave it ALONE. setup rewrites `data_dir` and `installs` on
//                  every run; overwriting it would throw away what it learned and
//                  re-create the very "who ran last" race this file prevents;
//   no dataDir   → skip. A settings file without a `data_dir` is worse than none
//                  (setup would fall back to `ROOT.parent / "Strata-data"` while
//                  believing it read a value), so leave setup its own default and
//                  let the caller warn;
//   unwritable   → report, never throw: a read-only Strata directory must not stop
//                  the start chain.
//
// Returns `{ path, created, reason, error }`; `reason` is one of "created",
// "exists", "no-data-dir", "no-strata-dir", "write-failed".
export function ensureSetupSettings({ strataDir, dataDir, platform = process.platform } = {}) {
  const dir = String(strataDir ?? "").trim();
  const settingsPath = setupSettingsPath(dir, platform);
  if (!settingsPath) return { path: "", created: false, reason: "no-strata-dir", error: null };

  const wanted = String(dataDir ?? "").trim();
  if (!wanted) return { path: settingsPath, created: false, reason: "no-data-dir", error: null };

  if (fs.existsSync(settingsPath)) {
    return { path: settingsPath, created: false, reason: "exists", error: null };
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const body = JSON.stringify({ data_dir: wanted, installs: [dir] }, null, 1);
    fs.writeFileSync(settingsPath, body);
    return { path: settingsPath, created: true, reason: "created", error: null };
  } catch (err) {
    return {
      path: settingsPath,
      created: false,
      reason: "write-failed",
      error: String(err?.message || err),
    };
  }
}

// One log line per setup run, so a later diagnosis can see WHICH settings file
// that run read — the "which deployment owns this install" question the shared
// file used to make unanswerable. Best effort: never throws, never blocks.
export function describeSetupEnv({ strataDir, settings, platform = process.platform } = {}) {
  const lines = [];
  const env = setupConfigEnv(strataDir, platform);
  const varName = setupConfigVarName(platform);
  if (env[varName]) lines.push(`${varName}=${env[varName]}`);
  if (settings?.created) lines.push(`setup settings: 写入 ${settings.path}`);
  else if (settings?.reason === "no-data-dir") {
    lines.push(`setup settings: 跳过（这套配置没有数据目录，交给 setup 的默认行为）: ${settings.path}`);
  } else if (settings?.reason === "write-failed") {
    lines.push(`setup settings: 写入失败 ${settings.path}（${settings.error}），继续运行 setup`);
  }
  return lines;
}
