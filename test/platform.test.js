// Cross-platform / regression tests for the Strata plugin.
//
// Run with:  node --test test/
//
// These tests run on Linux (the primary platform). The macOS branch is exercised
// through the injectable `platform` option; the Windows branch is only smoke
// tested for "does not throw on Linux" because it needs PowerShell.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { getStatus, resolvePort, applyConfigEdits, getConfigView, pickConfigFile } from "../lib/strata.js";
import { needsInitialSetup } from "../lib/firstrun.js";
import { resolvePython } from "../lib/python.js";
import {
  listStrataPids,
  listChildren,
  processCommandLine,
  isStrataCommandLine,
  pidExists,
  commandExists,
  killPid,
} from "../lib/process.js";

const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-test-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// Fake plugin ctx: config comes from a plain object, and network.fetch rejects
// immediately so getStatus never touches the real GitHub API.
function makeCtx(values) {
  // Pin the deploy mode to local so the source-mode regression tests never
  // touch the machine's real docker/image state. 1.1.0 has no auto switching;
  // an unset deployMode would run the first-run image detection once.
  const pinned = { deployMode: "local", ...values };
  return {
    config: {
      async get(key) {
        return pinned[key];
      },
      async set() {},
      async setMany() {},
    },
    network: {
      // getStatus now reaches the local Strata API through ctx.network.fetch
      // (the AppHost blocks bare fetch). Serve loopback from the real global
      // fetch, but keep the GitHub version check offline.
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url?.url || String(url);
        if (href.includes("127.0.0.1") || href.includes("localhost")) {
          return fetch(href, init);
        }
        return { ok: false };
      },
    },
    log: { info() {}, error() {}, warn() {} },
  };
}

// A Strata dir with the server entrypoint + optional config files.
function makeStrataDir({ config = null } = {}) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), "# fake\n");
  if (config) fs.writeFileSync(path.join(dir, config.name), JSON.stringify(config.data));
  return dir;
}

// ── macOS interception ────────────────────────────────────────────────────

test("darwin platform is rejected before any config/filesystem access", async () => {
  const ctx = {
    // getStatus must return before readAllConfig() is ever called.
    config: {
      get() {
        throw new Error("config should not be read on macOS");
      },
    },
  };
  const status = await getStatus(ctx, { platform: "darwin" });
  assert.equal(status.state, "unsupported");
  assert.equal(status.platform, "macos");
  assert.deepEqual(status.supportedPlatforms, ["win32", "linux"]);
  assert.match(status.reason, /macOS/);
  assert.equal(status.projectUrl, "https://github.com/Niko1221/Strata");
});

test("darwin blocks startService (no spawn)", async () => {
  const { startService } = await import("../lib/strata.js");
  const result = await startService(makeCtx({ strataDir: "/nope" }), { platform: "darwin" });
  assert.equal(result.started, false);
  assert.equal(result.state, "unsupported");
});

// ── Linux status states (regression) ──────────────────────────────────────

test("unconfigured when strataDir is empty", async () => {
  const status = await getStatus(makeCtx({ strataDir: "" }));
  assert.equal(status.state, "unconfigured");
});

test("not-installed when serve/server.py is missing", async () => {
  const dir = tmpDir();
  const status = await getStatus(makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3" }));
  assert.equal(status.state, "not-installed");
  assert.equal(status.serverScript, path.join(dir, "serve", "server.py"));
});

test("python-missing when configured interpreter does not exist", async () => {
  const dir = makeStrataDir();
  const status = await getStatus(
    makeCtx({ strataDir: dir, pythonPath: path.join(dir, "does-not-exist-python") }),
  );
  assert.equal(status.state, "python-missing");
  assert.match(String(status.error), /Python/);
});

test("no-config when there are no strata-*.json files", async () => {
  const dir = makeStrataDir();
  const status = await getStatus(makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3" }));
  assert.equal(status.state, "no-config");
  assert.deepEqual(status.configCandidates, []);
});

test("auto-selects the newest config when none is selected (no setup)", async () => {
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port: 18080 } } });
  const status = await getStatus(makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3" }));
  // The config field is an optional override now: an existing config is found
  // automatically, so the first-run path is not entered (zero regression).
  assert.notEqual(status.state, "no-config");
  assert.notEqual(status.state, "needs-config");
  assert.equal(status.configFile, "strata-demo.json");
  assert.equal(status.autoSelected, true);
  assert.equal(needsInitialSetup(status), false);
});

test("pickConfigFile prefers the most recently used config", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "strata-old.json"), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(dir, "strata-new.json"), JSON.stringify({ port: 2 }));
  // Make the mtime ordering explicit rather than relying on write order.
  fs.utimesSync(path.join(dir, "strata-old.json"), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(dir, "strata-new.json"), new Date(2000), new Date(2000));
  const candidates = ["strata-old.json", "strata-new.json"].map((file) => ({ file }));
  assert.equal(pickConfigFile(dir, candidates), "strata-new.json");
  assert.equal(pickConfigFile(dir, []), "");
});

