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
  SETUP_PARAMS,
  needsInitialSetup,
  initialSetupPlan,
  validateSetupParams,
  classifySetupLine,
  beginFirstRun,
  getFirstRunState,
  resetFirstRunState,
} from "../lib/firstrun.js";
import { getStatus } from "../lib/strata.js";

// A cfg shaped like `readAllConfig`'s answer. The data directory is a PROFILE
// field (setup's own remembered `data_dir` is never consulted), so every fixture
// below carries an active profile — exactly what the real reader produces.
const DATA_DIR = "/srv/strata-data";

function localCfg(dir, extra = {}) {
  return {
    strataDir: dir,
    pythonPath: "/usr/bin/python3",
    ggufDir: "",
    configFile: "",
    activeProfile: { id: "p1", name: "default", type: "local", strataDir: dir, dataDir: DATA_DIR },
    ...extra,
  };
}

// The stored form (ctx.config), for the tests that go through the real reader.
function localStore(dir, pythonPath = "/usr/bin/python3") {
  return {
    profiles: [{ id: "p1", name: "default", type: "local", strataDir: dir, pythonPath, dataDir: DATA_DIR }],
    activeProfileId: "p1",
  };
}

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
    readAllConfig: async () => localCfg(dir, { ggufDir: gguf }),
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

// ── A re-run's parameters (the "Run setup…" pass-through) ────────────────

