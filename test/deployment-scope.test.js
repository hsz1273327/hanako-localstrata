// Two Strata deployments on one host (1.1.1).
//
// "Is Strata running?" used to be answered with a MACHINE-WIDE
// `pgrep -f serve/server.py`. With a second deployment alive that answer belongs
// to the neighbour, and every lifecycle decision inherited the mistake: the
// stopped profile showed 启动中, its 启动 button returned `already: true` and did
// nothing, and test/setup-env.test.js' start case failed on any host that ran a
// real service.
//
// These tests read the REAL machine. Whatever Strata is running here must never
// be attributed to a temp profile, and a fake sibling is spawned only where a
// process is needed as the thing to point at. Nothing here signals, starts or
// stops any process other than the ones this file spawned itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

import { getStatus, startService, stopService } from "../lib/strata.js";
import {
  belongsToDeployment,
  listStrataPids,
  listStrataPidsFor,
  portListening,
  processCwd,
} from "../lib/process.js";
import { resolvePython } from "../lib/python.js";

const PYTHON = resolvePython({}).path;
const tmpRoots = [];

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Fake plugin ctx: config from a plain object, GitHub offline, loopback served
// by the real fetch (same shape as test/platform.test.js).
function makeCtx(values) {
  const pinned = { ...values };
  return {
    config: {
      async get(key) {
        return pinned[key];
      },
      async set() {},
      async setMany() {},
    },
    network: {
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url?.url || String(url);
        if (href.includes("127.0.0.1") || href.includes("localhost")) return fetch(href, init);
        return { ok: false };
      },
    },
    log: { info() {}, error() {}, warn() {} },
  };
}

// A Strata-shaped folder: the entrypoint plus one config with a port.
function makeDeployment({ port, serverBody = "import time\ntime.sleep(30)\n" } = {}) {
  const dir = tmpDir("strata-deploy-");
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), serverBody);
  fs.writeFileSync(
    path.join(dir, "strata-test.json"),
    JSON.stringify({ port, host: "127.0.0.1", args: [] }),
  );
  return dir;
}

