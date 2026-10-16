// 表一 (ui/assets/setup-facts.js): the row values, and the two tiers of 视觉.
//
// 视觉 is not one switch. Whether images are read at all is THIS config's choice
// (`--vision no` vs `yes|cpu|gpu`), while CPU-vs-GPU is a BUILD property: setup
// compiles a different `strata-vision` for the two (setup.py:3229), so it only
// changes on a setup re-run. The row says both, and the hint keeps them apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visionText, lowRamModeText, kvStreamingText, SETUP_FACT_ROWS } from "../ui/assets/setup-facts.js";
import { STRINGS, LANGS, t } from "../ui/assets/i18n.js";

test("the rows cover what setup decided, with 视觉 among them", () => {
  assert.deepEqual(
    SETUP_FACT_ROWS.map((r) => r.key),
    ["model", "vision", "backend", "gpu", "lowRam", "kvStreaming"],
  );
  // Every row names its copy, and each row's value element has a stable id (the
  // shared module is what both pages mount).
  for (const row of SETUP_FACT_ROWS) {
    assert.ok(row.label && row.value, `${row.key} needs a label and a value id`);
    assert.equal(typeof STRINGS.zh[row.label], "string", `${row.label} must exist`);
    if (row.hint) assert.equal(typeof STRINGS.zh[row.hint], "string", `${row.hint} must exist`);
  }
});

test("视觉 reads both tiers: on/off, and which encoder", () => {
  // No block, or an empty one: nothing to run, so the config does not read images.
  assert.equal(visionText(null), t("vision.off"));
  assert.equal(visionText(undefined), t("vision.off"));
  assert.equal(visionText({ available: false, encoder: "", mmproj: "" }), t("vision.off"));
  // On, with the build property named.
  const gpu = visionText({ available: true, encoder: "gpu", mmproj: "mmproj-x.gguf" });
  assert.ok(gpu.startsWith(t("vision.on")), `the row leads with the on state (got ${gpu})`);
  assert.ok(gpu.includes(t("vision.encoderGpu")), "the GPU encoder is named");
  assert.ok(gpu.includes("mmproj-x.gguf"), "and the file it loads");
  const cpu = visionText({ available: true, encoder: "cpu", mmproj: "" });
  assert.ok(cpu.startsWith(t("vision.on")));
  assert.ok(cpu.includes(t("vision.encoderCpu")), "the CPU encoder is named");
  assert.ok(!cpu.includes("undefined"), "an unknown encoder is simply not named");
});

test("the low-RAM mode and the KV stream switch map to their copy", () => {
  assert.equal(lowRamModeText("resident"), t("edit.lowRamModeResident"));
  assert.equal(lowRamModeText("mmap"), t("edit.lowRamModeMmap"));
  // Absent (or anything unexpected) is setup's `auto` — the normal path.
  assert.equal(lowRamModeText(undefined), t("edit.lowRamModeAuto"));
  assert.equal(lowRamModeText("auto"), t("edit.lowRamModeAuto"));

  // KV streaming: the PRESENCE of `--kv-resident` is the switch, its value is the
  // attended window setup wrote.
  assert.equal(kvStreamingText({}), t("edit.kvStreamOff"));
  assert.equal(kvStreamingText({ kvResident: null }), t("edit.kvStreamOff"));
  assert.equal(kvStreamingText(undefined), t("edit.kvStreamOff"));
  assert.match(kvStreamingText({ kvResident: 32768 }), /32768/);
});

test("表一's copy exists in all six locales", () => {
  const keys = [
    "setupFacts.title",
    "setupFacts.model",
    "setupFacts.backend",
    "setupFacts.gpu",
    "setupFacts.visionHint",
    "edit.lowRam",
    "edit.kvStream",
    "edit.lowRamHint",
    "edit.kvStreamHint",
  ];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // Both tiers have to be readable in the hint: the config's own choice, and the
    // build property that only a re-run changes.
    assert.match(STRINGS[lang]["setupFacts.visionHint"], /no/i, `${lang}: the config's choice`);
    assert.match(STRINGS[lang]["setupFacts.visionHint"], /setup/i, `${lang}: the lever`);
    assert.match(STRINGS[lang]["edit.lowRamHint"], /setup/i, `${lang}: the lever`);
    assert.match(STRINGS[lang]["edit.kvStreamHint"], /setup/i, `${lang}: the lever`);
  }
});
