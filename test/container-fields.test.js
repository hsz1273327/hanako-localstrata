// Regression guards for the container-profile *interface* introduced with the
// compose-managed container model: the shared field block
// (ui/assets/profile-fields.js), used by BOTH the settings page and the panel
// drawer.
//
// The repo is dependency-free by design (no jsdom), so the behavioural layer is
// the module's exported pure helpers (`gpuVendorOf` / `gpuIdsApplies`) plus
// source guards for the parts that only exist once a DOM is around: the GPU
// vendor split (hide AND clear the per-card field), the add/remove list rows,
// the compose-path probe, and the retired flat keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerSettingsRoutes from "../routes/settings.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";
import { gpuVendorOf, gpuIdsApplies } from "../ui/assets/profile-fields.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CATALOG = [
  { key: "nvidia", label: "NVIDIA", vendor: "nvidia", gfx: null },
  { key: "amd-mi50", label: "MI50", vendor: "amd", gfx: "gfx906" },
  { key: "amd-7900xtx", label: "7900", vendor: "amd", gfx: "gfx1100" },
];

// ── the vendor split (pure) ───────────────────────────────────────────────

test("only an NVIDIA card gets the per-card picker — the vendor split, pure", () => {
  assert.equal(gpuVendorOf(CATALOG, "nvidia"), "nvidia");
  assert.equal(gpuVendorOf(CATALOG, "amd-mi50"), "amd");
  assert.equal(gpuVendorOf(CATALOG, "amd-7900xtx"), "amd");
  assert.equal(gpuVendorOf(CATALOG, ""), "");
  assert.equal(gpuVendorOf(CATALOG, "unknown"), "");

  assert.equal(gpuIdsApplies(CATALOG, "nvidia"), true);
  // A card that cannot be picked one by one is never offered the control.
  assert.equal(gpuIdsApplies(CATALOG, "amd-mi50"), false);
  assert.equal(gpuIdsApplies(CATALOG, "amd-7900xtx"), false);
  assert.equal(gpuIdsApplies(CATALOG, ""), false);

  // Before the catalog answers, the key prefix is a safe hint (never a wrong
  // "NVIDIA" default for an AMD key, nor the reverse).
  assert.equal(gpuVendorOf([], "nvidia"), "nvidia");
  assert.equal(gpuVendorOf([], "amd-9070xt"), "amd");
  assert.equal(gpuVendorOf([], "weird"), "");
});

test("the field block hides AND clears GpuIds when the card is not NVIDIA", () => {
  const src = read("ui/assets/profile-fields.js");
  // The card picker is a dropdown fed by the catalog, not a free-text field.
  assert.match(src, /make\("select", \{ id: `\$\{p\}gpu-model` \}\)/);
  // Hidden for a non-NVIDIA vendor, and the residual value dropped so it can
  // never ride along invisibly.
  assert.match(src, /gpuIdsField\.hidden = !nvidia/);
  assert.match(src, /if \(!nvidia && gpuIds\.value\) gpuIds\.value = ""/);
  // collect() emits GpuIds for NVIDIA only — the empty value is what clears a
  // stale selection in storage too.
  assert.match(src, /GpuIds: vendorOf\(gpuModel\.value\) === NVIDIA \? gpuIds\.value\.trim\(\) : ""/);
});

// ── the list fields ──────────────────────────────────────────────────────

