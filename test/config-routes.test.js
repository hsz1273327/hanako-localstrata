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
import { listStrataPids } from "../lib/process.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];

// These routes are STOPPED-only BY DESIGN, and the guard reads the real machine:
// `assertConfigEditable` -> `getStatus` -> an HTTP probe of 127.0.0.1:<port> plus a
// machine-wide process scan (lib/deployer/source.js:229-252). Someone who is running
// Strata while this suite runs therefore makes the guard fire — that is the correct
// behaviour, not a regression — so the stopped-only cases SKIP instead of pretending
// to pass. They run normally on a machine with no live service.
const liveStrata = () => listStrataPids(process.platform).length;
function skipIfLive(t) {
  const n = liveStrata();
  if (!n) return false;
  t.skip(`a Strata service is running on this machine (${n} pid(s)): the stopped-only guard is doing its job`);
  return true;
}

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

test("selectConfig writes the top-level selection and returns the fresh status", async (t) => {
  if (skipIfLive(t)) return;
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  const res = await selectConfig(ctx, "strata-b.json", { platform: "linux" });
  assert.equal(res.saved, true);
  assert.equal(res.configFile, "strata-b.json");
  assert.equal(ctx._store.configFile, "strata-b.json");
  assert.equal(res.status.configFile, "strata-b.json");
});

test("selectConfig refuses a file that is not a real candidate", async (t) => {
  if (skipIfLive(t)) return;
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

test("startConfigSetup runs the setup job with startAfter:false and never starts the service", async (t) => {
  if (skipIfLive(t)) return;
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

test("startConfigSetup forwards only whitelisted setup parameters", async (t) => {
  if (skipIfLive(t)) return;
  resetFirstRunState();
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  let spawnedArgs = null;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {} }),
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "/models/x", configFile: "strata-a.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        fs.writeFileSync(path.join(dir, "strata-b.json"), JSON.stringify({ port: 59996 }));
        child.emit("close", 0);
      });
      return child;
    },
  };
  const res = await startConfigSetup(ctx, { io, platform: "linux", setup: { vision: "gpu", lowRam: "on" } });
  assert.equal(res.running, true);
  assert.deepEqual(res.plan.setup, { vision: "gpu", lowRam: "on" }, "the plan echoes what will be passed");
  const deadline = Date.now() + 3000;
  while (!getFirstRunState().done && !getFirstRunState().error && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(spawnedArgs[spawnedArgs.indexOf("--vision") + 1], "gpu");
  assert.equal(spawnedArgs[spawnedArgs.indexOf("--low-ram") + 1], "on");

  // A value setup does not accept never reaches the job.
  resetFirstRunState();
  await assert.rejects(
    () => startConfigSetup(ctx, { io, platform: "linux", setup: { vision: "maybe" } }),
    /vision/,
  );
  assert.equal(getFirstRunState().running, false, "no job was started");
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
  const hintKeys = ["edit.kvStreamHint", "edit.lowRamHint", "setupFacts.visionHint"];
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
  // "Run setup" reuses the shared first-run overlay + GET /start polling, and
  // carries the parameters the user asked to change (the popover's form).
  assert.match(js, /api\("config\/setup", \{ method: "POST", body: JSON\.stringify\(\{ setup, backupAs \}\) \}\)/);
  assert.match(js, /showFirstRunOverlay\(res, "configPick\.running"\)/);
  assert.match(js, /await waitForFirstRun\(\)/);
  // No bespoke progress route was introduced.
  assert.doesNotMatch(js, /config\/setup\/progress|config\/setup\/log/);
});

