// First-launch tests (1.1.0 batch 2 + batch 3).
//
// First launch is a LOCAL (source) concern only: the MI50 container's own
// entrypoint performs its setup. These tests cover the pure staging/plan
// helpers, the background first-run job (with an injected io so nothing real
// is spawned), and the "existing config never enters setup" regression.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  FIRST_RUN_STAGES,
  needsInitialSetup,
  initialSetupPlan,
  classifySetupLine,
  beginFirstRun,
  getFirstRunState,
  resetFirstRunState,
} from "../lib/firstrun.js";
import { getStatus } from "../lib/strata.js";

const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-firstrun-"));
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

function makeStrataDir({ config = null } = {}) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), "# fake\n");
  fs.writeFileSync(path.join(dir, "setup.py"), "# fake\n");
  if (config) fs.writeFileSync(path.join(dir, config.name), JSON.stringify(config.data));
  return dir;
}

function makeCtx(values = {}) {
  const pinned = { ...values };
  return {
    config: {
      values: pinned,
      async get(key) {
        return pinned[key];
      },
      async set(key, value) {
        pinned[key] = value;
      },
      async setMany(patch) {
        Object.assign(pinned, patch);
      },
    },
    network: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
    log: { info() {}, warn() {}, error() {} },
  };
}

function waitForDone(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const s = getFirstRunState();
      if (s.done || s.error || Date.now() > deadline) resolve(s);
      else setTimeout(tick, 5);
    };
    tick();
  });
}

// ── Pure helpers ──────────────────────────────────────────────────────────

test("needsInitialSetup: local no-config is a first run, existing config is not", () => {
  assert.equal(needsInitialSetup({ state: "no-config", launch: { method: "local" } }), true);
  assert.equal(needsInitialSetup({ state: "stopped", launch: { method: "local" } }), false);
  assert.equal(needsInitialSetup({ state: "running", launch: { method: "local" } }), false);
  assert.equal(needsInitialSetup({ state: "unsupported" }), false);
  // The MI50 container's entrypoint runs its own setup.
  assert.equal(needsInitialSetup({ state: "no-config", launch: { method: "docker" } }), false);
  assert.equal(needsInitialSetup({ state: "no-config", method: "docker" }), false);
});

test("initialSetupPlan flags a possible large download when ggufDir is empty", () => {
  const status = { state: "no-config", launch: { method: "local" } };
  const withGguf = initialSetupPlan(status, { ggufDir: "/models/x" });
  assert.equal(withGguf.needed, true);
  assert.equal(withGguf.mode, "local");
  assert.equal(withGguf.ggufDir, "/models/x");
  assert.equal(withGguf.mayDownload, false);
  assert.deepEqual(withGguf.stages, FIRST_RUN_STAGES);

  const noGguf = initialSetupPlan(status, { ggufDir: "" });
  assert.equal(noGguf.mayDownload, true);

  const existing = initialSetupPlan({ state: "stopped", launch: { method: "local" } }, {});
  assert.equal(existing.needed, false);
});

test("classifySetupLine maps setup.py steps to download / convert", () => {
  assert.equal(classifySetupLine("=== Step 5: downloading qwen IQ2_XS ==="), "download");
  assert.equal(classifySetupLine("=== Step 6: preparing the model for Strata ==="), "convert");
  assert.equal(classifySetupLine("  Downloading from Hugging Face"), "download");
  assert.equal(classifySetupLine("  Converting the Q2_0 experts ..."), "convert");
  assert.equal(classifySetupLine("random line"), null);
});

// ── Background job (injected io) ──────────────────────────────────────────

