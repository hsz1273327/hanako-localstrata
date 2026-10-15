// MI50 community-image preset (lib/mi50.js) + the fields it needs on the
// container model (ShmSize) and the two carriers it must not duplicate
// (lib/gpu.js's device template). Everything here is pure: no docker, no fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MI50_MODEL_KEY,
  MI50_GFX,
  MI50_IMAGE,
  MI50_ENGINE_PORT,
  MI50_WIZARD_PORT,
  isMi50Model,
  mi50HostDirs,
  mi50Preset,
  applyMi50Preset,
  mi50Catalog,
} from "../lib/mi50.js";
import { gpuModelInfo, gpuModelCatalog } from "../lib/gpu.js";
import { normalizeProfile, emptyContainerProfile } from "../lib/profiles.js";
import { containerSpec, renderComposeFile, dedupeMounts } from "../lib/compose.js";
import { readPresets, readMi50Preset } from "../routes/settings.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── detection ─────────────────────────────────────────────────────────────

test("the MI50 is detected by its gfx target, not by a hard-coded key", () => {
  assert.equal(MI50_GFX, "gfx906");
  assert.equal(gpuModelInfo(MI50_MODEL_KEY).gfx, MI50_GFX);
  assert.equal(isMi50Model("amd-mi50"), true);
  // Any model the catalog ever marks gfx906 is an MI50-class card.
  assert.equal(isMi50Model("amd-7900xtx"), false);
  assert.equal(isMi50Model("nvidia"), false);
  assert.equal(isMi50Model(""), false);
  assert.equal(isMi50Model(undefined), false);
  assert.equal(isMi50Model("bogus"), false);
});

// ── the preset patch ──────────────────────────────────────────────────────

test("mi50Preset fills the image, the three mounts, the env and the ports", () => {
  const preset = mi50Preset({ containerName: "strata-mi50", home: "/home/u" });
  assert.equal(preset.imageName, MI50_IMAGE.name);
  assert.equal(preset.imageTag, MI50_IMAGE.tag);
  assert.equal(preset.GpuModel, "amd-mi50");
  assert.equal(preset.EnginePort, MI50_ENGINE_PORT);
  assert.equal(preset.EngineBindPort, MI50_ENGINE_PORT);
  assert.deepEqual(preset.PortBinds, [`${MI50_WIZARD_PORT}:${MI50_WIZARD_PORT}`]);
  assert.deepEqual(preset.VolumeBinds, [
    "/home/u/.hanako-localstrata/strata-mi50/models:/models",
    "/home/u/.hanako-localstrata/strata-mi50/data:/data",
    "/home/u/.hanako-localstrata/strata-mi50/work:/work",
  ]);
  // The env the image's entrypoint reads. Key order is part of the contract.
  assert.deepEqual(preset.environment, [
    "MODELS_DIR=/models",
    "DATA_DIR=/data",
    "CONFIG=/data/config/strata.json",
    `ENGINE_PORT=${MI50_ENGINE_PORT}`,
    `WEB_PORT=${MI50_WIZARD_PORT}`,
  ]);
  assert.deepEqual(preset.ulimits, ["memlock=-1"]);
  assert.deepEqual(preset.security_opt, ["seccomp=unconfined"]);
  assert.equal(preset.ShmSize, "16g");
});

test("the preset never restates the card template's docker vocabulary", () => {
  const preset = mi50Preset({ containerName: "c", home: "/home/u" });
  // devices / cgroup rule / HSA env are the GPU model's job (lib/gpu.js); the
  // preset must not carry them, or they would be duplicated in the compose file.
  assert.ok(!("devices" in preset));
  assert.ok(!("deviceCgroupRules" in preset) && !("device_cgroup_rules" in preset));
  assert.ok(!preset.environment.some((e) => e.startsWith("HSA_OVERRIDE_GFX_VERSION")));
  assert.ok(!preset.environment.some((e) => e.startsWith("LD_LIBRARY_PATH")));
  // ApiKeyEnv is deliberately left for the image's wizard — not set here.
  assert.ok(!("ApiKeyEnv" in preset));
});