test("the setup confirmation is modal: a scrim blocks the panel behind it", () => {
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "ui/assets/panel.css"), "utf8");
  // The element, in the popover's own layer order (scrim first, dialog above it).
  const scrimAt = html.indexOf('id="confirmScrim"');
  assert.ok(scrimAt > 0, "the scrim exists");
  assert.ok(scrimAt < html.indexOf('id="confirmPopover"'), "and sits before the dialog in the layer");
  assert.match(css, /\.confirm-scrim \{[^}]*position: fixed;[^}]*inset: 0;/s, "it covers the panel");
  // Same language as the drawer's scrim: a dim plus a hint of blur, and BELOW the
  // popover (200) so the dialog itself stays readable and clickable.
  const rule = css.match(/\.confirm-scrim \{([\s\S]*?)\}/)[1];
  assert.match(rule, /background: rgba\(0, 0, 0/);
  const scrimZ = Number(rule.match(/z-index: (\d+)/)[1]);
  const popoverZ = Number(css.match(/\.confirm-popover \{([\s\S]*?)\}/)[1].match(/z-index: (\d+)/)[1]);
  assert.ok(scrimZ < popoverZ, `the scrim (${scrimZ}) must sit below the dialog (${popoverZ})`);
  // Shown and hidden WITH the dialog, and never left behind.
  assert.match(js, /els\.confirmScrim\.hidden = false/);
  assert.match(js, /els\.confirmScrim\.hidden = true/);
  assert.match(js, /confirmScrim: document\.getElementById\("confirmScrim"\)/);
  // A click on the scrim must NOT reach the panel, and must NOT cancel either:
  // this dialog guards a heavy operation and may hold a half-filled form.
  const pointerdown = js.slice(js.indexOf("function confirmDocPointerDown"), js.indexOf("// Place the popover right-aligned"));
  assert.match(pointerdown, /ev\.target === els\.confirmScrim\) return;/, "the scrim swallows the click");
  assert.equal(/closeConfirm\(\)/.test(pointerdown.split("confirmScrim")[0]), false, "nothing closes before that check");
  // Esc does not dismiss it either (same reason): the Escape handler belongs to
  // the profile drawer only.
  const esc = js.slice(js.indexOf('e.key === "Escape"'), js.indexOf('e.key === "Escape"') + 200);
  assert.match(esc, /profileDrawer/);
  assert.doesNotMatch(esc, /confirm/i);
  // It is announced as a modal dialog while it is open.
  assert.match(js, /setAttribute\("aria-modal", "true"\)/);
  assert.match(js, /setAttribute\("aria-modal", "false"\)/);
});

test("the /config routes are mounted and answer 400 on a bad selection", async (t) => {
  if (skipIfLive(t)) return;
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  const handlers = {};
  const app = {
    get: (p, h) => {
      handlers[p] = h;
    },
    post: (p, h) => {
      handlers[p] = h;
    },
  };
  registerConfigRoutes(app, ctx);
  assert.equal(typeof handlers["/config/select"], "function");
  assert.equal(typeof handlers["/config/setup"], "function");
  assert.equal(typeof handlers["/config/setup-plan"], "function");

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
  // A config is built by the shared first-run job, not a parallel pipeline, and
  // only whitelisted setup parameters are forwarded into it.
  assert.match(src, /validateSetupParams\(opts\.setup\)/);
  assert.match(src, /beginFirstRun\(ctx, \{ \.\.\.opts, setup: clean, force: true, startAfter: false \}\)/);
});

// ── where a "Run setup…" writes ───────────────────────────────────────────

