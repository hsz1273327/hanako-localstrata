// The config parameter editor: reading the values, and what counts as a change.
//
// Two faults are pinned here, both reported from a real UI session:
//   1. every parameter field came out EMPTY, and
//   2. "pending changes" listed a wall of phantom edits (`context: — → --`) the
//      moment the editor opened.
//
// (2) had two independent causes: the comparison treated "no value" as a value
// (`String(undefined) !== String("")`), and the field collector let empty SELECT
// values into the payload while skipping empty numbers — so exactly the three
// selects (context / kv / reasoning_effort) showed up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAllConfig, getConfigView } from "../lib/strata.js";
import { buildConfigView, readConfigSummary } from "../lib/deployer/common.js";
import { tarEntryText } from "../lib/docker.js";
import { isAbsent, editDiff, valuesFingerprint, needsRefill } from "../ui/assets/edit-diff.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-editor-"));
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
    network: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
    log: { info() {}, warn() {}, error() {} },
  };
}

// A config file with the REAL shape (an `args` array + a `sampling` block, as
// setup.py writes it) plus its sibling shared-settings file.
function writeRealConfig(dir, { tag = "iq3_s", port = 8080 } = {}) {
  fs.writeFileSync(
    path.join(dir, `strata-${tag}.json`),
    JSON.stringify(
      {
        host: "0.0.0.0",
        sampling: { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0 },
        exe: "strata",
        args: [
          "--pack",
          "/data/packs/iq3_s",
          "--native",
          "/data/models/IQ3_S/a.gguf",
          "--spec",
          "4",
          "--conversation-cache-mib",
          "8192",
          "--max-context",
          "262144",
          "--kv",
          "int8",
          "--kv-resident",
          "32768",
          "--expert-cache",
          "auto",
        ],
        cwd: dir,
        model_name: "Qwen3.8-IQ3_S",
        log: "strata-iq3_s.log",
        lib_dirs: [],
        port,
        gpu: "0",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, `strata-${tag}.shared-settings.json`),
    JSON.stringify({ max_tokens: 4096, reasoning_effort: "medium" }, null, 2),
  );
}

const localProfile = (over = {}) => ({
  id: "p1",
  name: "default",
  type: "local",
  strataDir: "",
  pythonPath: "",
  gpu: "",
  ggufDir: "",
  port: 0,
  apiKey: "",
  ...over,
});

const containerProfile = (over = {}) => ({
  id: "p2",
  name: "box",
  type: "container",
  imageName: "strata",
  imageTag: "latest",
  image: "strata:latest",
  containerName: "strata",
  GpuModel: "nvidia",
  ApiKeyEnv: "",
  apiKey: "",
  DeployDir: "",
  VolumeBinds: [],
  PortBinds: [],
  environment: [],
  ulimits: [],
  security_opt: [],
  device_cgroup_rules: [],
  ...over,
});

// ── ① a stopped deployment reads the real config values ───────────────────

test("a local deployment reads every parameter out of its config file", async () => {
  const dir = tmpDir();
  writeRealConfig(dir);
  const ctx = makeCtx({
    strataDir: dir,
    configFile: "strata-iq3_s.json",
    profiles: [localProfile({ strataDir: dir })],
    activeProfileId: "p1",
  });
  const cfg = await readAllConfig(ctx);
  const view = await getConfigView(ctx, { platform: "linux" });

  assert.equal(view.hasConfig, true, "a readable config is a selected config");
  assert.equal(view.configFile, "strata-iq3_s.json");
  assert.equal(view.errors.main, null);
  // The values the form is filled from — none of them may be empty.
  assert.equal(view.values.context, 262144);
  assert.equal(view.values.kv, "int8");
  assert.equal(view.values.sessionCache, 8192);
  assert.equal(view.values.mtp, 4);
  assert.equal(view.values.port, 8080);
  assert.equal(view.values.max_tokens, 4096, "from the shared-settings file");
  assert.equal(view.values.reasoning_effort, "medium");
  assert.equal(view.values.temperature, 0.7);
  for (const [key, value] of Object.entries(view.values)) {
    if (key === "presence_penalty") continue; // a legitimate 0
    // Optional by design: an absent flag IS the engine's default here (this model's
    // experts fit, so there is no `--resident-budget-gib`).
    if (key === "residentBudget") continue;
    assert.ok(!isAbsent(value), `${key} must not come back empty`);
  }
  // And the summary agrees (used elsewhere).
  assert.equal(readConfigSummary(cfg).context, 262144);
});

test("a container whose config cannot be read reports hasConfig=false", async () => {
  // `docker exec cat` against a stopped container yields "" — that is not a config.
  const docker = {
    available: () => true,
    compose: { available: () => false },
    inspect: () => ({ Name: "/strata", Config: { Image: "strata:latest", Env: ["PORT=8080", "MODEL=IQ3_S"] }, State: { Status: "exited" } }),
    exec: () => "",
    catFile: () => null,
  };
  const ctx = makeCtx({
    profiles: [containerProfile()],
    activeProfileId: "p2",
  });
  const view = await getConfigView(ctx, { docker, platform: "linux" });

  assert.equal(view.hasConfig, false, "an unreadable config must NOT claim to be a config");
  assert.equal(view.configFile, "strata-iq3_s.json", "the name is still reported (it comes from the container env)");
  assert.ok(view.errors.main, "and the read failure is reported");
  // Every value is absent — which is why the editor used to open blank.
  for (const [key, value] of Object.entries(view.values)) {
    assert.ok(isAbsent(value), `${key} must be absent`);
  }
  // The payload for that state is what the editor now guards on.
  assert.equal(buildConfigView({ configFile: "x.json", mainName: "x.json", sharedName: "y.json", mainText: "", sharedText: "" }).hasConfig, false);
});

test("the config view reports what setup built it as (表一's data)", async () => {
  // The facts a setup run decided that have no editable field anywhere. `gpu: 0` is
  // a REAL card (this install writes 0), a layer split records a list, and an
  // absent key means setup did not record it (this install's config has no
  // `backend`) — shown as such rather than guessed.
  const { setupFacts } = await import("../lib/deployer/common.js");
  assert.deepEqual(setupFacts({ model_name: "qwen3.8-flash-next-iq3_s", gpu: 0 }), {
    model: "qwen3.8-flash-next-iq3_s",
    backend: undefined,
    gpu: "0",
  });
  assert.equal(setupFacts({ gpu: [0, 2] }).gpu, "0,2", "a layer split is a list");
  assert.equal(setupFacts({ backend: "hip" }).backend, "hip");
  assert.deepEqual(setupFacts(null), { model: undefined, backend: undefined, gpu: undefined });
  assert.deepEqual(setupFacts(undefined), { model: undefined, backend: undefined, gpu: undefined });

  //…and the canonical view carries it alongside the editable values.
  const view = buildConfigView({
    configFile: "strata-iq3_s.json",
    mainName: "strata-iq3_s.json",
    sharedName: "strata-iq3_s.shared-settings.json",
    mainText: JSON.stringify({ model_name: "m", gpu: 0, args: ["--max-context", "262144", "--kv", "int8"] }),
    sharedText: "{}",
  });
  assert.equal(view.hasConfig, true);
  assert.deepEqual(view.setup, { model: "m", backend: undefined, gpu: "0" });
  assert.equal(view.values.context, 262144, "and the editable values are unchanged");
});

// ── the tar a `docker cp … -` hands back ─────────────────────────────────

// `docker cp` writes a tar archive to stdout, never the bare file. The old
// `catFile` returned that stream as-is, so the caller got a blob whose first
// bytes are the file NAME — non-empty, not JSON, and therefore "a config that
// reads as empty".
function tarOf(name, content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  header.write("00000000000\0", 136, "utf8");
  header.write("        ", 148, "utf8");
  header.write("0", 156, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]).toString("utf8");
}