// Which parameters a re-run may be asked to change, and the values setup itself
// accepts (setup.py's argparse choices, setup.py:4584-4664). Everything else is
// setup's call: the hardware side (--backend/--gpu(s)), the paths the profile owns
// (--gguf-dir/--data-dir/--port), and what setup derives from RAM/VRAM
// (--resident-budget-gib/--vram-reserve-mib). `context`/`kv` are in the list
// because a re-run REBUILDS `args`: measured against setup's own
// write_setup_config, a hand-set --max-context came back as setup's answer.
test("the setup parameters are whitelisted, in setup's own value domains", () => {
  assert.deepEqual(Object.keys(SETUP_PARAMS).sort(), [
    "context",
    "dataDir",
    "family",
    "ggufDir",
    "kv",
    "kvStreaming",
    "lowRam",
    "model",
    "vision",
  ]);
  // The GGUF folder is setup's own flag, and it is a PATH: a free string here,
  // with existence checked where the filesystem is.
  assert.equal(SETUP_PARAMS.ggufDir.flag, "--gguf-dir");
  assert.equal(SETUP_PARAMS.ggufDir.path, true);
  assert.deepEqual(validateSetupParams({ ggufDir: "/models/IQ3_S" }).clean, { ggufDir: "/models/IQ3_S" });
  assert.deepEqual(validateSetupParams({ ggufDir: "" }).clean, {});

  // `--data-dir` is in the table for its flag spelling only: the value belongs to
  // the profile, so a request may not set it and validateSetupParams refuses it.
  assert.equal(SETUP_PARAMS.dataDir.flag, "--data-dir");
  assert.equal(SETUP_PARAMS.dataDir.fromProfile, true);
  assert.deepEqual(validateSetupParams({ dataDir: "/srv/elsewhere" }).clean, {});
  assert.match(validateSetupParams({ dataDir: "/srv/elsewhere" }).errors.join(), /dataDir/);

  const ok = validateSetupParams({ vision: "gpu", lowRam: "resident", kvStreaming: "on", context: "131072", kv: "k8v4" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { vision: "gpu", lowRam: "resident", kvStreaming: "on", context: "131072", kv: "k8v4" });

  // Empty/absent means "let setup decide": no flag is handed over at all.
  assert.deepEqual(validateSetupParams({ vision: "", lowRam: undefined }).clean, {});
  assert.deepEqual(validateSetupParams(undefined).clean, {});
  assert.deepEqual(validateSetupParams(null).clean, {});

  // A value outside setup's choices, or a parameter setup does not take, is
  // refused rather than forwarded as an unknown flag.
  assert.match(validateSetupParams({ vision: "maybe" }).errors.join(), /vision/);
  assert.match(validateSetupParams({ backend: "hip" }).errors.join(), /setup 不接受参数/);
  assert.match(validateSetupParams("vision=gpu").errors.join(), /对象/);
  // `context` is a plain int to setup, so a context the config already holds is
  // acceptable even when our list does not carry it — otherwise the form would
  // quietly fall back to "setup decides" and the value would change by itself.
  assert.deepEqual(validateSetupParams({ context: "98304" }).errors, []);
  assert.match(validateSetupParams({ context: "0" }).errors.join(), /context/);
  assert.match(validateSetupParams({ context: "many" }).errors.join(), /context/);

  // The plan echoes exactly what would be passed, and reports what was refused.
  const plan = initialSetupPlan({ state: "stopped" }, {}, { force: true, setup: { vision: "gpu", nope: "x" } });
  assert.deepEqual(plan.setup, { vision: "gpu" });
  assert.equal(plan.setupErrors.length, 1);
});

test("a re-run passes the requested flags in setup's spelling, and nothing else", async () => {
  resetFirstRunState();
  const dir = makeStrataDir({ config: { name: "strata-iq2_xs.json", data: { args: ["--max-context", "262144"], port: 8080 } } });
  let spawnedArgs = null;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {}, configCandidates: [] }),
    readAllConfig: async () => localCfg(dir, { ggufDir: "/models/IQ3_S", configFile: "strata-iq2_xs.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        // The same tag as before = the earlier file is rewritten (setup keeps .bak).
        fs.writeFileSync(path.join(dir, "strata-iq2_xs.json"), JSON.stringify({ args: ["--max-context", "131072"], port: 8080 }));
        child.emit("close", 0);
      });
      return child;
    },
  };

  const started = await beginFirstRun(makeCtx({ strataDir: dir }), {
    io,
    force: true,
    startAfter: false,
    setup: { vision: "gpu", lowRam: "resident", kvStreaming: "on", context: "131072", kv: "k8v4" },
  });
  assert.equal(started.needed, true);
  const state = await waitForDone();
  assert.equal(state.error, null);

  for (const [flag, value] of [["--vision", "gpu"], ["--low-ram", "resident"], ["--kv-streaming", "on"], ["--context", "131072"], ["--kv", "k8v4"]]) {
    const at = spawnedArgs.indexOf(flag);
    assert.ok(at >= 0, `${flag} must be passed through`);
    assert.equal(spawnedArgs[at + 1], value, `${flag} takes setup's own value`);
  }
  assert.ok(spawnedArgs.includes("--setup") && spawnedArgs.includes("--yes") && spawnedArgs.includes("--no-start"));
  // The profile's data directory, every run, in setup's spelling.
  const at = spawnedArgs.indexOf("--data-dir");
  assert.ok(at >= 0, "--data-dir must always be passed");
  assert.equal(spawnedArgs[at + 1], DATA_DIR);
  // Not ours to pass: the hardware side, setup's derivations, the other paths.
  for (const flag of ["--backend", "--gpu", "--gpus", "--port", "--resident-budget-gib", "--vram-reserve-mib"]) {
    assert.equal(spawnedArgs.includes(flag), false, `${flag} must not be passed`);
  }
});

test("a re-run with nothing asked for passes no parameter flags (setup decides)", async () => {
  resetFirstRunState();
  const dir = makeStrataDir({ config: { name: "strata-a.json", data: { args: [], port: 8080 } } });
  let spawnedArgs = null;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {}, configCandidates: [] }),
    readAllConfig: async () => localCfg(dir, { configFile: "strata-a.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
  await beginFirstRun(makeCtx({ strataDir: dir }), { io, force: true, startAfter: false, setup: {} });
  await waitForDone();
  for (const spec of Object.values(SETUP_PARAMS)) {
    // A profile-owned value is not a "parameter": it is always passed.
    if (spec.fromProfile) continue;
    assert.equal(spawnedArgs.includes(spec.flag), false, `${spec.flag} must not appear`);
  }
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
  await beginFirstRun(makeCtx(localStore(dir, "/bin/sh")), { io });
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
  const dir = makeStrataDir({ config: { name: "strata-iq2_xs.json", data: { port: 18080 } } });
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
    readAllConfig: async () => localCfg(dir, { ggufDir: "/m" }),
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