// setup.py derives the config file name (`tag = fam["tag"] + model` → 
// `ROOT / f"strata-{tag.lower()}.json"`, setup.py:5034 / :5507) and takes NO name
// argument (there is no --config/--name/--out). So the dialog must SAY where it
// will write instead of offering a knob that cannot work — and it must say the
// rule for the one case that produces a second file (another family or size).
test("the setup dialog says which config file it will write", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  assert.match(html, /id="setupTargetFile"/, "the dialog names the target file");
  // Before the parameter fields: what will happen, then what can be set.
  const form = html.slice(html.indexOf('id="setupParams"'), html.indexOf("confirm-popover-actions"));
  assert.ok(form.indexOf('id="setupTargetFile"') < form.indexOf('id="sp-vision"'), "and before the fields");
  // Filled from the REAL selection, never invented.
  assert.match(js, /state\.config\?\.configFile \|\| state\.status\?\.configFile/);
  assert.match(js, /tp\("configPick\.targetNow", \{ file \}\)/);
  assert.match(js, /t\("configPick\.targetUnknown"\)/);
  // No name field, and no target flag invented for setup.py.
  assert.doesNotMatch(html, /data-setup="fileName"|id="sp-configName"/);
  const firstrun = fs.readFileSync(path.join(ROOT, "lib/firstrun.js"), "utf8");
  assert.doesNotMatch(firstrun, /"--config"|"--name"/, "setup takes no target name");
});

test("the target copy exists in six locales and states both cases", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    for (const key of ["configPick.targetLabel", "configPick.targetNow", "configPick.targetUnknown", "configPick.targetRule"]) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // The same-file case takes the real name, and says the old contents are kept.
    assert.match(STRINGS[lang]["configPick.targetNow"], /\{file\}/, `${lang}.targetNow must interpolate the name`);
    assert.match(STRINGS[lang]["configPick.targetNow"], /\.bak/, `${lang}.targetNow must mention the backup`);
    // The rule: derived by setup, cannot be set here, and another family/size
    // writes a NEW file.
    assert.match(STRINGS[lang]["configPick.targetRule"], /strata-/, `${lang}.targetRule must show the name shape`);
    assert.match(STRINGS[lang]["configPick.targetRule"], /setup/, `${lang}.targetRule must name who derives it`);
  }
});

// ── the optional pre-setup backup ─────────────────────────────────────────

import { backupTargetName, backupCurrentConfig } from "../routes/config.js";

test("the backup name shape is the one the config picker can list", () => {
  // `^strata-....json$` is exactly lib/deployer/common.js listConfigFiles' filter,
  // so anything we accept stays selectable — and anything else is refused.
  assert.deepEqual(backupTargetName("strata-iq2_xs-vision.json", "strata-iq2_xs.json"), {
    name: "strata-iq2_xs-vision.json",
    error: null,
  });
  assert.deepEqual(backupTargetName("  strata-a_b.c-1.json ", "current.json"), { name: "strata-a_b.c-1.json", error: null });
  // Empty = no backup (the behaviour we had before this field existed).
  assert.deepEqual(backupTargetName("", "strata-iq2_xs.json"), { name: null, error: null });
  assert.deepEqual(backupTargetName(null, "strata-iq2_xs.json"), { name: null, error: null });
  // The current name is a no-op, not an error.
  assert.deepEqual(backupTargetName("strata-iq2_xs.json", "strata-iq2_xs.json"), { name: null, error: null });
  // No path separators, no other extension, no leading dot, must keep the prefix.
  // (A trailing space is trimmed, so it lands on a valid name rather than an error.)
  for (const bad of ["../escape.json", "sub/dir.json", "strata-x.txt", "backup.json", ".strata-x.json", "strata a.json", "strata-"]) {
    assert.equal(backupTargetName(bad, "c.json").error, "backupNameShape", `${bad} must be refused`);
  }
  assert.equal(backupTargetName(" strata-x.json  ", "c.json").name, "strata-x.json", "whitespace is trimmed, not a failure");
});

