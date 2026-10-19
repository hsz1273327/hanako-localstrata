// setup.py's settings file belongs to a DEPLOYMENT, not to the user (1.1.1).
//
// Why this file exists: `setup.py:3478 settings_path()` keeps ONE settings file
// per user, holding `data_dir` (the last --data-dir) and `installs` (every folder
// setup was run from). Its "move the model files here" step treats both as places
// an older install left models / packs / mtp files in and MOVES them into the
// current run's --data-dir. Two source deployments on one machine therefore
// overwrite each other's value, and the next run of the other one migrates the
// first one's data into its own folder. That happened twice for real.
//
// The fix is not a field for the user: a local profile's setup run is given a
// config home inside its own Strata directory, so setup reads and writes
// `<strataDir>/.config/...` and never sees the shared file. setup.py's own branch
// decides how (setup.py:3478):
//
//   WIN  → %APPDATA%/Strata/settings.json          (capital S; XDG is ignored)
//   else → $XDG_CONFIG_HOME/strata/settings.json   (lower case)
//
// What is pinned here:
//   * both platform branches: variable name AND leaf folder;
//   * a setup run carries the variable, a service start does NOT;
//   * a missing settings.json is created with setup's own two keys;
//   * an existing one is never overwritten (setup maintains it);
//   * no data directory → no file, no error;
//   * an unwritable directory warns and lets the run continue.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  CONFIG_HOME_DIR,
  ensureSetupSettings,
  profileStrataDir,
  setupConfigEnv,
  setupConfigHome,
  setupConfigVarName,
  setupSettingsPath,
  withSetupConfigEnv,
} from "../lib/setup-env.js";
import { beginFirstRun, getFirstRunState, resetFirstRunState } from "../lib/firstrun.js";
import { setupRunEnv } from "../routes/update.js";
import { createSourceDeployer } from "../lib/deployer/source.js";

const DATA_DIR = "/srv/strata-data";
const STRATA_DIR = "/srv/Strata";

const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-settings-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeStrataDir() {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), "# fake\n");
  fs.writeFileSync(path.join(dir, "setup.py"), "# fake\n");
  return dir;
}

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async setMany(patch) {
        Object.assign(store, patch);
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

// Run the real first-run job with an injected spawn, so the environment handed to
// setup.py can be inspected. Returns the captured spawn call.
async function runFirstRun(dir, { dataDir = DATA_DIR } = {}) {
  resetFirstRunState();
  let captured = null;
  let statusCalls = 0;
  const io = {
    getStatus: async () =>
      ++statusCalls === 1
        ? { state: "no-config", launch: { method: "local" }, settings: {} }
        : { state: "running", launch: { method: "local" } },
    readAllConfig: async () => ({
      strataDir: dir,
      pythonPath: "/usr/bin/python3",
      ggufDir: "",
      configFile: "",
      activeProfile: { id: "p1", name: "default", type: "local", strataDir: dir, dataDir },
    }),
    saveSelectedConfig: async () => {},
    startService: async () => ({ started: true, state: "starting" }),
    sleep: async () => {},
    spawn: (cmd, args, opts) => {
      captured = { cmd, args, opts };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        fs.writeFileSync(path.join(dir, "strata-iq2_xs.json"), JSON.stringify({ args: [], port: 8099 }));
        child.emit("close", 0);
      });
      return child;
    },
  };
  await beginFirstRun(makeCtx({ strataDir: dir }), { io });
  const state = await waitForDone();
  return { captured, state };
}

// ── The platform branch (setup.py's own) ─────────────────────────────────

test("the config home sits inside the deployment, whatever the platform", () => {
  assert.equal(CONFIG_HOME_DIR, ".config");
  assert.equal(setupConfigHome(STRATA_DIR), path.join(STRATA_DIR, ".config"));
  // Nothing to point at yet: no variable, no path.
  assert.equal(setupConfigHome(""), "");
  assert.equal(setupConfigHome(undefined), "");
  assert.deepEqual(setupConfigEnv(""), {});
  assert.equal(setupSettingsPath(""), "");
});

