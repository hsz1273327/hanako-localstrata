import * as fs from "./fsx.js";
import { commandExists } from "./process.js";

// Resolves which Python interpreter to use. An explicit pythonPath always wins
// when it exists; an empty value falls back to a platform default (fixed paths
// first on Linux, PATH lookup of the usual launchers on Windows). `source`
// records the branch taken so callers (e.g. the update flow's CUDA detection)
// can tell a configured env from the system.
// Returns { path, source } on success, or { path: null, source, error }.
export function resolvePython(cfg, platform = process.platform) {
  const configured = String(cfg?.pythonPath || "").trim();
  if (configured) {
    if (fs.existsSync(configured)) return { path: configured, source: "configured" };
    return {
      path: null,
      source: "missing",
      error: `配置的 Python 不存在: ${configured}`,
    };
  }

  if (platform === "win32") {
    // Windows has no fixed interpreter path. Prefer the python.org launchers,
    // then the py launcher (which lives in C:\Windows and is on PATH).
    for (const name of ["python.exe", "python3.exe", "py.exe"]) {
      const found = commandExists(name, platform);
      if (found) return { path: found, source: "system-path" };
    }
    return {
      path: null,
      source: "missing",
      error: "未找到系统 Python（可在设置里指定解释器，或安装 python.org 版本 / py launcher）",
    };
  }

  // Linux/macOS: fixed paths first, then PATH.
  for (const p of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (fs.existsSync(p)) return { path: p, source: "system" };
  }
  const fromPath = commandExists("python3", platform);
  if (fromPath) return { path: fromPath, source: "system-path" };
  return {
    path: null,
    source: "missing",
    error: "未找到系统 python3（可在设置里指定 Python 解释器）",
  };
}
