// Vision (image input) on both sides.
//
//   * Container: the image reads the `VISION` environment variable
//     (`docker-entrypoint.sh:13`, default `no`; `no` / `yes` / `cpu`, where `cpu`
//     keeps the image encoder on the CPU). The profile carries it as its own
//     field and it lands in the compose environment — merging mmproj is the
//     image's job (it takes it from the model directory), so there is no mmproj
//     field for containers.
//   * Local: setup.py writes the config's `vision` block (encoder, GPU/CPU
//     choice, mmproj path — one of its SETUP_KEYS), so the app REPORTS it and
//     offers no edit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerSettingsRoutes from "../routes/settings.js";
import { readAllConfig, normalizeProfile, validateProfile } from "../lib/strata.js";
import { containerSpec, renderComposeFile } from "../lib/compose.js";
import { VISION_VALUES, emptyContainerProfile } from "../lib/profiles.js";
import { effectiveContainerFields } from "../lib/deployer/common.js";
import { VISION_OPTIONS } from "../ui/assets/profile-fields.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-vision-"));
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

const containerProfile = (over = {}) =>
  normalizeProfile({
    id: "p1",
    name: "box",
    type: "container",
    imageName: "strata",
    imageTag: "latest",
    containerName: "strata",
    GpuModel: "nvidia",
    ...over,
  });

// ── container: the field → VISION in the environment ─────────────────────

test("the vision switch reaches the container environment as VISION", () => {
  const spec = containerSpec(containerProfile({ Vision: "cpu" }));
  assert.equal(spec.vision, "cpu");
  assert.ok(spec.environment.includes("VISION=cpu"), JSON.stringify(spec.environment));
  const yml = renderComposeFile(spec, { profileName: "box" });
  assert.match(yml, /- "VISION=cpu"/);
});

test("an empty vision field writes nothing, leaving the image's default (no)", () => {
  const spec = containerSpec(containerProfile({ Vision: "" }));
  assert.equal(spec.vision, "");
  assert.ok(!spec.environment.some((e) => e.startsWith("VISION=")), JSON.stringify(spec.environment));
  assert.doesNotMatch(renderComposeFile(spec, {}), /VISION=/);
});

test("a hand-written VISION entry in the environment list still wins", () => {
  const spec = containerSpec(containerProfile({ Vision: "cpu", environment: ["VISION=yes", "FOO=1"] }));
  const entries = spec.environment.filter((e) => e.startsWith("VISION="));
  assert.deepEqual(entries, ["VISION=yes"], "the user's own entry is not duplicated or overridden");
  assert.ok(spec.environment.includes("FOO=1"));
});

test("an unknown vision value is ignored by the spec and refused by validation", () => {
  const spec = containerSpec(containerProfile({ Vision: "gpu" })); // local vocabulary, not the image's
  assert.equal(spec.vision, "");
  assert.ok(!spec.environment.some((e) => e.startsWith("VISION=")));

  const { errors } = validateProfile(containerProfile({ Vision: "gpu" }), { profiles: [], isNew: true });
  assert.ok(errors.includes("visionInvalid"), JSON.stringify(errors));
  // …and every value the image documents is accepted.
  for (const value of VISION_VALUES) {
    const ok = validateProfile(containerProfile({ Vision: value }), { profiles: [], isNew: true });
    assert.ok(!ok.errors.includes("visionInvalid"), `${value} must be accepted`);
  }
});

// ── local: the setup-written block is REPORTED, never edited ─────────────

// The real shape, from this machine's install: encoder present, `gpu: false`
// (the CPU encoder) and the mmproj next to the shards.
function writeVisionConfig(dir, vision) {
  const cfg = { host: "0.0.0.0", port: 8080, args: ["--max-context", "262144"], api_key: "k" };
  if (vision) cfg.vision = vision;
  fs.writeFileSync(path.join(dir, "strata-iq3_s.json"), JSON.stringify(cfg, null, 2));
}

const localProfile = (dir) => ({
  id: "p2",
  name: "src",
  type: "local",
  strataDir: dir,
  pythonPath: "",
  gpu: "",
  ggufDir: "",
  port: 0,
  apiKey: "",
});

async function profilesPayload(ctx) {
  const handlers = {};
  registerSettingsRoutes({ get: (p, h) => (handlers[p] = h), post: (p, h) => (handlers[p] = h) }, ctx);
  const res = await handlers["/profiles"]({ req: { json: async () => ({}) }, json: (data) => ({ data }) });
  return res.data;
}

