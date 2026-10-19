import { execFileSync } from "node:child_process";
import net from "node:net";
import * as fs from "./fsx.js";
import path from "node:path";

// ── Cross-platform process helpers ────────────────────────────────────────
//
// Every external command here is executed via execFileSync(cmd, [args...]),
// never through a shell, so patterns/paths can't be shell-injected and the
// behavior is identical regardless of the user's shell.
//
// Platform support:
//   linux  : pgrep -f / pgrep -P / /proc/<pid>/cmdline   (tested, primary)
//   darwin : same as linux, but Strata itself is blocked in getStatus()
//   win32  : PowerShell Get-CimInstance Win32_Process    (UNTESTED — see notes)
//
// The optional `platform` argument exists so tests can exercise the Windows
// branch on a Linux host. Production callers omit it and get process.platform.

export function getPlatform(explicit) {
  return explicit || process.platform;
}

// Command-line fragments that identify a running Strata server.
// POSIX: an extended regex for `pgrep -f`. It requires "python" *before* the
// script path, so the process performing the check (node / a shell / git)
// can never match itself — the same trap that makes plain `pkill -f
// "serve/server.py"` dangerous.
// Windows: plain substrings; the absolute path uses backslashes, but relative
// invocations may use forward slashes, so accept either separator.
const STRATA_POSIX_PATTERN = "python.*serve/server\\.py";
const STRATA_WIN_NEEDLES = ["serve\\server.py", "serve/server.py"];

function parsePidLines(out) {
  return String(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Run a command, returning stdout as text or null on any failure. We use
// execFileSync (not a shell) and windowsHide so no console window flashes.
function runCapture(cmd, args, timeout) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

// Quote a value for a single-quoted PowerShell string literal.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psRun(script, timeout) {
  return runCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeout,
  );
}

// Escape a path for a POSIX extended regex (`pgrep -f`). A deployment folder can
// legitimately be called ".strata", "strata(app)" or "strata-1.1", and an
// unescaped pattern would silently match a different path.
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All PIDs whose command line looks like a Strata server — MACHINE-WIDE.
// Diagnostics only (and "is this host busy at all" questions). Every lifecycle
// decision must use listStrataPidsFor() below: with two deployments on one
// machine this answer belongs to neither of them.
export function listStrataPids(platform = process.platform) {
  if (getPlatform(platform) === "win32") {
    // UNTESTED on Windows. Get-CimInstance is the supported replacement for
    // the deprecated wmic. CommandLine is only exposed by Win32_Process, so we
    // filter in PowerShell rather than using a -Filter query.
    const conds = STRATA_WIN_NEEDLES.map(
      (n) => `$_.CommandLine -like ${psQuote(`*${n}*`)}`,
    ).join(" -or ");
    const script = `Get-CimInstance Win32_Process | Where-Object { ${conds} } | Select-Object -ExpandProperty ProcessId`;
    const out = psRun(script, 8000);
    return out ? parsePidLines(out) : [];
  }
  const out = runCapture("pgrep", ["-f", STRATA_POSIX_PATTERN], 3000);
  return out ? parsePidLines(out) : [];
}

// ── One deployment, not the whole machine ─────────────────────────────────
//
// A machine can host several Strata deployments at once (a CUDA card and an ROCm
// card, two checkouts, a container next to a source install). "Is Strata
// running?" is therefore the wrong question: getStatus' starting/stopped,
// start's `already` and stop's kill list must each be about ONE deployment —
// the one a profile points at. The machine-wide scan above cannot answer that,
// and using it made two deployments see each other: the stopped one reported
// 启动中, its 启动 button returned `already: true` and did nothing, and 停止
// would have signalled the neighbour's process (reported 2026-10-19, two
// deployments of the same Strata on one host).
//
// Two independent, READ-ONLY pieces of evidence identify a deployment:
//   · its port   — a listener accepts one TCP handshake. Cheap and exact, and
//     the port always comes from the profile's own resolution chain
//     (profile.port → the selected config's `port` → 8080), never a constant
//     written here.
//   · its files  — the command line names <strataDir>/serve/server.py, or the
//     process runs with <strataDir> as its cwd (a launch from inside the folder
//     that used the relative path).
// Nothing in this section ever signals, starts or stops a process.

// Is anything accepting TCP connections on this port? One handshake, then an
// immediate close: no request line, no payload, nothing the listener acts on.
// node:net instead of ss/lsof/netstat — those are absent on many hosts, their
// output formats differ per platform, and under the AppHost sandbox each one
// would be another subprocess on the status poll path.
export function portListening(port, { host = "127.0.0.1", timeoutMs = 400 } = {}) {
  const n = Number(port);
  // 0 / "0" is how a profile says "no override" — not a port to probe.
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ port: n, host });
    // A probe must never keep the host process alive.
    socket.unref();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false)); // ECONNREFUSED / EHOSTUNREACH
  });
}

// Working directory of a PID, or "" when it cannot be read. /proc/<pid>/cwd is
// a symlink, and Node's own fs is denied outside the App's folders, so this
// goes through fsx (coreutils `readlink -f`).
export function processCwd(pid, platform = process.platform) {
  if (getPlatform(platform) === "win32") return "";
  try {
    return fs.readlinkSync(`/proc/${Number(pid)}/cwd`).trim();
  } catch {
    return "";
  }
}

