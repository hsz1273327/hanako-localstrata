// Regression guards for the stop chain: panel 停止按钮 → POST /stop → deployer.
//
// What this file pins: the case where the panel shows a running service that
// the active profile cannot actually stop (e.g. the service runs in a container
// while a local profile is active). The stop used to come back as HTTP 200 with
// `{stopped:false}` and no error, and the panel only looks at `res.ok`, so the
// whole operation was a silent no-op: the button appeared to do nothing and the
// service kept running.
//
// Two layers, same policy as test/panel-running-readonly.test.js:
//
//   Layer 1 — always-on, zero-dependency. Source guards plus behavioural tests
//     of the real lib/ + routes/ code, driving the process and docker layers
//     through the same `opts` injection the container deployer already uses.
//     Runs under the repo's plain `node --test test/*.js`.
//
//   Layer 2 — jsdom behaviour layer, skipped unless jsdom resolves (this repo is
//     dependency-free by design). It loads the real panel and checks that a
//     failed stop is actually shown to the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stopResponse } from "../routes/stop.js";
import { stopService, writeProfiles } from "../lib/strata.js";
import { normalizeProfile } from "../lib/profiles.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const stopRouteSrc = read("routes/stop.js");
const panelJs = read("ui/assets/panel.js");
const panelHtml = read("ui/panel.html");

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
    log: { info() {}, warn() {}, error() {} },
  };
}

// A Strata server running inside a container: visible to `pgrep` on the host
// (same PID namespace) but owned by another user, so every signal is refused.
function containerOwnedProcesses(pids = [4242]) {
  return {
    list: () => [...pids],
    children: () => [],
    kill: () => false, // EPERM: another user owns the process
    alive: () => true,
    isStrata: () => true,
  };
}

// ── Layer 1: local deployer reports *why* it could not stop ───────────────

test("a local stop that cannot signal the Strata processes reports why", async () => {
  const ctx = makeCtx({ strataDir: "/nope/lost-strata" });
  const res = await stopService(ctx, { platform: "linux", processes: containerOwnedProcesses([4242]) });

  assert.equal(res.stopped, false);
  assert.deepEqual(res.denied, [4242], "the unsignalable pids must be reported");
  assert.equal(res.already, undefined, "this is a failure, not 'nothing to do'");
  assert.match(res.error, /无法停止/);
  assert.match(res.error, /4242/);
  // The same result must not be served as a success by the route.
  assert.equal(stopResponse(res).status, 409);
});

test("a local stop with nothing to stop stays an idempotent success", async () => {
  const ctx = makeCtx({ strataDir: "/nope/lost-strata" });
  const res = await stopService(ctx, {
    platform: "linux",
    processes: { list: () => [], children: () => [], kill: () => false, alive: () => false, isStrata: () => false },
  });

  assert.equal(res.stopped, false);
  assert.equal(res.already, true);
  assert.equal(res.error, undefined);
  assert.equal(stopResponse(res).status, 200);
});

test("a local stop that can signal its targets still reports success", async () => {
  const ctx = makeCtx({ strataDir: "/nope/lost-strata" });
  const signalled = [];
  const res = await stopService(ctx, {
    platform: "linux",
    processes: {
      list: () => [4242],
      children: () => [4243],
      kill: (pid) => {
        signalled.push(pid);
        return true;
      },
      alive: () => false, // both die from SIGTERM
      isStrata: () => true,
    },
  });

  assert.equal(res.stopped, true);
  // Children first (higher pid), then the parent.
  assert.deepEqual(res.killed, [4243, 4242]);
  assert.deepEqual(res.forced, []);
  assert.equal(stopResponse(res).status, 200);
});

// ── Layer 1: container deployer still reaches `docker stop` ──────────────

function containerProfile() {
  return normalizeProfile({
    id: "c1",
    name: "container",
    type: "container",
    image: "strata:latest",
    containerName: "strata",
    dataDir: "/srv/strata",
  });
}