test("the docker-cp tar stream is decoded to the file it carries", () => {
  const json = '{\n  "port": 8080,\n  "args": ["--max-context", "262144"]\n}';
  const tar = tarOf("strata-iq3_s.json", json);
  assert.ok(tar.startsWith("strata-iq3_s.json"), "the raw stream starts with the file name");
  assert.equal(tarEntryText(tar), json, "and the decoded entry is the file, byte for byte");
  // The decoded text is what the config reader expects.
  assert.equal(parseOf(tarEntryText(tar)).port, 8080);
  // Not a tar → nothing to hand back (never a half-decoded blob).
  assert.equal(tarEntryText("not a tar"), null);
  assert.equal(tarEntryText(""), null);
  assert.equal(tarEntryText(null), null);
});

function parseOf(text) {
  return JSON.parse(text);
}

test("a raw tar blob is not mistaken for a config", () => {
  const tar = tarOf("strata-iq3_s.json", '{"port": 8080}');
  const view = buildConfigView({ configFile: "strata-iq3_s.json", mainName: "strata-iq3_s.json", sharedName: "s.json", mainText: tar, sharedText: null });
  assert.equal(view.hasConfig, false, "the header garbage must not claim to be a config");
  assert.ok(view.errors.main, "and the failure is reported");

  // The decoded text IS a config.
  const good = buildConfigView({ configFile: "strata-iq3_s.json", mainName: "strata-iq3_s.json", sharedName: "s.json", mainText: tarEntryText(tar), sharedText: null });
  assert.equal(good.hasConfig, true);
  assert.equal(good.values.port, 8080);
});

