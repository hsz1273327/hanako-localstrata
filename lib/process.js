import { execFileSync } from "node:child_process";
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

// All PIDs whose command line looks like a Strata server. Empty on failure.
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
