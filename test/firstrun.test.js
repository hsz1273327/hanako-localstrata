// First-launch tests (1.1.0 batch 2).
//
// Covers the pure staging/plan helpers, the docker run parameters that carry
// GGUF_DIR/STRATA_DATA, the background first-run job (with an injected io so
// nothing real is spawned), and the "existing config never enters setup"
// regression.
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
  classifyLogText,
  beginFirstRun,
  getFirstRunState,
  resetFirstRunState,
} from "../lib/firstrun.js";
import { defaultRunParams, buildRunArgs } from "../lib/deployer/docker.js";
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
  const pinned = { deployMode: "local", ...values };
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
  assert.equal(needsInitialSetup({ state: "no-config", deployMode: "local" }), true);
  assert.equal(needsInitialSetup({ state: "stopped", deployMode: "local" }), false);
  assert.equal(needsInitialSetup({ state: "running", deployMode: "local" }), false);
  assert.equal(needsInitialSetup({ state: "unsupported" }), false);
});

test("needsInitialSetup: docker missing container / missing config is a first run", () => {
  assert.equal(
    needsInitialSetup({ state: "stopped", deployMode: "docker", docker: { state: "missing" }, hasConfig: false }),
    true,
  );
  assert.equal(
    needsInitialSetup({ state: "stopped", deployMode: "docker", docker: { state: "exited" }, hasConfig: false }),
    true,
  );
  assert.equal(
    needsInitialSetup({ state: "stopped", deployMode: "docker", docker: { state: "exited" }, hasConfig: true }),
    false,
  );
  assert.equal(needsInitialSetup({ state: "running", deployMode: "docker" }), false);
  // A missing image / CLI cannot be fixed by first-run setup.
  assert.equal(needsInitialSetup({ state: "not-installed", deployMode: "docker" }), false);
});

test("initialSetupPlan flags a possible large download when ggufDir is empty", () => {
  const status = { state: "no-config", deployMode: "local" };
  const withGguf = initialSetupPlan(status, { ggufDir: "/models/x" });
  assert.equal(withGguf.needed, true);
  assert.equal(withGguf.mode, "local");
  assert.equal(withGguf.ggufDir, "/models/x");
  assert.equal(withGguf.mayDownload, false);
  assert.deepEqual(withGguf.stages, FIRST_RUN_STAGES.local);

  const noGguf = initialSetupPlan(status, { ggufDir: "" });
  assert.equal(noGguf.mayDownload, true);

  const existing = initialSetupPlan({ state: "stopped", deployMode: "local" }, {});
  assert.equal(existing.needed, false);
});

test("classifySetupLine maps setup.py steps to download / convert", () => {
  assert.equal(classifySetupLine("=== Step 5: downloading qwen IQ2_XS ==="), "download");
  assert.equal(classifySetupLine("=== Step 6: preparing the model for Strata ==="), "convert");
  assert.equal(classifySetupLine("  Downloading from Hugging Face"), "download");
  assert.equal(classifySetupLine("  Converting the Q2_0 experts ..."), "convert");
  assert.equal(classifySetupLine("random line"), null);
});

test("classifyLogText never moves backwards", () => {
  const text = [
    "=== Step 6: preparing the model for Strata ===",
    "=== Step 5: downloading qwen IQ2_XS ===", // late/duplicated lines must not rewind
  ].join("\n");
  assert.equal(classifyLogText(text, "download"), "convert");
  assert.equal(classifyLogText("Config: /data/config/strata-iq3_s.json", "convert"), "config");
  assert.equal(classifyLogText("", "convert"), "convert");
});

// ── Docker run parameters ─────────────────────────────────────────────────