test("a local config's vision block is reported read-only", async () => {
  const dir = tmpDir();
  writeVisionConfig(dir, {
    exe: "/data/hanako/Strata/engine/strata-vision",
    mmproj: "/data/hanako/Strata-data/models/mmproj-Qwen3.8-Flash-Next-BF16.gguf",
    model: "/data/hanako/Strata-data/models/IQ3_S/a.gguf",
    gpu: false,
    max_tokens: 300,
    threads: 8,
  });
  const ctx = makeCtx({ strataDir: dir, configFile: "strata-iq3_s.json", profiles: [localProfile(dir)], activeProfileId: "p2" });
  const payload = await profilesPayload(ctx);
  assert.deepEqual(payload.vision, {
    available: true,
    encoder: "cpu",
    mmproj: "mmproj-Qwen3.8-Flash-Next-BF16.gguf",
    exe: "strata-vision",
  });
});

test("vision off (no block) and a container profile report no local vision", async () => {
  const dir = tmpDir();
  writeVisionConfig(dir, null);
  const off = makeCtx({ strataDir: dir, configFile: "strata-iq3_s.json", profiles: [localProfile(dir)], activeProfileId: "p2" });
  assert.deepEqual((await profilesPayload(off)).vision, { available: false, encoder: "", mmproj: "", exe: "" });

  // A container keeps its config inside the container: unknown from here.
  const box = makeCtx({ profiles: [containerProfile()], activeProfileId: "p1" });
  assert.equal((await profilesPayload(box)).vision, null);
});

// ── mmproj: NOT a second field (it rides with the model directory) ────────

// The relationship, from the two authorities:
//   * the image takes the mmproj OUT OF the model directory — setup.py:5288 is
//     the same rule (`(Path(gguf_dir)/fam["mmproj"]).exists()`), and
//     strata-docker-run.md:112 says it is in the same directory and not
//     downloaded again when VISION is on;
//   * a local install's `vision.mmproj` is a setup-written key (SetUP_VISION in
//     setup.py), and this machine shows the file present IN the model directory
//     (`…/models/IQ3_S/mmproj-….gguf`) with a second copy one level up that setup
//     happened to pick.
// So a separate "mmproj directory" field would drift from ModelDir and make the
// user point twice. mmproj travels with ModelDir — which already has "profile
// overrides, general default falls back".
test("the mmproj is not a profile field; it travels with the model directory", async () => {
  const profiles = read("lib/profiles.js");
  assert.doesNotMatch(profiles, /mmprojDir|MMProjDir/i, "no second directory field on the model");
  const containerKeys = Object.keys(emptyContainerProfile());
  assert.ok(!containerKeys.some((k) => /mmproj/i.test(k)), `container fields: ${containerKeys.join(",")}`);
  const fields = read("ui/assets/profile-fields.js");
  assert.doesNotMatch(fields, /mmprojDir|MMProjDir/i, "no second directory field in the UI");
  // A container gets no MMPROJ/MMPROJ environment plumbing either.
  const spec = containerSpec(containerProfile({ ModelDir: "/own", Vision: "cpu" }));
  assert.ok(!spec.environment.some((e) => /mmproj/i.test(e)), JSON.stringify(spec.environment));

  // The ONE path that carries it is the model bind — profile value first, then the
  // general default — so the mmproj is covered by the same fallback pattern.
  assert.equal(effectiveContainerFields({}, { defaultGgufDir: "/general/models" }).ModelDir, "/general/models");
  assert.equal(effectiveContainerFields({ ModelDir: "/own" }, { defaultGgufDir: "/general/models" }).ModelDir, "/own");
  assert.equal(containerSpec(containerProfile({ ModelDir: "/own" })).modelDir, "/own");

  // The UI states where the image takes it from, so the relationship is not
  // folklore the next reader has to rediscover.
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    assert.match(STRINGS[lang]["field.visionHint"], /mmproj/i, `${lang}.field.visionHint must mention mmproj`);
  }
});

// ── the shared UI module ─────────────────────────────────────────────────

test("the module's vision list is the model's list", () => {
  assert.deepEqual(VISION_OPTIONS, VISION_VALUES, "the asset must not drift from lib/profiles.js");
});