function normalizeDir(value, isWin) {
  const resolved = path.resolve(String(value));
  return isWin ? resolved.replace(/\//g, "\\").toLowerCase() : resolved;
}

// Does this PID's command line belong to the deployment at `strataDir`?
// Absolute entrypoint inside that folder → yes. No absolute entrypoint at all
// (a "cd <folder> && python serve/server.py" launch) → only when the process cwd
// IS that folder; anything with an absolute entrypoint elsewhere is a sibling
// deployment and must not match.
export function belongsToDeployment(pid, strataDir, platform = process.platform) {
  const dir = String(strataDir || "").trim();
  if (!dir) return false;
  const isWin = getPlatform(platform) === "win32";
  const cmd = processCommandLine(pid, platform);
  if (!cmd || !isStrataCommandLine(cmd)) return false;

  const text = isWin ? cmd.replace(/\//g, "\\").toLowerCase() : cmd;
  const root = normalizeDir(dir, isWin);
  const entry = isWin ? `${root}\\serve\\server.py` : `${root}/serve/server.py`;
  if (text.includes(entry)) return true;

  // An absolute server.py somewhere else: this process belongs to that other
  // deployment, whatever its cwd happens to be.
  const absoluteEntry = /(?:^|\s)(?:\/|[A-Za-z]:[\\/])[^\s]*serve[\\/]server\.py/.test(text);
  if (absoluteEntry) return false;

  const cwd = processCwd(pid, platform);
  return !!cwd && normalizeDir(cwd, isWin) === root;
}

// PIDs of the Strata server belonging to ONE deployment. Never machine-wide: an
// empty/blank strataDir answers [] (a profile that is not configured has no
// process), not "every Strata on this host".
export function listStrataPidsFor(strataDir, platform = process.platform) {
  const dir = String(strataDir || "").trim();
  if (!dir) return [];

  if (getPlatform(platform) === "win32") {
    // UNTESTED on Windows, same status as listStrataPids. The -like needles
    // carry the deployment's own path, so this is scoped by construction.
    const root = path.resolve(dir);
    const conds = [`${root}\\serve\\server.py`, `${root}/serve/server.py`]
      .map((needle) => `$_.CommandLine -like ${psQuote(`*${needle}*`)}`)
      .join(" -or ");
    const script = `Get-CimInstance Win32_Process | Where-Object { ${conds} } | Select-Object -ExpandProperty ProcessId`;
    const out = psRun(script, 8000);
    return out ? parsePidLines(out) : [];
  }

  const root = path.resolve(dir);
  // Narrow first: the pattern carries THIS deployment's own entrypoint.
  const narrow = runCapture("pgrep", ["-f", `python.*${escapeRegex(`${root}/serve/server.py`)}`], 3000);
  const found = narrow ? parsePidLines(narrow) : [];
  if (found.length) return found;

  // Nothing names the absolute path: the server may have been started from
  // inside the folder with the relative one. Here pgrep is only the candidate
  // filter; belongsToDeployment decides, so a sibling deployment cannot pass.
  const broad = runCapture("pgrep", ["-f", STRATA_POSIX_PATTERN], 3000);
  return parsePidLines(broad).filter((pid) => belongsToDeployment(pid, root, platform));
}

// Direct children of a PID. The Strata engine + vision helpers run as child
// processes, so they must be stopped together with the parent.
export function listChildren(pid, platform = process.platform) {
  if (getPlatform(platform) === "win32") {
    // UNTESTED on Windows.
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${Number(pid)} } | Select-Object -ExpandProperty ProcessId`;
    const out = psRun(script, 8000);
    return out ? parsePidLines(out) : [];
  }
  const out = runCapture("pgrep", ["-P", String(pid)], 2000);
  return out ? parsePidLines(out) : [];
}

// Full command line of a PID, or "" when it cannot be read.
export function processCommandLine(pid, platform = process.platform) {
  if (getPlatform(platform) === "win32") {
    // UNTESTED on Windows.
    const script = `(Get-CimInstance Win32_Process -Filter ${psQuote(`ProcessId = ${Number(pid)}`)}).CommandLine`;
    const out = psRun(script, 5000);
    return out ? out.trim() : "";
  }
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// True when a command line belongs to Strata (the server entrypoint or the
// product name). Used to validate a PID recorded in our pidfile before we kill
// it, so a recycled PID can never make us terminate an unrelated process.
export function isStrataCommandLine(cmd) {
  const text = String(cmd || "");
  if (!text) return false;
  return (
    text.includes("serve/server.py") ||
    text.includes("serve\\server.py") ||
    text.toLowerCase().includes("strata")
  );
}

// Node-native kill. On POSIX this sends the signal; on Windows Node maps it to
// TerminateProcess. Returns true when the call was accepted.
export function killPid(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Existence check that works on both platforms (signal 0).
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

// Resolve a command name to an absolute path via PATH, honoring Windows
// PATHEXT (so "git" finds git.exe). Returns the path, or null when not found.
// Used for optional dependencies such as git during the update flow.
export function commandExists(name, platform = process.platform) {
  const isWin = getPlatform(platform) === "win32";
  const exts = isWin
    ? ["", ...String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const hasExt = ext && name.toLowerCase().endsWith(ext.toLowerCase());
      const candidate = path.join(dir, hasExt ? name : name + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