test("local first run spawns setup.py with --gguf-dir, selects the config and starts", async () => {
  resetFirstRunState();
  const dir = makeStrataDir();
  const gguf = "/models/UD-Q4_K_XL";
  let spawnedArgs = null;
  let saved = null;
  let statusCalls = 0;
  let startMethod = null;

  const io = {
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { state: "no-config", launch: { method: "local" }, settings: {}, configCandidates: [] }
        : { state: "running", launch: { method: "local" } };
    },
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: gguf, configFile: "" }),
    saveSelectedConfig: async (_ctx, file) => {
      saved = file;
    },
    startService: async (_ctx, opts) => {
      startMethod = opts?.launchMethod;
      return { started: true, state: "starting", pid: 4242 };
    },
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("=== Step 5: downloading qwen IQ2_XS ===\n"));
        child.stdout.emit("data", Buffer.from("=== Step 6: preparing the model for Strata ===\n"));
        fs.writeFileSync(
          path.join(dir, "strata-iq2_xs.json"),
          JSON.stringify({ args: ["--max-context", "32768"], port: 8099 }),
        );
        child.emit("close", 0);
      });
      return child;
    },
  };

  const started = await beginFirstRun(makeCtx({ strataDir: dir, ggufDir: gguf }), { io });
  assert.equal(started.needed, true);
  assert.equal(started.firstRun, true);
  assert.equal(started.mayDownload, false);

  const state = await waitForDone();
  assert.equal(state.error, null);
  assert.equal(state.done, true);
  assert.equal(state.stage, "done");
  assert.ok(spawnedArgs, "setup.py should have been spawned");
  assert.ok(spawnedArgs.some((a) => a.endsWith("setup.py")));
  assert.ok(spawnedArgs.includes("--setup"));
  assert.ok(spawnedArgs.includes("--no-start"));
  assert.ok(spawnedArgs.includes("--gguf-dir"));
  assert.ok(spawnedArgs.includes(gguf));
  assert.equal(saved, "strata-iq2_xs.json");
  assert.equal(startMethod, "local");
});

test("local first run drives a real setup.py process and discovers the config (POSIX)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell script only");
    return;
  }
  resetFirstRunState();
  const dir = makeStrataDir();
  fs.writeFileSync(
    path.join(dir, "setup.py"),
    `#!/bin/sh\n` +
      `echo "=== Step 5: downloading qwen IQ2_XS ==="\n` +
      `echo "=== Step 6: preparing the model for Strata ==="\n` +
      `printf '%s' '{"args":["--max-context","32768"],"port":8099}' > strata-iq2_xs.json\n` +
      `exit 0\n`,
  );
  fs.chmodSync(path.join(dir, "setup.py"), 0o755);

  let saved = null;
  let statusCalls = 0;
  const io = {
    // No spawn override: the real child_process.spawn runs the script above via
    // /bin/sh (used as the "python" interpreter for this test).
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { state: "no-config", launch: { method: "local" }, settings: {} }
        : { state: "running", launch: { method: "local" } };
    },
    startService: async () => ({ started: true, state: "starting" }),
    saveSelectedConfig: async (_ctx, file) => {
      saved = file;
    },
    sleep: async () => {},
  };

  // pythonPath=/bin/sh so the shell-script setup.py is actually executed.
  await beginFirstRun(makeCtx({ strataDir: dir, pythonPath: "/bin/sh" }), { io });
  const state = await waitForDone(5000);
  assert.equal(state.error, null);
  assert.equal(state.done, true);
  assert.ok(fs.existsSync(path.join(dir, "strata-iq2_xs.json")));
  assert.ok(fs.existsSync(path.join(dir, "strata-setup.log")));
  assert.equal(saved, "strata-iq2_xs.json");
});

// ── Regression: existing config never enters setup ────────────────────────

test("existing config does not enter the first-run setup path (regression)", async () => {
  resetFirstRunState();
  const dir = makeStrataDir({ config: { name: "strata-demo.json", data: { port: 18080 } } });
  const ctx = makeCtx({ strataDir: dir, pythonPath: "/usr/bin/python3" });

  const status = await getStatus(ctx);
  assert.equal(status.state === "no-config", false);
  assert.equal(needsInitialSetup(status), false);

  // Default io for status/config, but any spawn is a failure.
  const result = await beginFirstRun(ctx, {
    io: {
      spawn: () => {
        throw new Error("setup.py must not run for an existing config");
      },
    },
  });
  assert.equal(result.needed, false);
  assert.equal(getFirstRunState().running, false);
});

test("beginFirstRun does not start a second job while one is running", async () => {
  resetFirstRunState();
  const dir = makeStrataDir();
  let release;
  let running = false;
  const gate = new Promise((resolve) => {
    release = () => {
      running = true;
      resolve();
    };
  });
  const io = {
    getStatus: async () =>
      running
        ? { state: "running", launch: { method: "local" } }
        : { state: "no-config", launch: { method: "local" }, settings: {} },
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "/m", configFile: "" }),
    saveSelectedConfig: async () => {},
    startService: async () => ({ started: true, state: "starting" }),
    sleep: async () => gate,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
  const first = await beginFirstRun(makeCtx({ strataDir: dir }), { io });
  assert.equal(first.running, true);
  const second = await beginFirstRun(makeCtx({ strataDir: dir }), { io });
  assert.equal(second.alreadyRunning, true);
  release();
  await waitForDone();
});