test("a pre-setup backup copies the config AND its shared-settings sibling", async () => {
  const dir = makeLocalDir();
  fs.writeFileSync(path.join(dir, "strata-a.shared-settings.json"), JSON.stringify({ max_tokens: 4096 }));
  const ctx = localCtx(dir);
  // A name that already exists is refused: never overwrite a file the user has.
  fs.writeFileSync(path.join(dir, "strata-taken.json"), "{}");
  await assert.rejects(() => backupCurrentConfig(ctx, { backupAs: "strata-taken.json" }), /已存在/);
  assert.equal(fs.readFileSync(path.join(dir, "strata-taken.json"), "utf8"), "{}", "and it is untouched");

  const res = await backupCurrentConfig(ctx, { backupAs: "strata-a-keep.json" });
  assert.deepEqual(res.copied, ["strata-a-keep.json", "strata-a-keep.shared-settings.json"]);
  assert.equal(res.target, "strata-a-keep.json");
  // The copy carries the settings, and the sibling is what the server would look
  // for next to it (serve/server.py:5828 derives it from the path).
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "strata-a-keep.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(dir, "strata-a.json"), "utf8")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "strata-a-keep.shared-settings.json"), "utf8")).max_tokens, 4096);
  // The original is untouched.
  assert.ok(fs.existsSync(path.join(dir, "strata-a.json")));
  // …and no backup at all when nothing was asked for.
  assert.deepEqual(await backupCurrentConfig(ctx, {}), { copied: [], target: null });
});

test("startConfigSetup backs up first, then runs setup, and never fakes a target for it", async (t) => {
  if (skipIfLive(t)) return;
  resetFirstRunState();
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  let spawnedArgs = null;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {} }),
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "/models/x", configFile: "strata-a.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      // The backup already exists by the time setup starts, so the job's own
      // snapshot sees it and can never mistake it for this run's product.
      assert.ok(fs.existsSync(path.join(dir, "strata-a-keep.json")), "the backup exists before setup runs");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        fs.writeFileSync(path.join(dir, "strata-b.json"), JSON.stringify({ port: 59995 }));
        child.emit("close", 0);
      });
      return child;
    },
  };
  const res = await startConfigSetup(ctx, { io, platform: "linux", setup: {}, backupAs: "strata-a-keep.json" });
  assert.deepEqual(res.backup, { copied: ["strata-a-keep.json"], target: "strata-a-keep.json" });
  assert.equal(res.plan.setup && Object.keys(res.plan.setup).length, 0, "the backup is not a setup parameter");
  // setup still gets ITS OWN command, nothing about a target name.
  assert.ok(spawnedArgs.includes("--setup"));
  assert.equal(spawnedArgs.includes("--config"), false, "setup.py has no --config");
  const deadline = Date.now() + 3000;
  while (!getFirstRunState().done && !getFirstRunState().error && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(getFirstRunState().error, null);

  // A bad or taken name never starts a job.
  resetFirstRunState();
  await assert.rejects(() => startConfigSetup(ctx, { io, platform: "linux", backupAs: "nope.json" }), /backup-|strata-/);
  assert.equal(getFirstRunState().running, false, "no job for a refused backup name");
});

test("the backup field is optional, validated in the dialog, and copied under the picker's name shape", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  // The field lives in the setup dialog, AFTER the read-only target line.
  const form = html.slice(html.indexOf('id="setupParams"'), html.indexOf("confirm-popover-actions"));
  assert.match(form, /id="sp-backupAs"/);
  assert.ok(form.indexOf('id="setupTargetFile"') < form.indexOf('id="sp-backupAs"'), "target first, then the option");
  // Optional: the hint says an empty field means no backup.
  assert.match(form, /id="sp-backupAs"[^>]*data-i18n-placeholder="configPick\.backupPlaceholder"/);
  assert.match(form, /data-i18n="configPick\.backupHint"/);
  // The refusal shows in the DIALOG (its scrim covers the panel's #error area).
  assert.match(form, /id="sp-backupError"/);
  assert.match(js, /function setBackupError\(message\)/);
  assert.match(js, /setBackupError\(t\("configPick\.backupBadName"\)\)/);
  assert.doesNotMatch(js.slice(js.indexOf("async function startConfigSetup"), js.indexOf("async function startConfigSetup") + 900), /showError\(t\("configPick\.backupBadName"\)\)/);
  // It is sent as `backupAs`, separate from the setup parameters, and never as a
  // setup flag (setup.py has no target-name argument).
  assert.match(js, /JSON\.stringify\(\{ setup, backupAs \}\)/);
  // The GGUF folder rides in the same `setup` object (it is a setup param now).
  assert.match(js, /if \(ggufDir\) setup\.ggufDir = ggufDir;/);
  const firstrun = fs.readFileSync(path.join(ROOT, "lib/firstrun.js"), "utf8");
  assert.doesNotMatch(firstrun, /backupAs/);
});