function fakeDocker({ inspect = null, stopOk = true } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      available: () => true,
      inspect: () => inspect,
      imageInspect: () => null,
      imageExists: () => true,
      start: () => ({ ok: true }),
      stop: (name) => {
        calls.push(name);
        return { ok: stopOk, stdout: "", stderr: stopOk ? "" : "boom" };
      },
      restart: () => ({ ok: true }),
      logs: () => "",
      exec: () => {
        throw new Error("not running");
      },
      execRaw: () => ({ ok: true }),
      catFile: () => null,
      cp: () => ({ ok: true }),
      pull: () => ({ ok: true }),
      raw: () => ({ ok: true, stdout: "", stderr: "" }),
    },
  };
}

function runningContainerInfo() {
  return {
    Id: "0000000000000000",
    Name: "/strata",
    State: { Status: "running", Running: true, ExitCode: 0 },
    Config: { Image: "strata:latest", Env: ["PORT=8080", "HOST=0.0.0.0"] },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] } },
  };
}

test("a container profile's stop reaches docker stop <containerName>", async () => {
  const profile = containerProfile();
  const ctx = makeCtx({});
  await writeProfiles(ctx, [profile], profile.id);

  const { calls, adapter } = fakeDocker({ inspect: runningContainerInfo() });
  const res = await stopService(ctx, { platform: "linux", docker: adapter });

  assert.deepEqual(calls, ["strata"], "the active profile's container must be the target");
  assert.equal(res.stopped, true);
  assert.equal(stopResponse(res).status, 200);
});

test("a container stop that fails carries its error into the response", async () => {
  const profile = containerProfile();
  const ctx = makeCtx({});
  await writeProfiles(ctx, [profile], profile.id);

  const { adapter } = fakeDocker({ inspect: runningContainerInfo(), stopOk: false });
  const res = await stopService(ctx, { platform: "linux", docker: adapter });

  assert.equal(res.stopped, false);
  assert.ok(res.error, "docker's failure must not be swallowed");
  const mapped = stopResponse(res);
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error, res.error);

  // A missing container is a failure the user must see, not a silent no-op.
  const missingCtx = makeCtx({});
  await writeProfiles(missingCtx, [profile], profile.id);
  const { adapter: absent } = fakeDocker({ inspect: null });
  const gone = await stopService(missingCtx, { platform: "linux", docker: absent });
  assert.equal(gone.stopped, false);
  assert.match(gone.error, /未找到容器/);
  assert.equal(stopResponse(gone).status, 409);
});

// ── Layer 1: source guards on the route + the panel ──────────────────────

test("the /stop route maps a failed stop to a non-2xx and keeps the message", () => {
  assert.equal(stopResponse({ stopped: true, killed: [1], forced: [] }).status, 200);
  assert.equal(stopResponse({ stopped: false, already: true }).status, 200);

  const denied = stopResponse({ stopped: false, killed: [], denied: [7], error: "无法停止" });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, "无法停止");

  // Defensive: even without an `error`, `stopped:false` must not be a success.
  const bare = stopResponse({ stopped: false, killed: [] });
  assert.equal(bare.status, 409);
  assert.ok(bare.body.error, "a synthetic message must be added");

  // And the handler must actually use the mapping (no bare `c.json(result)`).
  assert.match(stopRouteSrc, /export function stopResponse\(result\)/);
  assert.match(stopRouteSrc, /const \{ status, body \} = stopResponse\(await stopService\(ctx\)\);/);
  assert.match(stopRouteSrc, /return c\.json\(body, status\);/);
});

test("the panel shows an operation failure *after* the status repaint", () => {
  // paint() owns #error and clears it on every refresh, so a message set before
  // the repaint is wiped in the same tick.
  assert.match(panelJs, /await refresh\(\);\s*showError\(message\);/);
  assert.doesNotMatch(panelJs, /showError\(String\(e\?\.message \|\| e\)\);\s*endWorking\(\);\s*await refresh\(\);/);
});

// ── Layer 2: the real panel, in jsdom (opt-in) ───────────────────────────

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}