test("the container block renders the vision switch inside the advanced group", () => {
  const src = read("ui/assets/profile-fields.js");
  // A select, never free text, fed from the one list.
  assert.match(src, /make\("select", \{ id: `\$\{p\}vision` \}\)/);
  assert.match(src, /for \(const value of VISION_OPTIONS\)/);
  assert.match(src, /"Vision",\n    "apiKey",/);
  assert.match(src, /Vision: visionInput\.value\.trim\(\)/);
  // The read-only local status is a real fragment both pages mount.
  assert.match(src, /export function createVisionStatus\(/);
  assert.match(read("ui/assets/settings.js"), /createVisionStatus\(els\.profileLocalVision/);
  // Mounted at the TOP of the local block: a read-only report precedes the fields
  // that can be changed (the API key keeps its own mount point below them).
  assert.match(read("ui/assets/panel.js"), /createVisionStatus\(root\.querySelector\("#ps-local-vision"\)/);
  assert.match(read("ui/assets/settings.js"), /localVisionStatus\.render\(visionInfo\)/);
  assert.match(read("ui/assets/panel.js"), /pluginFormEls\.localVision\.render\(visionInfo\)/);
  // Both pages read the state from /profiles.
  for (const rel of ["ui/assets/settings.js", "ui/assets/panel.js"]) {
    assert.match(read(rel), /vision: data\?\.vision|visionInfo = data\?\.vision/, `${rel} must take the vision state from /profiles`);
  }
});

test("the vision copy exists in all six locales", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const keys = ["field.vision", "field.visionHint", "field.visionPlaceholder", "vision.on", "vision.off", "vision.encoderCpu", "vision.encoderGpu", "vision.mmproj", "vision.setupNote"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // The hint has to name the three values the image accepts.
    for (const value of ["no", "yes", "cpu"]) {
      assert.match(STRINGS[lang]["field.visionHint"], new RegExp(value), `${lang}.field.visionHint must mention ${value}`);
    }
    // The read-only line says who owns it, and names the exact way out.
    assert.match(STRINGS[lang]["vision.setupNote"], /setup/i, `${lang}.vision.setupNote must name setup`);
    assert.match(STRINGS[lang]["vision.setupNote"], /--vision/, `${lang}.vision.setupNote must name the flag`);
    // The two vocabularies are tied together, so `gpu` and `yes` do not read as
    // two unrelated things.
    assert.match(STRINGS[lang]["vision.encoderGpu"], /yes|VISION=yes/, `${lang}.vision.encoderGpu must name the container's spelling`);
    assert.match(STRINGS[lang]["vision.encoderCpu"], /VISION=cpu|cpu/, `${lang}.vision.encoderCpu must name the container's spelling`);
  }
});

// ── the local side has no switch, and that is the finding ────────────────

// Editing the config's `vision.gpu` is NOT a supported way to move the encoder
// between CPU and GPU: setup COMPILES a per-mode `strata-vision`
// (`setup.py:3229`, `-DSTRATA_VISION_CUDA=ON/OFF`) and bakes a per-mode
// `--vram-reserve-mib` into the engine's args (`setup.py:5416`); the engine itself
// tolerates a hand-edited section but tells you to re-run setup
// (`serve/server.py:2174-2181`). So the app reports the state and points at
// setup, instead of offering a switch that half-works.
test("the local vision state stays read-only, pointing at setup", async () => {
  const { emptyLocalProfile } = await import("../lib/profiles.js");
  // No local vision field to write: the local model carries none.
  assert.ok(!("Vision" in emptyLocalProfile()), "no Vision field on the local model");
  assert.ok(!("Vision" in normalizeProfile({ type: "local", strataDir: "/s", Vision: "gpu" })), "and normalization drops one if it appears");
  const fields = read("ui/assets/profile-fields.js");
  const status = fields.slice(fields.indexOf("// ── the local vision state (read-only)"), fields.indexOf("// ── the module ──"));
  assert.match(status, /function paint\(info\)/, "the fragment only paints");
  assert.doesNotMatch(status, /addEventListener|execCommand|collect\(/, "no write path in the read-only line");
  // …and the reason is on the record where the next reader will look.
  assert.match(status, /setup\.py:3229/);
  assert.match(status, /server\.py:2174/);
});

// ── the MI50 preset must not carry an env the image ignores ──────────────

// Its README (xxDoman/strata-gfx906, master, "## Vision (images)") enables images
// from the :8090 configurator, not from the environment, and ships a CPU-only
// encoder. A `VISION` there would be a no-op that reads as if vision were on.
test("the MI50 preset sets no VISION env (the image reads none)", async () => {
  const { mi50Preset } = await import("../lib/mi50.js");
  const preset = mi50Preset({ containerName: "strata-mi50", home: "/home/u" });
  assert.ok(!("Vision" in preset), "the preset must not set the container Vision field");
  const env = (preset.environment || []).join(" ");
  assert.doesNotMatch(env, /VISION/i, `the preset's env: ${env}`);
  // The reason is recorded next to the constants.
  const src = read("lib/mi50.js");
  assert.match(src, /does not read a `VISION` environment variable/i);
  assert.match(src, /mi50-image-compat\.md/);
});