test("the backup copy exists in six locales, with the shared-binary caveat", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    for (const key of ["configPick.backupLabel", "configPick.backupPlaceholder", "configPick.backupHint", "configPick.backupBadName"]) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // Empty must mean "no backup", the accepted shape must be spelled out, and the
    // caveat (a shared encoder/engine) must be said rather than implied.
    assert.match(STRINGS[lang]["configPick.backupHint"], /strata-/, `${lang}: the name shape`);
    assert.match(STRINGS[lang]["configPick.backupHint"], /GPU/, `${lang}: the shared-encoder caveat`);
    assert.match(STRINGS[lang]["configPick.backupBadName"], /strata-/, `${lang}: the refusal explains the shape`);
  }
});

// ── the backup field's DEFAULT is a real value ─────────────────────────────
//
// The user asked for a value, not a placeholder: the field opens on
// `<current minus .json>-<YYYYMMDD>.json` (ui/assets/backup-name.js), so pressing
// the button backs the current settings up without typing. Clearing it still means
// "no backup" — both states have to be readable in the copy.
test("the backup field opens on a usable default, not a placeholder", () => {
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  // A real assignment to .value, from the shared generator.
  assert.match(js, /import \{ backupDefaultName \} from "\.\/backup-name\.js"/);
  assert.match(js, /function fillBackupAs\(\)/);
  assert.match(js, /el\.value = backupDefaultName\(current, \{ existing \}\)/);
  assert.match(js, /state\.status\?\.configCandidates/);
  assert.match(js, /fillBackupAs\(\)/, "and it is called when the dialog opens");
  // The field itself carries NO value attribute: the value comes from the code
  // (a literal in the HTML would freeze today's date into the page).
  assert.doesNotMatch(html, /id="sp-backupAs"[^>]*\svalue=/, "no hard-coded value");
  assert.match(html, /id="sp-backupAs"[^>]*data-i18n-placeholder="configPick\.backupPlaceholder"/);
});

test("the backup copy reads in both states (prefilled default / cleared) in six locales", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    const hint = STRINGS[lang]["configPick.backupHint"];
    // The shape the picker can list, the clearing case, and the shared-encoder caveat.
    assert.match(hint, /strata-/, `${lang}.backupHint: the name shape`);
    assert.match(hint, /\.bak/, `${lang}.backupHint: the clearing case`);
    assert.match(hint, /GPU/, `${lang}.backupHint: the shared-encoder caveat`);
    // The placeholder stays a SHAPE (it must not age into a wrong example date).
    assert.match(STRINGS[lang]["configPick.backupPlaceholder"], /YYYYMMDD/, `${lang}.backupPlaceholder must show the shape`);
  }
});

// ── the GGUF folder: a per-run input, not a profile field ─────────────────

import { checkGgufDir } from "../routes/config.js";

test("a GGUF folder is only accepted when it is really there", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.json");
  fs.writeFileSync(file, "{}");
  // Empty = the general default, then a download: not an error.
  assert.equal(checkGgufDir({}, ""), null);
  assert.equal(checkGgufDir({}, undefined), null);
  // A relative path is refused (setup resolves it against its own cwd, which is
  // not what the user is looking at).
  assert.equal(checkGgufDir({}, "models/IQ3_S"), "ggufDirNotAbsolute");
  // Missing, or not a directory.
  assert.equal(checkGgufDir({}, path.join(dir, "nope")), "ggufDirMissing");
  assert.equal(checkGgufDir({}, file), "ggufDirNotDir");
  // A readable directory is the only thing that passes.
  assert.equal(checkGgufDir({}, dir), null);
});

