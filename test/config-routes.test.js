// Config layer ② (1.1.0): stopped-state "choose / build a config".
//
// `POST /config/select` picks which setup result the local source starts with;
// `POST /config/setup` builds a new one by reusing the first-run job. Both are
// LOCAL-only and stopped-only, enforced server-side (never by hiding a control),
// and `/config/setup` reuses GET /start's staged progress instead of a second
// progress contract.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { selectConfig, startConfigSetup, assertConfigEditable, default as registerConfigRoutes } from "../routes/config.js";
import { getFirstRunState, resetFirstRunState } from "../lib/firstrun.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-config-routes-"));
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
    network: {
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url?.url || String(url);
        if (href.includes("127.0.0.1") || href.includes("localhost")) return fetch(href, init);
        return { ok: false, status: 404, json: async () => ({}) };
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

// A real, installed-but-stopped local source dir with two selectable configs.
function makeLocalDir({ runningPort = null } = {}) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), "# fake\n");
  fs.writeFileSync(path.join(dir, "setup.py"), "# fake\n");
  fs.writeFileSync(path.join(dir, "strata-a.json"), JSON.stringify({ port: runningPort ?? 59999 }));
  fs.writeFileSync(path.join(dir, "strata-b.json"), JSON.stringify({ port: 59998 }));
  return dir;
}

function localCtx(dir, extra = {}) {
  return makeCtx({
    profiles: [
      { id: "p1", name: "default", type: "local", strataDir: dir, pythonPath: "/usr/bin/python3", gpu: "", ggufDir: "", port: 0 },
    ],
    activeProfileId: "p1",
    configFile: "strata-a.json",
    ...extra,
  });
}

// ── selectConfig ──────────────────────────────────────────────────────────

test("selectConfig writes the top-level selection and returns the fresh status", async () => {
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  const res = await selectConfig(ctx, "strata-b.json", { platform: "linux" });
  assert.equal(res.saved, true);
  assert.equal(res.configFile, "strata-b.json");
  assert.equal(ctx._store.configFile, "strata-b.json");
  assert.equal(res.status.configFile, "strata-b.json");
});

test("selectConfig refuses a file that is not a real candidate", async () => {
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  await assert.rejects(
    () => selectConfig(ctx, "strata-missing.json", { platform: "linux" }),
    /配置不存在/,
  );
  // The stored selection is untouched.
  assert.equal(ctx._store.configFile, "strata-a.json");
});

test("selectConfig refuses an empty file", async () => {
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  await assert.rejects(() => selectConfig(ctx, "", { platform: "linux" }), /请选择/);
});

test("selectConfig refuses while the service is running", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "strata", engine: "9.9.9" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const dir = makeLocalDir({ runningPort: port });
    const ctx = localCtx(dir);
    await assert.rejects(
      () => selectConfig(ctx, "strata-b.json", { platform: "linux" }),
      /运行中.*不能更改配置/,
    );
    assert.equal(ctx._store.configFile, "strata-a.json");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("selectConfig refuses a container profile (its config is container-managed)", async () => {
  const ctx = makeCtx({
    profiles: [
      { id: "c1", name: "dockertest", type: "container", imageName: "strata", imageTag: "latest", containerName: "strata", dataDir: "/tmp/strata-data" },
    ],
    activeProfileId: "c1",
  });
  await assert.rejects(
    () => selectConfig(ctx, "strata-a.json", { platform: "linux", docker: null }),
    /容器模式/,
  );
});

// ── startConfigSetup ──────────────────────────────────────────────────────

test("startConfigSetup runs the setup job with startAfter:false and never starts the service", async () => {
  resetFirstRunState();
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  let saved = null;
  let startCalled = false;

  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {} }),
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "/models/x", configFile: "strata-a.json" }),
    saveSelectedConfig: async (_ctx, file) => {
      saved = file;
    },
    startService: async () => {
      startCalled = true;
      return { started: true };
    },
    sleep: async () => {},
    spawn: (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("=== Step 6: preparing the model for Strata ===\n"));
        fs.writeFileSync(path.join(dir, "strata-new.json"), JSON.stringify({ port: 59997 }));
        child.emit("close", 0);
      });
      return child;
    },
  };

  const res = await startConfigSetup(ctx, { io, platform: "linux" });
  assert.equal(res.needed, true, "a forced run is needed even though a config exists");
  assert.equal(res.running, true);

  const deadline = Date.now() + 3000;
  while (!getFirstRunState().done && !getFirstRunState().error && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const st = getFirstRunState();
  assert.equal(st.error, null);
  assert.equal(st.done, true);
  assert.equal(startCalled, false, "a new-config build must not start the service");
  assert.equal(st.result.started, null);
  assert.equal(st.result.configFile, "strata-new.json");
  assert.equal(saved, "strata-new.json", "the freshly built config becomes the selection");
});

test("startConfigSetup refuses a container profile before running anything", async () => {
  resetFirstRunState();
  const ctx = makeCtx({
    profiles: [
      { id: "c1", name: "dockertest", type: "container", imageName: "strata", containerName: "strata", dataDir: "/tmp/x" },
    ],
    activeProfileId: "c1",
  });
  await assert.rejects(
    () => startConfigSetup(ctx, { platform: "linux", docker: null }),
    /容器模式/,
  );
  assert.equal(getFirstRunState().running, false, "no job was started");
});

test("assertConfigEditable rejects an unsupported platform", async () => {
  await assert.rejects(() => assertConfigEditable(makeCtx({}), { platform: "darwin" }), /不支持/);
});