// ── ②③ what counts as a change ───────────────────────────────────────────

const TYPES = { context: "number", kv: "text", sessionCache: "number", reasoning_effort: "text" };

test("nothing vs nothing is not a change (the phantom diff)", () => {
  // Exactly the reported case: the config was unreadable, so every baseline value
  // is absent AND the form is empty.
  const { items, payload, cleared } = editDiff({}, { context: "", kv: "", reasoning_effort: "" }, TYPES);
  assert.deepEqual(items, [], "an empty form over an unreadable config is not a change");
  assert.deepEqual(payload, {}, "and it must never be sent");
  assert.deepEqual(cleared, []);
});

test("an untouched readable config is not a change either", () => {
  const baseline = { context: 262144, kv: "int8", sessionCache: 8192, reasoning_effort: "medium" };
  const raw = { context: "262144", kv: "int8", sessionCache: "8192", reasoning_effort: "medium" };
  const { items, payload } = editDiff(baseline, raw, TYPES);
  assert.deepEqual(items, []);
  assert.deepEqual(payload, {});
});

test("a real edit is a change, typed by the field", () => {
  const baseline = { context: 262144, kv: "int8" };
  const { items, payload } = editDiff(baseline, { context: "131072", kv: "q4_0" }, TYPES);
  assert.equal(items.length, 2);
  assert.deepEqual(payload, { context: 131072, kv: "q4_0" });
});

test("a field the user emptied IS a change, but is not sent", () => {
  const baseline = { sessionCache: 8192, context: 262144 };
  const { items, payload, cleared } = editDiff(baseline, { sessionCache: "", context: "262144" }, TYPES);
  assert.equal(items.length, 1, "clearing a field shows up");
  assert.deepEqual(items[0], { key: "sessionCache", old: 8192, next: null });
  assert.deepEqual(cleared, [{ key: "sessionCache", old: 8192 }], "and is reported as a clear");
  assert.deepEqual(payload, {}, "an empty value is not writable — the writer rewrites flags, it cannot remove them");
});

test("a half-typed number is not an edit yet", () => {
  const { items, payload } = editDiff({ context: 262144 }, { context: "-" }, TYPES);
  assert.deepEqual(items, []);
  assert.deepEqual(payload, {});
});

test("an empty value that never had one is ignored, not reported as a clear", () => {
  const { items, cleared, payload } = editDiff({ context: 262144 }, { context: "262144", mtp: "" }, TYPES);
  assert.deepEqual(items, []);
  assert.deepEqual(cleared, [], "there was nothing to clear");
  assert.deepEqual(payload, {});
});

// ── the refill guard (why the editor could stay blank) ───────────────────

// The editor refills on the VALUES, not the file name: a config that was
// momentarily unreadable keeps its name but gains values, and the old
// name-only guard left the form showing the empty first answer forever.
test("the editor refills when the answer changes, not only when the name does", () => {
  const empty = { configFile: "strata-iq3_s.json", hasConfig: true, values: {} };
  const filled = { configFile: "strata-iq3_s.json", hasConfig: true, values: { context: 262144, kv: "int8" } };

  // First answer (empty) is taken, then the same file becomes readable.
  assert.equal(needsRefill(null, empty), true, "the first answer is always taken");
  assert.equal(
    needsRefill({ file: "strata-iq3_s.json", values: valuesFingerprint(empty.values) }, filled),
    true,
    "the SAME file with values must refill — this is the bug that left the form blank",
  );

  // An unchanged answer never refills (a poll must not stomp typing).
  assert.equal(
    needsRefill({ file: "strata-iq3_s.json", values: valuesFingerprint(filled.values) }, filled),
    false,
  );
  // A different file always refills.
  assert.equal(needsRefill({ file: "other.json", values: valuesFingerprint(filled.values) }, filled), true);
  // Nothing readable → nothing to fill (the caller locks the fields instead).
  assert.equal(needsRefill(null, { configFile: "x.json", hasConfig: false, values: {} }), false);
});