test("docker defaultRunParams carries STRATA_DATA and GGUF_DIR", () => {
  const params = defaultRunParams({ imageName: "strata", volumeName: "strata-data", ggufDir: "/models/UD" }, 8080);
  assert.ok(params.env.includes("STRATA_DATA=/data"));
  assert.ok(params.env.includes("GGUF_DIR=/gguf"));
  assert.ok(params.binds.includes("strata-data:/data"));
  assert.ok(params.binds.includes("/models/UD:/gguf"));

  const args = buildRunArgs("strata", params);
  assert.ok(args.includes("STRATA_DATA=/data"));
  assert.ok(args.includes("GGUF_DIR=/gguf"));
  assert.ok(args.includes("/models/UD:/gguf"));
});

test("docker defaultRunParams omits GGUF_DIR without a model folder", () => {
  const params = defaultRunParams({ imageName: "strata", volumeName: "strata-data" }, 8080);
  assert.ok(!params.env.some((e) => e.startsWith("GGUF_DIR=")));
  assert.ok(!params.binds.some((b) => String(b).endsWith(":/gguf")));
});

// ── Background job (injected io) ──────────────────────────────────────────

test("local first run spawns setup.py with --gguf-dir, selects the config and starts", async () => {
  resetFirstRunState();
  const dir = makeStrataDir();
  const gguf = "/models/UD-Q4_K_XL";
  let spawnedArgs = null;
  let saved = null;
  let statusCalls = 0;

  const io = {
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { state: "no-config", deployMode: "local", settings: {}, configCandidates: [] }
        : { state: "running", deployMode: "local" };
    },
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: gguf, configFile: "" }),
    savePluginConfig: async (_ctx, patch) => {
      saved = patch;
    },
    startService: async () => ({ started: true, state: "starting", pid: 4242 }),
    readLogs: async () => ({ lines: [] }),
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
  assert.equal(saved?.configFile, "strata-iq2_xs.json");
});

test("docker first run starts the container and finishes when HTTP answers", async () => {
  resetFirstRunState();
  let statusCalls = 0;
  let startCalls = 0;
  const io = {
    getStatus: async () => {
      statusCalls += 1;
      if (statusCalls === 1) {
        return { state: "stopped", deployMode: "docker", docker: { state: "missing" }, hasConfig: false };
      }
      return { state: "running", deployMode: "docker" };
    },
    readAllConfig: async () => ({ deployMode: "docker", containerName: "strata", imageName: "strata", ggufDir: "/models" }),
    startService: async () => {
      startCalls += 1;
      return { started: true, created: true, state: "starting" };
    },
    readLogs: async () => ({
      lines: [
        "Setting up iq3_s from the GGUF files in /gguf (the engine is already in the image).",
        "=== Step 6: preparing the model for Strata ===",
        "Config: /data/config/strata-iq3_s.json (from MODEL IQ3_S, just set up)",
      ],
    }),
    savePluginConfig: async () => {},
    sleep: async () => {},
    spawn: () => {
      throw new Error("docker first run must not spawn setup.py");
    },
  };

  const started = await beginFirstRun(makeCtx({ deployMode: "docker" }), { io });
  assert.equal(started.needed, true);
  assert.equal(started.mode, "docker");

  const state = await waitForDone();
  assert.equal(state.error, null);
  assert.equal(state.done, true);
  assert.equal(startCalls, 1);
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
        ? { state: "no-config", deployMode: "local", settings: {} }
        : { state: "running", deployMode: "local" };
    },
    startService: async () => ({ started: true, state: "starting" }),
    readLogs: async () => ({ lines: [] }),
    savePluginConfig: async (_ctx, patch) => {
      saved = patch;
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
  assert.equal(saved?.configFile, "strata-iq2_xs.json");
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
        ? { state: "running", deployMode: "local" }
        : { state: "no-config", deployMode: "local", settings: {} },
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "/m", configFile: "" }),
    savePluginConfig: async () => {},
    startService: async () => ({ started: true, state: "starting" }),
    readLogs: async () => ({ lines: [] }),
    sleep: async () => gate,
    spawn: (_cmd, _args) => {
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