// ── i18n + panel wiring guards ────────────────────────────────────────────

test("config-picker i18n copy exists and is non-empty in all six locales", () => {
  const keys = [
    "configPick.title",
    "configPick.selectLabel",
    "configPick.new",
    "configPick.hint",
    "configPick.context",
    "configPick.containerManaged",
    "configPick.confirmTitle",
    "configPick.setupSub",
    "configPick.confirmAction",
    "configPick.running",
  ];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
    // The confirmation states the two things a user must know before pressing
    // it: it is heavy, and it rebuilds from setup's RECOMMENDED answers.
    assert.match(STRINGS[lang]["configPick.setupSub"], /\{dir\}/, `${lang}.configPick.setupSub must take the model dir`);
  }
});

test("the setup entry is named the same way in the copy and in the hints", () => {
  // "Re-run setup" is only actionable if the hint names the entry the user can
  // actually press. The button label minus its ellipsis must appear verbatim in
  // every hint that tells them to re-run setup.
  const hintKeys = ["edit.kvStreamHint", "edit.lowRamHint", "vision.setupNote"];
  for (const lang of LANGS) {
    const entry = STRINGS[lang]["configPick.new"].replace(/[…\.]+$/u, "").trim();
    assert.ok(entry.length > 4, `${lang}: the entry label is too short to be a pointer`);
    assert.match(entry, /setup/i, `${lang}: the entry must be recognised as the setup run`);
    for (const key of hintKeys) {
      assert.ok(
        STRINGS[lang][key].includes(entry),
        `${lang}.${key} must point at the entry ("${entry}") instead of saying "re-run setup" into the void`,
      );
    }
  }
});

test("the setup confirmation uses its own copy, not the first-launch one", () => {
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  const dialog = js.slice(js.indexOf("els.configSetupBtn.addEventListener(\"click\""), js.indexOf("els.profileDrawerClose.addEventListener"));
  // The two dialogs differ: a rebuild of an EXISTING config must say that hand
  // edits can be reverted and that a targeted change means running setup.py
  // with the flag, which the first-launch wording does not have to say.
  assert.match(dialog, /tp\("configPick\.setupSub"/, "the setup dialog has its own body copy");
  assert.doesNotMatch(dialog, /firstRun\.confirmSub/, "and does not borrow the first-launch body");
  assert.match(dialog, /t\("configPick\.confirmTitle"\)/);
  assert.match(dialog, /t\("configPick\.confirmAction"\)/);
  // Still the same single job + progress contract, still stopped-only.
  assert.match(dialog, /onConfirm: startConfigSetup/);
  assert.match(fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8"), /id="configPickBox"/);
});

test("the panel wires the two config routes without a second progress contract", () => {
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  assert.match(html, /id="configPickBox"/);
  assert.match(html, /id="configFileSelect"[^>]*data-i18n-aria-label="configPick\.selectLabel"/);
  assert.match(html, /id="configSetupBtn"[^>]*data-i18n="configPick\.new"/);
  assert.match(html, /id="configManagedNotice"[^>]*data-i18n="configPick\.containerManaged"/);
  // The picker is stopped-only and labelled with the candidates' context.
  assert.match(js, /const show = local && !running && !SETUP_STATES\.has\(s\.state\)/);
  assert.match(js, /tp\("configPick\.context", \{ context: c\.context \}\)/);
  // Selection persists server-side, then repaints.
  assert.match(js, /api\("config\/select", \{ method: "POST", body: JSON\.stringify\(\{ file \}\) \}\)/);
  // "Run setup" reuses the shared first-run overlay + GET /start polling.
  assert.match(js, /api\("config\/setup", \{ method: "POST" \}\)/);
  assert.match(js, /showFirstRunOverlay\(res, "configPick\.running"\)/);
  assert.match(js, /await waitForFirstRun\(\)/);
  // No bespoke progress route was introduced.
  assert.doesNotMatch(js, /config\/setup\/progress|config\/setup\/log/);
});

test("the /config routes are mounted and answer 400 on a bad selection", async () => {
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  const handlers = {};
  const app = { post: (p, h) => { handlers[p] = h; } };
  registerConfigRoutes(app, ctx);
  assert.equal(typeof handlers["/config/select"], "function");
  assert.equal(typeof handlers["/config/setup"], "function");

  const call = (path, body) =>
    handlers[path]({
      req: { json: async () => body },
      json: (data, status) => ({ data, status }),
    });

  const bad = await call("/config/select", { file: "nope.json" });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /配置不存在/);

  const ok = await call("/config/select", { file: "strata-b.json" });
  assert.equal(ok.status, undefined, "a 2xx response carries no explicit status");
  assert.equal(ok.data.saved, true);
  assert.equal(ok.data.configFile, "strata-b.json");
});

test("the routes refuse a running service and non-local profiles", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes/config.js"), "utf8");
  assert.match(src, /RUNNING_STATES\.has\(status\.state\)/);
  assert.match(src, /status\.profile\?\.type === "container" \|\| status\.launch\?\.method === "docker"/);
  assert.match(src, /app\.post\(\s*"\/config\/select"/);
  assert.match(src, /app\.post\(\s*"\/config\/setup"/);
  // A new config is built by the shared first-run job, not a parallel pipeline.
  assert.match(src, /beginFirstRun\(ctx, \{ \.\.\.opts, force: true, startAfter: false \}\)/);
});