// ── one save button, because a stopped deployment has nothing to restart ──

// The editor is only visible while stopped, and the old "save & restart" did not
// merely no-op: `restart()` fails its stop phase, waits 3 s and then STARTS the
// service — so the label said "restart" while the effect was "start".
test("the parameter editor offers one save, with no button that cannot take effect", () => {
  const html = read("ui/panel.html");
  const js = read("ui/assets/panel.js");
  assert.doesNotMatch(html, /id="saveRestartBtn"/, "no second save button in the editor");
  assert.doesNotMatch(js, /saveRestartBtn/);
  // The panel never asks the route to restart…
  assert.doesNotMatch(js, /restart:\s*true/, "no restart request from the panel");
  assert.doesNotMatch(js, /save\(true\)/, "save takes no restart argument");
  assert.match(js, /els\.saveBtn\.addEventListener\("click", \(\) => save\(\)\)/);
  assert.match(js, /async function save\(\)/);
  // …and POST /settings no longer restarts at all (the editor only exists while
  // stopped, where a "restart" would in fact START the service).
  assert.doesNotMatch(read("routes/settings.js"), /body\?\.restart/);
  assert.doesNotMatch(read("routes/settings.js"), /restartService/);
  // The genuinely-live restart paths are kept, and must not regress:
  //   * the LAN mode switch (routes/mode.js) — a real stop+start;
  //   * the strata_control tool's explicit "restart" action.
  assert.match(read("routes/mode.js"), /if \(body\?\.restart && result\.saved\) \{\s*result\.restart = await restartService\(ctx\);/);
  assert.match(read("tools/strata_control.js"), /action === "restart"\) result = await restartService\(sdk\)/);
  // The panel's mode switch still asks for that restart, overlay and all.
  assert.match(js, /api\("mode", \{ method: "POST", body: JSON\.stringify\(\{ mode, restart \}\) \}\)/);
  assert.match(js, /setWorking\("restart"\)/);
});
test("the removed button leaves no orphan keys, and the honest notes stay", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    assert.equal(STRINGS[lang]["common.saveRestart"], undefined, `${lang} still carries common.saveRestart`);
    assert.equal(STRINGS[lang]["edit.savingRestart"], undefined, `${lang} still carries edit.savingRestart`);
    // Kept: the legend note (params that need a restart) and the result copy.
    assert.ok(STRINGS[lang]["edit.needsRestart"], `${lang} lost the restart-required note`);
    assert.ok(STRINGS[lang]["edit.restartRequired"], `${lang} lost the restart-required result copy`);
    assert.ok(STRINGS[lang]["overlay.restart"], `${lang} lost the service-restart overlay copy`);
  }
  for (const rel of ["ui/panel.html", "ui/assets/panel.js", "ui/assets/settings.js"]) {
    assert.doesNotMatch(read(rel), /saveRestart|savingRestart/, `${rel} still references the removed copy`);
  }
});

// ── the panel wires the shared model (source guards) ─────────────────────

test("the panel's diff and payload come from the one shared model", () => {
  const src = read("ui/assets/panel.js");
  assert.match(src, /from "\.\/edit-diff\.js"/);
  assert.match(src, /return editDiff\(state\.config\?\.values \|\| \{\}, raw, types\)/);
  // The refill guard is value-keyed, not name-keyed.
  assert.match(src, /if \(needsRefill\(state\.configFilled, cfg\)\)/);
  assert.doesNotMatch(src, /configFileFilled/);
  // The old comparison (which read "no value" as a value) is gone.
  assert.doesNotMatch(src, /String\(current\[key\]\) !== String\(val\)/);
  // And the save takes its payload from the same call, refusing a cleared field.
  assert.match(src, /const \{ payload: edits, cleared \} = configEdits\(\)/);
  assert.match(src, /if \(cleared\.length\)/);
});