test("the list fields are add/remove row controls, not a blob of text", () => {
  const src = read("ui/assets/profile-fields.js");
  assert.match(src, /function listField\(/);
  assert.match(src, /function addRow\(/);
  assert.match(src, /cf-list-add/);
  assert.match(src, /cf-list-remove/);
  assert.match(src, /MAX_LIST/);
  // The five list fields the model carries. `device_cgroup_rules` has no row:
  // it is contributed by the card template, never typed.
  for (const key of ["VolumeBinds", "PortBinds", "environment", "ulimits", "security_opt"]) {
    assert.match(src, new RegExp(`listField\\("${key}"`), `listField(${key}) is missing`);
  }
  // ...and they read back as a de-duplicated, trimmed list.
  assert.match(src, /function readValues\(/);
});

test("both surfaces carry a host element, not a hand-rolled second form", () => {
  for (const [html, host] of [
    ["ui/settings.html", "pf-container-extra"],
    ["ui/panel.html", "ps-container-extra"],
  ]) {
    const text = read(html);
    assert.match(text, new RegExp(`id="${host}"`), `${html} must carry #${host}`);
    // The container block no longer hard-codes the new fields.
    assert.doesNotMatch(text, /id="(pf|ps)-(gpu-model|dataDir|volume-binds|port-binds|deploy-dir)"/, `${html} must not hand-roll the container fields`);
  }
  // Each page drives that one module, with its own id prefix.
  const settings = read("ui/assets/settings.js");
  const panel = read("ui/assets/panel.js");
  assert.match(settings, /from "\.\/profile-fields\.js"/);
  assert.match(settings, /createContainerFields\(els\.profileContainerExtra/);
  assert.match(settings, /idPrefix: "pf-"/);
  assert.match(panel, /from "\.\/profile-fields\.js"/);
  assert.match(panel, /createContainerFields\(root\.querySelector\("#ps-container-extra"\)/);
  assert.match(panel, /idPrefix: "ps-"/);
  // Saving the container fields goes through the module's collect() on both.
  assert.match(settings, /containerFields\.collect\(\)/);
  assert.match(panel, /pluginFormEls\.container\.collect\(\)/);
});

// The LOCAL side carries the same override field, mounted from the same fragment
// (it has no "advanced" group, so it mounts into its own host).
test("the local block mounts the same API-key fragment on both surfaces", () => {
  for (const [html, host] of [
    ["ui/settings.html", "pf-local-extra"],
    ["ui/panel.html", "ps-local-extra"],
  ]) {
    assert.match(read(html), new RegExp(`id="${host}"`), `${html} must carry #${host}`);
  }
  const settings = read("ui/assets/settings.js");
  const panel = read("ui/assets/panel.js");
  // Mounted from the shared factory — never a second password input.
  assert.match(settings, /createApiKeyField\(els\.profileLocalExtra/);
  assert.match(settings, /idPrefix: "pfl-"/);
  assert.match(panel, /createApiKeyField\(root\.querySelector\("#ps-local-extra"\)/);
  assert.match(panel, /idPrefix: "psl-"/);
  // Rendered on open, submitted on save, locked when read-only, re-localized.
  assert.match(settings, /localApiKeyField\.render\(profile\?\.apiKey/);
  assert.match(settings, /body\.apiKey = localApiKeyField\.value\(\)/);
  assert.match(settings, /localApiKeyField\.setReadOnly\(readOnly\)/);
  assert.match(settings, /localApiKeyField\.relocalize\(\)/);
  assert.match(panel, /pluginFormEls\.localApiKey\.render\(profile\?\.apiKey/);
  assert.match(panel, /body\.apiKey = pluginFormEls\.localApiKey\.value\(\)/);
  assert.match(panel, /pluginFormEls\.localApiKey\.setReadOnly\(readOnly\)/);
  // One password-input implementation in the whole UI module.
  const fields = read("ui/assets/profile-fields.js");
  assert.equal((fields.match(/type: "password"/g) || []).length, 1, "the key control must not be duplicated");
  assert.match(fields, /export function createApiKeyField\(/);
});

// The override marker must speak the App's existing colour language: amber is
// already the "attention" state (the panel's starting/error dots, the warn
// button), while green already means "running/selected" on this screen. A second
// green here would make two different states look alike.
test("the override marker reuses the attention amber, never a second green", () => {
  for (const css of ["ui/assets/settings.css", "ui/assets/panel.css"]) {
    const src = read(css);
    const override = src.match(/\.cf-key-source\.is-override\s*\{[^}]*\}/);
    assert.ok(override, `${css} must style the override state`);
    assert.match(override[0], /#8a5a00/, `${css}: the existing amber text tone`);
    assert.doesNotMatch(override[0], /10b981/, `${css}: never the accent green`);
    const dot = src.match(/\.cf-key-dot\s*\{[^}]*\}/);
    assert.ok(dot, `${css} must draw the state dot`);
    assert.match(dot[0], /#d9a441/, `${css}: the same amber the panel's dot uses`);
  }
  // Same value as the panel's existing state dots — one amber vocabulary.
  assert.match(read("ui/assets/panel.css"), /\.dot\.starting\s*\{[^}]*#d9a441/);
});

// ── no docker device vocabulary in the UI ────────────────────────────────

test("the device vocabulary stays out of the interface", () => {
  for (const rel of ["ui/settings.html", "ui/panel.html", "ui/assets/profile-fields.js"]) {
    const src = read(rel);
    assert.doesNotMatch(src, /device_cgroup_rules/, `${rel} must not name device_cgroup_rules`);
    assert.doesNotMatch(src, /\bdevices\b/, `${rel} must not name devices`);
    assert.doesNotMatch(src, /deploy\.resources/, `${rel} must not name deploy.resources`);
    assert.doesNotMatch(src, /\bgpus\b/, `${rel} must not name gpus`);
  }
  // No localized copy leaks the vocabulary either.
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      assert.doesNotMatch(String(value), /device_cgroup_rules|deploy\.resources/, `${lang}.${key} leaks docker vocabulary`);
    }
  }
});

// ── the retired flat keys + the new copy ─────────────────────────────────

test("the retired field.dataDir key is gone and the new keys exist in all six locales", () => {
  for (const lang of LANGS) {
    assert.equal(STRINGS[lang]["field.dataDir"], undefined, `${lang} still carries the orphan field.dataDir`);
  }
  for (const rel of ["ui/settings.html", "ui/panel.html", "ui/assets/settings.js", "ui/assets/panel.js"]) {
    assert.doesNotMatch(read(rel), /field\.dataDir/, `${rel} still references field.dataDir`);
  }

  const newKeys = [
    "field.gpuAmdNote",
    "field.gpuIds",
    "field.modelDir",
    "field.modelsBindDir",
    "field.volumeBinds",
    "field.portBinds",
    "field.enginePort",
    "field.engineBindPort",
    "field.envVars",
    "field.ulimits",
    "field.securityOpt",
    "field.shmSize",
    "field.apiKeyEnv",
    "field.deployDir",
    "field.composeFile",
    "field.composeFileError",
    "field.openDir",
    "field.copyPath",
    "field.openDirFailed",
    "field.listAdd",
    "field.listRemove",
    "field.advanced",
    "field.advancedShow",
    "field.advancedHide",
    "field.advancedSet",
    "field.apiKey",
    "field.apiKeyPlaceholder",
    "field.apiKeyHint",
    "field.apiKeySourceOverride",
    "field.apiKeySourceConfig",
    "field.apiKeySourceGlobal",
    "gpuModel.nvidia",
    "gpuModel.amd-mi50",
    "gpuModel.amd-7900xtx",
    "gpuModel.amd-9060xt",
    "gpuModel.amd-9070xt",
    "gpuModel.amd",
  ];
  for (const lang of LANGS) {
    for (const key of newKeys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
  }
  // The label the "which cards" field explains is only meaningful for NVIDIA.
  for (const lang of LANGS) assert.match(String(STRINGS[lang]["field.gpuAmdNote"]), /AMD/);
});

// ── DeployDir is visible, and its path is resolved server-side ────────────

test("DeployDir is shown, and the compose path is resolved server-side", async () => {
  const src = read("ui/assets/profile-fields.js");
  assert.match(src, /pathField\("deploy-dir"/);
  assert.match(src, /pathField\("model-dir"/);
  assert.match(src, /\$\{p\}deploy-path/);
  // The browser cannot know HOME, so the fallback rule stays on the backend.
  assert.match(src, /api\("profiles\/compose-path"/);

  const routes = read("routes/settings.js");
  assert.match(routes, /app\.post\(\s*["']\/profiles\/compose-path["']/);
  assert.match(routes, /resolveDeployDir\(/);

  const handlers = {};
  const app = { get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } };
  registerSettingsRoutes(app, {});
  assert.equal(typeof handlers["/profiles/compose-path"], "function");

  const call = (body) =>
    handlers["/profiles/compose-path"]({
      req: { json: async () => body },
      json: (data, status) => ({ data, status }),
    });

  const explicit = await call({ containerName: "strata-mi50", DeployDir: "/srv/compose" });
  assert.equal(explicit.data.deployDir, "/srv/compose");
  assert.equal(explicit.data.file, path.join("/srv/compose", "docker-compose.yml"));

  // A changed directory yields a changed file path, under THAT directory — the
  // preview follows the input rather than the container-name fallback.
  const nested = await call({ containerName: "strata-mi50", DeployDir: "/data/strata-docker" });
  assert.equal(nested.data.deployDir, "/data/strata-docker");
  assert.equal(nested.data.file, path.join("/data/strata-docker", "docker-compose.yml"));
  assert.notEqual(nested.data.file, explicit.data.file);

  const fallback = await call({ containerName: "mybox" });
  assert.ok(fallback.data.deployDir.endsWith(path.join(".hanako-localstrata", "mybox")), "empty DeployDir falls back to the stable per-container folder");
  assert.ok(fallback.data.file.endsWith("docker-compose.yml"));
});

// ── running = read-only reaches the new fields ───────────────────────────

test("the running read-only rule reaches every new container field", () => {
  const fields = read("ui/assets/profile-fields.js");
  assert.match(fields, /function setReadOnly\(flag\)/);
  // Only the disclosure is exempt (a view control, no value of its own).
  assert.match(fields, /if \(node\.classList && node\.classList\.contains\("cf-adv-toggle"\)\) continue;/);
  assert.match(fields, /node\.disabled = readOnly;/);
  assert.match(read("ui/assets/settings.js"), /containerFields\.setReadOnly\(readOnly\)/);
  assert.match(read("ui/assets/panel.js"), /pluginFormEls\.container\.setReadOnly\(readOnly\)/);
});

// ── the manifest no longer claims a container /gguf mount ────────────────

test("the manifest description no longer claims a container /gguf mount", () => {
  const manifest = read("manifest.json");
  assert.doesNotMatch(manifest, /mounted at \/gguf/);
  assert.doesNotMatch(manifest, /GGUF_DIR/);
  assert.match(manifest, /container profile carries its own host-model directory/);
});
