// lib/fsx.js — filesystem compatibility layer for the v2 AppHost sandbox.
//
// WHY THIS EXISTS
// ---------------
// A v2 App entry runs inside the host's AppHost child process under Node's
// Permission Model. The host starts it with, roughly:
//
//   node --permission --allow-fs-read=<installDir> --allow-fs-read=<dataDir> \
//        --allow-fs-write=<dataDir> [--allow-child-process] app-host-entry.js
//
// so `node:fs` can only see the App's own install/data directories. Reading the
// user's Strata directory, `/proc`, or the system Python is denied with
// `ERR_ACCESS_DENIED`. Node also re-injects the same permission flags into the
// NODE_OPTIONS of any Node child (`node -e ...` stays sandboxed too).
//
// External commands, however, are ordinary OS processes and are NOT subject to
// Node's Permission Model (this is exactly what `app/process.spawn` warns about
// in APPS.md). So this module implements the small synchronous `fs` subset the
// copied v1 logic uses by shelling out to coreutils (POSIX) or PowerShell
// (Windows). Everything else in lib/ stays the synchronous v1 code.
//
// The App declares `app/process.spawn`; without that grant these calls throw
// ERR_ACCESS_DENIED just like the raw fs calls would.
import { execFileSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
const MAX_BUFFER = 256 * 1024 * 1024;

// ── POSIX (coreutils) ─────────────────────────────────────────────────────

function posix(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: opts.encoding === undefined ? "utf8" : opts.encoding,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    input: opts.input,
    stdio: opts.stdio,
  });
}

function posixTest(flag, path) {
  try {
    posix("test", [flag, path]);
    return true;
  } catch {
    return false;
  }
}

// ── Windows (PowerShell) ──────────────────────────────────────────────────
//
// UNTESTED on Windows (development host is Linux), same status as the existing
// PowerShell branches in lib/process.js. Paths are single-quoted PowerShell
// literals; PowerShell doubles embedded quotes, so no shell injection.

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psRun(script, opts = {}) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: opts.encoding === undefined ? "utf8" : opts.encoding,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      input: opts.input,
    },
  );
}

function psExists(path) {
  try {
    psRun(`if (Test-Path -LiteralPath ${psQuote(path)}) { exit 0 } else { exit 1 }`);
    return true;
  } catch {
    return false;
  }
}

// ── Public subset (same names/signatures as node:fs sync API) ─────────────

export function existsSync(path) {
  if (IS_WIN) return psExists(path);
  return posixTest("-e", path);
}

export function accessSync(path) {
  if (IS_WIN) {
    psRun(`if (-not (Test-Path -LiteralPath ${psQuote(path)})) { exit 1 }`);
    return;
  }
  if (!posixTest("-e", path)) {
    throw new Error(`ENOENT: no such file or directory, access '${path}'`);
  }
}

export function readFileSync(path, options) {
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (IS_WIN) {
    const b64 = psRun(
      `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(path)}))`,
    ).trim();
    const buf = Buffer.from(b64, "base64");
    return encoding ? buf.toString(encoding) : buf;
  }
  return posix("cat", [path], { encoding: encoding || null });
}

// Resolved symlink target. The process helpers need /proc/<pid>/cwd, and
// `readlink -f` gives the resolved directory in one call (parsing `ls -l` output
// would break on links whose target contains " -> ").
export function readlinkSync(path) {
  if (IS_WIN) {
    const out = psRun(
      `$i = Get-Item -LiteralPath ${psQuote(path)} -Force; if ($i.Target) { [Console]::Out.Write($i.Target) }`,
    );
    return out.trim();
  }
  return posix("readlink", ["-f", path]).replace(/\r?\n$/, "");
}

export function readdirSync(path) {
  if (IS_WIN) {
    const out = psRun(
      `Get-ChildItem -LiteralPath ${psQuote(path)} -Force | Select-Object -ExpandProperty Name`,
    );
    return out.split(/\r?\n/).filter((s) => s !== "");
  }
  return posix("ls", ["-A", "-1", path]).split("\n").filter((s) => s !== "");
}

export function statSync(path) {
  if (IS_WIN) {
    const out = psRun(
      `$f = Get-Item -LiteralPath ${psQuote(path)} -Force; ` +
        `[Console]::Out.Write($f.Length.ToString() + ' ' + [int64]($f.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds + ' ' + $f.PSIsContainer)`,
    ).trim();
    const [size, mtimeMs, isDir] = out.split(/\s+/);
    const dir = String(isDir).toLowerCase() === "true";
    return {
      size: Number(size),
      mtimeMs: Number(mtimeMs),
      isFile: () => !dir,
      isDirectory: () => dir,
    };
  }
  const out = posix("stat", ["-c", "%s %Y", path]).trim();
  const [size, mtimeSec] = out.split(/\s+/);
  const dir = posixTest("-d", path);
  return {
    size: Number(size),
    mtimeMs: Number(mtimeSec) * 1000,
    isFile: () => !dir,
    isDirectory: () => dir,
  };
}

export function writeFileSync(path, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (IS_WIN) {
    psRun(
      `[IO.File]::WriteAllBytes(${psQuote(path)}, [Convert]::FromBase64String([Console]::In.ReadToEnd()))`,
      { input: buf.toString("base64") },
    );
    return;
  }
  execFileSync("tee", [path], {
    input: buf,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

export function appendFileSync(path, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (IS_WIN) {
    psRun(
      `$b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
        `$fs = [IO.File]::Open(${psQuote(path)}, [IO.FileMode]::Append, [IO.FileAccess]::Write); ` +
        `$fs.Write($b, 0, $b.Length); $fs.Close()`,
      { input: buf.toString("base64") },
    );
    return;
  }
  execFileSync("tee", ["-a", path], {
    input: buf,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

export function copyFileSync(src, dst) {
  if (IS_WIN) {
    psRun(`Copy-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(dst)} -Force`);
    return;
  }
  posix("cp", [src, dst]);
}

export function rmSync(path) {
  if (IS_WIN) {
    psRun(`Remove-Item -LiteralPath ${psQuote(path)} -Force -ErrorAction SilentlyContinue`);
    return;
  }
  try {
    posix("rm", ["-f", path]);
  } catch {
    /* force semantics: never throw */
  }
}

export function mkdirSync(path) {
  if (IS_WIN) {
    psRun(`New-Item -ItemType Directory -Force -Path ${psQuote(path)} | Out-Null`);
    return;
  }
  posix("mkdir", ["-p", path]);
}

// Random-access tail read, replacing openSync/fstatSync/readSync/closeSync.
export function readTailSync(path, maxBytes = 512 * 1024) {
  if (IS_WIN) {
    const b64 = psRun(
      `$fs = [IO.File]::OpenRead(${psQuote(path)}); ` +
        `$n = [Math]::Min([int64]${Number(maxBytes)}, $fs.Length); ` +
        `$fs.Seek(-$n, [IO.SeekOrigin]::End) | Out-Null; ` +
        `$buf = New-Object byte[] $n; $fs.Read($buf, 0, $n) | Out-Null; $fs.Close(); ` +
        `[Convert]::ToBase64String($buf)`,
    ).trim();
    return Buffer.from(b64, "base64").toString("utf8");
  }
  try {
    return posix("tail", ["-c", String(maxBytes), path]);
  } catch {
    return "";
  }
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2 };

export default {
  existsSync,
  accessSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  rmSync,
  mkdirSync,
  readTailSync,
  constants,
};