// A real python process whose command line is a Strata server command line —
// the same shape `pgrep -f` used to match machine-wide. `relative` reproduces a
// "cd <folder> && python serve/server.py" launch, which carries no absolute path.
function spawnSibling(dir, { relative = false } = {}) {
  const script = relative ? "serve/server.py" : path.join(dir, "serve", "server.py");
  const child = spawn(PYTHON, [script, "--engine", "strata", "--port", "1"], {
    cwd: dir,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function killQuietly(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── The two signals ───────────────────────────────────────────────────────

test("portListening is one TCP handshake, and nothing else", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  assert.equal(await portListening(port), true, "a bound port answers");
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portListening(port), false, "a closed port does not");
  // A profile with `port: 0` says "no override", which is not a port to probe.
  assert.equal(await portListening(0), false);
  assert.equal(await portListening("not-a-port"), false);
  assert.equal(await portListening(70000), false);
});

test("an unconfigured profile has no processes — not every Strata on the host", () => {
  assert.deepEqual(listStrataPidsFor(""), []);
  assert.deepEqual(listStrataPidsFor("   "), []);
  assert.deepEqual(listStrataPidsFor(undefined), []);
});

// ── A sibling deployment must not be mistaken for ours ────────────────────

test("a sibling deployment's process belongs to its own folder only", async (t) => {
  if (!PYTHON) {
    t.skip("no python3 on this host");
    return;
  }
  const sibling = makeDeployment({ port: await freePort() });
  const ours = makeDeployment({ port: await freePort() });

  const child = spawnSibling(sibling);
  t.after(() => killQuietly(child.pid));

  assert.ok(
    await waitFor(() => listStrataPidsFor(sibling, "linux").includes(child.pid)),
    "a scoped scan of the sibling's own folder sees it",
  );
  assert.ok(
    listStrataPids("linux").includes(child.pid),
    "the machine-wide scan sees it too — that was the bug",
  );
  assert.deepEqual(listStrataPidsFor(ours, "linux"), [], "our folder has no process");
  assert.equal(belongsToDeployment(child.pid, ours, "linux"), false);
  assert.equal(belongsToDeployment(child.pid, sibling, "linux"), true);
});

test("getStatus stays stopped and start() really starts, while a sibling runs", async (t) => {
  if (!PYTHON) {
    t.skip("no python3 on this host");
    return;
  }
  const port = await freePort();
  const ours = makeDeployment({ port });
  const sibling = makeDeployment({ port: await freePort() });

  const child = spawnSibling(sibling);
  t.after(() => killQuietly(child.pid));
  assert.ok(await waitFor(() => listStrataPidsFor(sibling, "linux").length > 0), "the sibling is up");

  let startedPid = null;
  t.after(() => startedPid && killQuietly(startedPid));

  // `port: 0` is the profile saying "use the config's port": resolution stays
  // profile → config → 8080, and nothing here may hard-code 8080.
  const ctx = makeCtx({
    strataDir: ours,
    pythonPath: PYTHON,
    configFile: "strata-test.json",
    port: 0,
    refreshSec: 5,
  });

  const status = await getStatus(ctx, { platform: "linux" });
  assert.equal(
    status.state,
    "stopped",
    `a sibling deployment must not make this profile look alive (got ${status.state})`,
  );
  assert.equal(status.port, port, "the port comes from the profile/config chain");
  assert.equal(status.portConflict, undefined);

  const started = await startService(ctx, { platform: "linux" });
  assert.equal(started.started, true, "start() must not be short-circuited by `already`");
  assert.equal(started.already, undefined);
  assert.ok(Number.isInteger(started.pid) && started.pid > 0);
  startedPid = started.pid;
});

test("a deployment started from inside its folder with a relative path is still ours", async (t) => {
  if (!PYTHON) {
    t.skip("no python3 on this host");
    return;
  }
  const dir = makeDeployment({ port: await freePort() });
  const other = makeDeployment({ port: await freePort() });

  const child = spawnSibling(dir, { relative: true });
  t.after(() => killQuietly(child.pid));

  assert.ok(
    await waitFor(() => listStrataPidsFor(dir, "linux").includes(child.pid)),
    "the cwd identifies a launch that names no absolute path",
  );
  assert.equal(processCwd(child.pid, "linux"), dir);
  assert.equal(belongsToDeployment(child.pid, dir, "linux"), true);
  assert.equal(belongsToDeployment(child.pid, other, "linux"), false);
});

// ── Our port held by someone else ─────────────────────────────────────────

test("a foreign listener on our port is a conflict, not 'starting'", async (t) => {
  const port = await freePort();
  const ours = makeDeployment({ port });

  // Not Strata: an HTTP server that answers 404 to everything, so the plugin's
  // /v1/status probe finishes immediately instead of timing out.
  const blocker = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const ctx = makeCtx({
    strataDir: ours,
    pythonPath: PYTHON || "/usr/bin/python3",
    configFile: "strata-test.json",
    port: 0,
    refreshSec: 5,
  });

  const status = await getStatus(ctx, { platform: "linux" });
  assert.equal(status.state, "stopped");
  assert.equal(status.portConflict, true, "the port is taken, but not by us");

  // Starting anyway would spawn a server that cannot bind; say why instead.
  const started = await startService(ctx, { platform: "linux" });
  assert.equal(started.started, false);
  assert.match(String(started.error), /端口/);
});

// ── Scope of the stop path ────────────────────────────────────────────────

test("stop asks for this deployment's processes only", async () => {
  const dir = makeDeployment({ port: 18000 });
  const calls = [];
  const result = await stopService(makeCtx({ strataDir: dir }), {
    platform: "linux",
    processes: {
      list: (strataDir, platform) => {
        calls.push([strataDir, platform]);
        return [];
      },
      children: () => [],
      kill: () => false,
      alive: () => false,
      isStrata: () => false,
    },
  });
  assert.deepEqual(calls[0], [dir, "linux"], "the process list is asked about THIS folder");
  assert.equal(result.stopped, false);
  assert.equal(result.already, true, "nothing of ours to stop is an idempotent success");
});

// ── The live machine ──────────────────────────────────────────────────────

test("a real Strata running on this host never leaks into a temp profile", async () => {
  const live = listStrataPids(process.platform);
  const dir = makeDeployment({ port: await freePort() });
  const ctx = makeCtx({
    strataDir: dir,
    pythonPath: PYTHON || "/usr/bin/python3",
    configFile: "strata-test.json",
    port: 0,
    refreshSec: 5,
  });

  const status = await getStatus(ctx, { platform: process.platform });
  // On a busy host (`live.length > 0`) this IS the regression; on an idle host
  // it pins that a stopped profile stays stopped.
  assert.deepEqual(listStrataPidsFor(dir, process.platform), [], `machine-wide: ${live.length} pid(s)`);
  assert.notEqual(status.state, "starting");
  assert.notEqual(status.state, "running");
});