test("POSIX: XDG_CONFIG_HOME, lower-case `strata` leaf", () => {
  const home = path.join(STRATA_DIR, ".config");
  assert.equal(setupConfigVarName("linux"), "XDG_CONFIG_HOME");
  assert.equal(setupConfigVarName("darwin"), "XDG_CONFIG_HOME");
  assert.deepEqual(setupConfigEnv(STRATA_DIR, "linux"), { XDG_CONFIG_HOME: home });
  const settingsPath = setupSettingsPath(STRATA_DIR, "linux");
  assert.equal(settingsPath, path.join(home, "strata", "settings.json"));
  assert.equal(path.basename(path.dirname(settingsPath)), "strata");
});

test("Windows: APPDATA and a capital `Strata` leaf — XDG is ignored there", () => {
  const home = path.join(STRATA_DIR, ".config");
  assert.equal(setupConfigVarName("win32"), "APPDATA");
  const env = setupConfigEnv(STRATA_DIR, "win32");
  assert.deepEqual(env, { APPDATA: home });
  assert.equal(env.XDG_CONFIG_HOME, undefined, "setup.py does not read XDG_CONFIG_HOME on Windows");
  const settingsPath = setupSettingsPath(STRATA_DIR, "win32");
  assert.equal(settingsPath, path.join(home, "Strata", "settings.json"));
  assert.equal(path.basename(path.dirname(settingsPath)), "Strata");
  // The two leaves really are spelled differently.
  assert.notEqual(setupSettingsPath(STRATA_DIR, "win32"), setupSettingsPath(STRATA_DIR, "linux"));
});

test("the environment patch keeps what the caller already had, and picks one variable", () => {
  const posix = withSetupConfigEnv({ A: "1" }, STRATA_DIR, "linux");
  assert.equal(posix.A, "1");
  assert.equal(posix.XDG_CONFIG_HOME, path.join(STRATA_DIR, ".config"));
  assert.equal(posix.APPDATA, undefined);

  const win = withSetupConfigEnv({ A: "1" }, STRATA_DIR, "win32");
  assert.equal(win.A, "1");
  assert.equal(win.APPDATA, path.join(STRATA_DIR, ".config"));
  assert.equal(win.XDG_CONFIG_HOME, undefined);

  // No Strata directory: the caller's environment passes through untouched.
  const bare = withSetupConfigEnv({ A: "1" }, "", "linux");
  assert.deepEqual(bare, { A: "1" });
});

test("profileStrataDir reads the active profile, and falls back to the flat mirror", () => {
  assert.equal(profileStrataDir({ activeProfile: { strataDir: "/a" }, strataDir: "/b" }), "/a");
  assert.equal(profileStrataDir({ strataDir: "/b" }), "/b");
  assert.equal(profileStrataDir({}), "");
});

// ── A setup run ───────────────────────────────────────────────────────────

test("the setup run carries the deployment's config home, and creates the file", async () => {
  const dir = makeStrataDir();
  const { captured, state } = await runFirstRun(dir);
  assert.equal(state.error, null);
  assert.ok(captured, "setup.py should have been spawned");

  // The variable the platform's setup.py reads, pointing inside THIS deployment.
  assert.equal(captured.opts.env.XDG_CONFIG_HOME, path.join(dir, ".config"));
  assert.equal(captured.opts.env.APPDATA, undefined);
  // The rest of the environment is inherited (PATH etc.), not replaced.
  assert.equal(captured.opts.env.PATH, process.env.PATH);

  // Missing settings.json → setup's own starting shape, with the two keys it
  // maintains.
  const settingsPath = path.join(dir, ".config", "strata", "settings.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
    data_dir: DATA_DIR,
    installs: [dir],
  });

  // One debug line in the existing setup log, for later diagnosis.
  const logText = fs.readFileSync(path.join(dir, "strata-setup.log"), "utf8");
  assert.ok(logText.includes(`XDG_CONFIG_HOME=${path.join(dir, ".config")}`), "the setup log names the config home");
});