test("config selected but no server on this port: stopped or starting", async () => {
  // This host runs a real Strata process, so getStatus reports "starting" from
  // process presence; on a clean host it would be "stopped". Both are valid
  // here — the point is that the config-selected branch is reached (not
  // needs-config / no-config).
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port: 18081 } } });
  const status = await getStatus(
    makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json" }),
  );
  assert.ok(["stopped", "starting"].includes(status.state), `unexpected state ${status.state}`);
  if (status.state === "starting") assert.ok(status.pids.length > 0);
  assert.equal(status.port, 18081);
  assert.deepEqual(status.configCandidates.map((c) => c.file), ["strata-demo.json"]);
});

test("running when /v1/status answers", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "strata", model: "fake", engine: "9.9.9", uptime_s: 1 }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port } } });
    const status = await getStatus(
      makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json" }),
    );
    assert.equal(status.state, "running");
    assert.equal(status.version.local, "9.9.9");
    assert.equal(status.port, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Windows branch: smoke test only (no PowerShell here) ──────────────────

test("win32 branch does not throw on a Linux host", async () => {
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port: 18082 } } });
  const status = await getStatus(
    makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json" }),
    { platform: "win32" },
  );
  assert.ok(typeof status.state === "string");
});

// ── Python resolution ─────────────────────────────────────────────────────

test("resolvePython honors an explicit existing path", () => {
  const r = resolvePython({ pythonPath: "/usr/bin/python3" });
  assert.equal(r.path, "/usr/bin/python3");
  assert.equal(r.source, "configured");
});

test("resolvePython reports a missing configured path", () => {
  const r = resolvePython({ pythonPath: "/no/such/python" });
  assert.equal(r.path, null);
  assert.equal(r.source, "missing");
});

test("resolvePython falls back to the system python3", () => {
  const r = resolvePython({ pythonPath: "" });
  assert.ok(r.path, "expected a system python3 to be found");
  assert.ok(["system", "system-path"].includes(r.source));
});

test("resolvePython win32 branch does not throw", () => {
  const r = resolvePython({ pythonPath: "" }, "win32");
  assert.ok(r.source === "missing" || r.path);
});

// ── Process helpers (Linux) ───────────────────────────────────────────────

test("listStrataPids returns integer PIDs", () => {
  const pids = listStrataPids("linux");
  assert.ok(Array.isArray(pids));
  for (const pid of pids) assert.ok(Number.isInteger(pid) && pid > 0);
});

test("processCommandLine reads /proc for the current process", () => {
  const cmd = processCommandLine(process.pid, "linux");
  assert.match(cmd, /node/);
});

test("isStrataCommandLine recognizes the server entrypoint", () => {
  assert.equal(isStrataCommandLine("python /data/Strata/serve/server.py --port 8080"), true);
  assert.equal(isStrataCommandLine("python C:\\Strata\\serve\\server.py"), true);
  assert.equal(isStrataCommandLine("node unrelated.js"), false);
  assert.equal(isStrataCommandLine(""), false);
});

test("pidExists is true for the current process, false for a dead PID", () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(2147483647), false);
});

test("listChildren returns an array", () => {
  assert.ok(Array.isArray(listChildren(process.pid, "linux")));
});

test("commandExists finds git on this host", () => {
  const p = commandExists("git", "linux");
  assert.ok(p, "git should be resolvable via PATH");
  assert.ok(fs.existsSync(p));
});

test("killPid returns false for a non-existent PID", () => {
  assert.equal(killPid(2147483647, "SIGTERM"), false);
});

// ── Port resolution ───────────────────────────────────────────────────────

test("resolvePort prefers the plugin override, then the config file", () => {
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port: 12345 } } });
  const cfg = { strataDir: dir, configFile: "strata-demo.json" };
  assert.equal(resolvePort({ ...cfg, port: 9999 }), 9999);
  assert.equal(resolvePort({ ...cfg, port: 0 }), 12345);
});

// ── Source config editing (routes/settings.js path) ──────────────────────

test("source applyConfigEdits edits main + shared files and backs them up", async () => {
  const dir = makeStrataDir();
  fs.writeFileSync(
    path.join(dir, "strata-demo.json"),
    JSON.stringify({ args: ["--max-context", "32768", "--kv", "int8"], port: 18083, sampling: { temperature: 0.7 } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "strata-demo.shared-settings.json"), JSON.stringify({ max_tokens: 4096 }, null, 2));

  const ctx = makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json" });
  const result = await applyConfigEdits(ctx, { context: 65536, max_tokens: 8192 });
  assert.equal(result.saved, true);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.diff.map((d) => d.key).sort(), ["context", "max_tokens"]);
  assert.equal(result.backups.length, 2);

  const view = await getConfigView(ctx);
  assert.equal(view.hasConfig, true);
  assert.equal(view.values.context, 65536);
  assert.equal(view.values.max_tokens, 8192);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes(".bak-")));
});

test("source applyConfigEdits rejects unknown fields", async () => {
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { args: [], port: 18084 } } });
  fs.writeFileSync(path.join(dir, "strata-demo.shared-settings.json"), JSON.stringify({}, null, 2));
  const ctx = makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json" });
  await assert.rejects(() => applyConfigEdits(ctx, { nope: 1 }), /未知字段: nope/);
});