test("a non-MI50 model gets no defaults at all", () => {
  assert.equal(mi50Preset({ modelKey: "amd-7900xtx" }), null);
  assert.equal(mi50Preset({ modelKey: "nvidia" }), null);
  const before = { name: "x", type: "container", GpuModel: "nvidia" };
  assert.deepEqual(applyMi50Preset(before, { modelKey: "nvidia" }), before);
});

test("mi50HostDirs falls back to a stable name when the container name is empty", () => {
  const dirs = mi50HostDirs({ containerName: "", home: "/home/u" });
  assert.equal(dirs.models, "/home/u/.hanako-localstrata/strata-mi50/models");
  // Path-unsafe characters are sanitized, like the compose DeployDir segment.
  const odd = mi50HostDirs({ containerName: "a b/c", home: "/home/u" });
  assert.equal(odd.data, "/home/u/.hanako-localstrata/a-b-c/data");
});

test("mi50Catalog is the constant half the page renders the prompt from", () => {
  const cat = mi50Catalog();
  assert.equal(cat.modelKey, "amd-mi50");
  assert.equal(cat.gfx, "gfx906");
  assert.equal(cat.imageName, "xxdoman/strata-mi50");
  assert.equal(cat.imageTag, "0.1.43.1");
  assert.equal(cat.enginePort, 8085);
  assert.equal(cat.wizardPort, 8090);
});

// ── applying it to a real profile ─────────────────────────────────────────