const STUB_SDK = `// Stub of ./sdk.js: values are read from globalThis.__API__ at call time.
function res(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
export const hana = {
  ready: async () => {},
  api: {
    fetch: async (p) => {
      const s = globalThis.__API__ || {};
      if (p === "status") return res(s.status || { state: "stopped" });
      if (p === "settings") return res({ hasConfig: true, values: {}, configFile: "" });
      if (p === "profiles") return res({ profiles: [], activeProfileId: "" });
      if (p === "stop") {
        const stop = s.stop || {};
        return res(stop.body || { stopped: true }, stop.status || 200);
      }
      return res({});
    },
  },
  clipboard: { writeText: async () => {} },
  external: { open: async () => {} },
  resources: { pick: async () => ({ resources: [] }) },
};
`;

function runningStatus() {
  return {
    state: "running",
    profile: { id: "p1", name: "default", type: "local" },
    profiles: [{ id: "p1", name: "default", type: "local" }],
    activeProfileId: "p1",
    version: { checkState: "checked", local: "0.1.40", latest: "0.1.40" },
    network: { lanExposed: false, addressUrl: "http://127.0.0.1:8080" },
    model: "test-model",
    port: 8080,
    uptime_s: 100,
    configCandidates: [],
    log: { lines: [] },
    resources: {},
  };
}

test(
  "panel stop — a refused stop is shown to the user (requires jsdom)",
  { skip: JSDOM ? false : "jsdom is not installed (this repo is dependency-free by design); add it as a devDependency to enable this behavioural layer" },
  async () => {
    const { window } = new JSDOM(panelHtml, { url: "http://localhost/", pretendToBeVisual: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strata-stop-panel-"));
    fs.writeFileSync(path.join(tmp, "sdk.js"), STUB_SDK);
    fs.copyFileSync(path.join(ROOT, "ui/assets/panel.js"), path.join(tmp, "panel.js"));
    fs.copyFileSync(path.join(ROOT, "ui/assets/i18n.js"), path.join(tmp, "i18n.js"));

    const saved = ["window", "document", "navigator", "localStorage", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"];
    const restore = {};
    for (const k of saved) restore[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const pin = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    globalThis.window = window;
    globalThis.document = window.document;
    pin("navigator", window.navigator);
    pin("localStorage", window.localStorage);
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Event = window.Event;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.MouseEvent = window.MouseEvent;

    const $ = (id) => window.document.getElementById(id);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const waitFor = async (pred, tries = 80) => {
      for (let i = 0; i < tries; i++) {
        if (pred()) return true;
        await tick();
      }
      return pred();
    };
    const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const REFUSED = "找到 1 个 Strata 进程但无法停止（PID 4242）：它们不属于当前用户";
    globalThis.__API__ = { status: runningStatus(), stop: { status: 409, body: { stopped: false, denied: [4242], error: REFUSED } } };

    try {
      await import(pathToFileURL(path.join(tmp, "panel.js")).href);
      await waitFor(() => $("actionBtn").title && $("actionBtn").title !== "");

      // The panel believes a local service is running and offers "Stop".
      assert.equal($("actionBtn").title, "Stop service");
      assert.equal($("error").hidden, true, "no error before the stop");

      click($("actionBtn")); // → confirm popover
      await waitFor(() => $("confirmPopover").hidden === false);
      click($("confirmOk")); // → POST /stop → 409
      await waitFor(() => !$("error").hidden);

      assert.ok(
        ($("error").textContent || "").includes(REFUSED),
        `the stop failure must be visible, got: ${JSON.stringify($("error").textContent)}`,
      );
      // The overlay is gone and the button still offers Stop — the service is
      // still running and the panel says why.
      assert.equal($("overlay").hidden, true, "the operation overlay must be dismissed");
      assert.equal($("actionBtn").disabled, false);
      assert.equal($("actionBtn").title, "Stop service");
    } finally {
      try {
        window.dispatchEvent(new window.Event("beforeunload"));
      } catch {
        /* ignore */
      }
      window.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const k of saved) {
        if (restore[k]) Object.defineProperty(globalThis, k, restore[k]);
        else delete globalThis[k];
      }
      delete globalThis.__API__;
    }
  },
);