test("startConfigSetup refuses an unusable GGUF folder without starting a job", async (t) => {
  if (skipIfLive(t)) return;
  resetFirstRunState();
  const dir = makeLocalDir();
  const ctx = localCtx(dir);
  let spawned = false;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {} }),
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-a.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: () => {
      spawned = true;
      throw new Error("must not run");
    },
  };
  await assert.rejects(() => startConfigSetup(ctx, { io, platform: "linux", setup: { ggufDir: path.join(dir, "nope") } }), /GGUF/);
  assert.equal(spawned, false, "the job never started");
  assert.equal(getFirstRunState().running, false);
  await assert.rejects(() => startConfigSetup(ctx, { io, platform: "linux", setup: { ggufDir: "relative/dir" } }), /GGUF/);
});

test("the GGUF folder the dialog names is what setup is given", async (t) => {
  if (skipIfLive(t)) return;
  resetFirstRunState();
  const dir = makeLocalDir();
  const models = tmpDir();
  const ctx = localCtx(dir);
  let spawnedArgs = null;
  const io = {
    getStatus: async () => ({ state: "stopped", launch: { method: "local" }, settings: {} }),
    readAllConfig: async () => ({ strataDir: dir, pythonPath: "/usr/bin/python3", ggufDir: "", configFile: "strata-a.json" }),
    saveSelectedConfig: async () => {},
    sleep: async () => {},
    spawn: (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        fs.writeFileSync(path.join(dir, "strata-b.json"), JSON.stringify({ port: 59994 }));
        child.emit("close", 0);
      });
      return child;
    },
  };
  const res = await startConfigSetup(ctx, { io, platform: "linux", setup: { ggufDir: models } });
  assert.equal(res.plan.ggufDir, models, "the plan carries the folder this run asked for");
  assert.equal(res.plan.mayDownload, false, "and no download is expected");
  const at = spawnedArgs.indexOf("--gguf-dir");
  assert.ok(at >= 0, "--gguf-dir is passed");
  assert.equal(spawnedArgs[at + 1], models);
  // Exactly once: the params loop must not add a second pair.
  assert.equal(spawnedArgs.filter((a) => a === "--gguf-dir").length, 1);
  const deadline = Date.now() + 3000;
  while (!getFirstRunState().done && !getFirstRunState().error && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(getFirstRunState().error, null);
});

test("the setup dialog has the GGUF folder field, empty, with the default named", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/panel.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  const form = html.slice(html.indexOf('id="setupParams"'), html.indexOf("confirm-popover-actions"));
  assert.match(form, /id="sp-ggufDir"/);
  assert.ok(form.indexOf('id="sp-ggufDir"') < form.indexOf('id="sp-vision"'), "it leads the parameters");
  assert.match(form, /id="sp-ggufDir"[^>]*data-i18n-placeholder="configPick\.setupGgufPlaceholder"/);
  assert.match(form, /id="sp-ggufDefault"/, "the fallback folder is named under it");
  assert.match(form, /id="sp-ggufError"/, "and a refusal shows in the dialog");
  // Empty on open: the value is the general default, so the field must not be
  // prefilled with it (that would look like this run's answer).
  assert.match(js, /function fillSetupGguf\(\)/);
  assert.match(js, /ggufEl\.value = "";/);
  assert.match(js, /tp\("configPick\.setupGgufDefault", \{ dir \}\)/);
  assert.match(js, /t\("configPick\.setupGgufDownload"\)/);
  // A relative path is refused client-side; the server checks existence.
  assert.match(js, /if \(ggufDir && !ggufDir\.startsWith\("\/"\)\)/);
  assert.match(js, /codes\.some\(\(c\) => c\.startsWith\("ggufDir"\)\)/);
  assert.doesNotMatch(html, /data-setup="ggufDir"/, "it is not one of the enum selects");
});