test("an applied preset survives normalization and expands to a correct spec", () => {
  const profile = normalizeProfile(applyMi50Preset({ name: "mi50", type: "container", containerName: "strata-mi50" }, { home: "/home/u" }));
  assert.equal(profile.GpuModel, "amd-mi50");
  assert.equal(profile.image, "xxdoman/strata-mi50:0.1.43.1");
  assert.equal(profile.ShmSize, "16g");
  assert.equal(profile.EnginePort, 8085);

  const spec = containerSpec(profile);
  // The card template supplies the device vocabulary…
  assert.deepEqual(spec.devices, ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"]);
  assert.ok(spec.deviceCgroupRules.includes("c 226:* rmw"));
  // …and the preset supplies the image env; both reaches the merged env.
  assert.ok(spec.environment.includes("HSA_OVERRIDE_GFX_VERSION=9.0.6"));
  assert.ok(spec.environment.includes("LD_LIBRARY_PATH=/opt/rocm/lib"));
  assert.ok(spec.environment.includes("MODELS_DIR=/models"));
  assert.ok(spec.environment.includes("WEB_PORT=8090"));
  assert.equal(spec.shmSize, "16g");
  assert.deepEqual(spec.portBinds, ["8090:8090"]);

  const text = renderComposeFile(spec);
  assert.match(text, /shm_size: "16g"/);
  assert.match(text, /- "8090:8090"/);
  assert.match(text, /- "MODELS_DIR=\/models"/);
  assert.match(text, /- "c 226:\* rmw"/);
  assert.match(text, /- "\/dev\/kfd:\/dev\/kfd"/);
});

// ── the ShmSize field on the container model ──────────────────────────────

test("ShmSize is a normalized container field (empty by default)", () => {
  assert.equal(emptyContainerProfile().ShmSize, "");
  assert.equal(normalizeProfile({ type: "container", imageName: "i", containerName: "c" }).ShmSize, "");
  assert.equal(
    normalizeProfile({ type: "container", imageName: "i", containerName: "c", ShmSize: " 16g " }).ShmSize,
    "16g",
  );
});

// ── mount de-duplication (preset bind vs ModelDir / legacy) ────────────────

test("dedupeMounts drops later mounts that reuse a container target", () => {
  assert.deepEqual(dedupeMounts(["/a:/models", "/b:/models", "/c:/data"]), ["/a:/models", "/c:/data"]);
  // A trailing mode is not a target.
  assert.deepEqual(dedupeMounts(["/a:/data", "/b:/data:ro"]), ["/a:/data"]);
  // Entries with no colon are kept (named/anonymous volumes).
  assert.deepEqual(dedupeMounts(["vol", "vol"]), ["vol", "vol"]);
});

test("a preset /models bind and a ModelDir fallback never collide", () => {
  const profile = normalizeProfile(
    applyMi50Preset(
      { name: "mi50", type: "container", containerName: "strata-mi50", ModelDir: "/srv/models" },
      { home: "/home/u" },
    ),
  );
  const spec = containerSpec(profile);
  // Both name /models; the first (ModelDir) wins and the writer must emit one.
  const text = renderComposeFile(spec);
  assert.equal((text.match(/:\/models"/g) || []).length, 1);
});

test("a legacy-migrated /data mount and the preset bind never collide", () => {
  const profile = normalizeProfile(
    applyMi50Preset(
      { name: "mi50", type: "container", containerName: "strata-mi50", dataDir: "/srv/data" },
      { home: "/home/u" },
    ),
  );
  const text = renderComposeFile(containerSpec(profile));
  assert.equal((text.match(/:\/data"/g) || []).length, 1);
  assert.equal((text.match(/:\/models"/g) || []).length, 1);
  assert.equal((text.match(/:\/work"/g) || []).length, 1);
});

// ── the route payloads ────────────────────────────────────────────────────

test("readPresets exposes the catalog and the MI50 constants", () => {
  const payload = readPresets();
  assert.ok(Array.isArray(payload.models) && payload.models.length > 0);
  assert.ok(payload.models.some((m) => m.key === "amd-mi50" && m.gfx === "gfx906"));
  assert.deepEqual(
    payload.models.map((m) => m.key),
    gpuModelCatalog().map((m) => m.key),
  );
  assert.equal(payload.mi50.modelKey, "amd-mi50");
  assert.equal(payload.mi50.imageName, "xxdoman/strata-mi50");
});

test("readMi50Preset fills host dirs from the requested container name", () => {
  const { preset } = readMi50Preset({ containerName: "my-mi50" });
  assert.ok(preset.VolumeBinds.some((b) => b.includes("my-mi50") && b.endsWith(":/models")));
  assert.equal(preset.GpuModel, "amd-mi50");
  // No container name → the stable fallback, never an empty host side.
  const { preset: bare } = readMi50Preset({});
  assert.ok(bare.VolumeBinds.every((b) => !b.startsWith(":")));
});

// ── API/UI wiring guards ──────────────────────────────────────────────────

test("routes/settings.js registers the preset endpoints", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes/settings.js"), "utf8");
  assert.match(src, /app\.get\(\s*["']\/presets["']/);
  assert.match(src, /app\.post\(\s*["']\/presets\/mi50["']/);
});

test("the settings page carries the model picker and the preset prompt", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  for (const id of ["pf-gpu-model", "pf-preset", "pf-preset-text", "pf-preset-apply", "pf-preset-ignore"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  // The catalog is the detection surface; the preset is applied via the route.
  assert.match(src, /api\(\s*["']presets["']\s*\)/);
  assert.match(src, /api\(\s*["']presets\/mi50["']/);
  assert.match(src, /function\s+renderPresetOffer\s*\(/);
  assert.match(src, /function\s+isMi50Selected\s*\(/);
  // The extra fields the visible form does not own ride along on save.
  assert.match(src, /PRESET_EXTRA_FIELDS/);
  assert.match(src, /pendingPreset/);
  // The picker is disabled in the read-only view.
  assert.match(src, /els\.profileGpuModel\.disabled\s*=\s*readOnly/);
});

test("mi50 i18n keys exist and are non-empty in every locale", () => {
  const keys = [
    "field.gpuModel",
    "field.gpuModelPlaceholder",
    "preset.detected",
    "preset.apply",
    "preset.ignore",
    "preset.applied",
  ];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
    // The prompt names the image it offers.
    assert.match(STRINGS[lang]["preset.detected"], /\{image\}/, `${lang} preset.detected must carry {image}`);
    assert.match(STRINGS[lang]["preset.applied"], /\{image\}/, `${lang} preset.applied must carry {image}`);
  }
});