test("an existing settings.json is left alone — setup maintains it", async () => {
  const dir = makeStrataDir();
  const settingsPath = path.join(dir, ".config", "strata", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const stored = JSON.stringify({ data_dir: "/srv/other-data", installs: ["/srv/other"] });
  fs.writeFileSync(settingsPath, stored);

  const { captured, state } = await runFirstRun(dir);
  assert.equal(state.error, null);
  assert.equal(captured.opts.env.XDG_CONFIG_HOME, path.join(dir, ".config"));
  assert.equal(fs.readFileSync(settingsPath, "utf8"), stored, "the file setup keeps must not be rewritten");
});

test("without a data directory no settings file is written (and nothing throws)", () => {
  const dir = makeStrataDir();
  const result = ensureSetupSettings({ strataDir: dir, dataDir: "" });
  assert.equal(result.created, false);
  assert.equal(result.reason, "no-data-dir");
  assert.equal(result.error, null);
  assert.equal(fs.existsSync(path.join(dir, ".config", "strata", "settings.json")), false);
  // Undefined is the same answer as empty (a profile saved before the field existed).
  assert.equal(ensureSetupSettings({ strataDir: dir }).reason, "no-data-dir");
});

test("an unwritable deployment reports the failure instead of stopping the run (POSIX)", (t) => {
  if (process.platform === "win32") {
    t.skip("chmod-based check");
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores the mode bits");
    return;
  }
  const dir = makeStrataDir();
  fs.chmodSync(dir, 0o500);
  try {
    const result = ensureSetupSettings({ strataDir: dir, dataDir: DATA_DIR });
    assert.equal(result.created, false);
    assert.equal(result.reason, "write-failed");
    assert.ok(result.error, "the reason is reported");
    assert.equal(result.path, path.join(dir, ".config", "strata", "settings.json"));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

// ── A service start ───────────────────────────────────────────────────────

test("starting the service does not get the setup environment (POSIX)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX launcher script");
    return;
  }
  const dir = makeStrataDir();
  fs.writeFileSync(path.join(dir, "strata-a.json"), JSON.stringify({ args: [], port: 18099, host: "127.0.0.1" }));
  const dump = path.join(dir, "child-env.txt");
  const fakePython = path.join(dir, "fake-python.sh");
  fs.writeFileSync(fakePython, `#!/bin/sh\nenv > "${dump}"\n`);
  fs.chmodSync(fakePython, 0o755);

  const deployer = createSourceDeployer({
    ctx: makeCtx(),
    cfg: { strataDir: dir, pythonPath: fakePython, configFile: "strata-a.json", port: 18099, gpu: "", refreshSec: 5 },
    opts: { platform: "linux" },
  });
  const started = await deployer.start();
  assert.equal(started.started, true, "the service start path should have launched the server");

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(dump) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(dump), "the fake interpreter should have recorded its environment");
  const got = Object.fromEntries(
    fs
      .readFileSync(dump, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  // The server never reads setup's settings file, so neither variable may be
  // pointed at this deployment's config home (the ambient environment is not
  // ours to police — only OUR injection is absent).
  assert.notEqual(got.XDG_CONFIG_HOME, path.join(dir, ".config"));
  assert.notEqual(got.APPDATA, path.join(dir, ".config"));
  // ...and the start path must not create the file either.
  assert.equal(fs.existsSync(path.join(dir, ".config", "strata", "settings.json")), false);
});

// ── The update run ────────────────────────────────────────────────────────

test("the update's setup run gets the same variable, on both platforms", () => {
  const cfg = { activeProfile: { id: "p1", type: "local", strataDir: STRATA_DIR, dataDir: DATA_DIR } };
  const noCuda = { hasOwnCuda: false, nvccInEnv: "", nvcc: "/usr/bin/nvcc" };

  const posix = setupRunEnv(cfg, noCuda, "linux");
  assert.equal(posix.XDG_CONFIG_HOME, path.join(STRATA_DIR, ".config"));
  assert.equal(posix.APPDATA, undefined);

  const win = setupRunEnv(cfg, noCuda, "win32");
  assert.equal(win.APPDATA, path.join(STRATA_DIR, ".config"));
  assert.equal(win.XDG_CONFIG_HOME, undefined);

  // The CUDA hints a re-build needs are still there, and the injection works on a
  // copy — `process.env` itself is never mutated.
  const cuda = { hasOwnCuda: true, nvccInEnv: "/opt/cuda/bin/nvcc", nvcc: "/opt/cuda/bin/nvcc" };
  const before = process.env.XDG_CONFIG_HOME;
  const withCuda = setupRunEnv(cfg, cuda, "linux");
  assert.equal(withCuda.STRATA_NVCC, "/opt/cuda/bin/nvcc");
  assert.equal(withCuda.XDG_CONFIG_HOME, path.join(STRATA_DIR, ".config"));
  assert.equal(process.env.XDG_CONFIG_HOME, before, "the parent process environment is left alone");
});
