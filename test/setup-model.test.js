// Which model a setup run installs: the catalog, the two RAM numbers, the tier,
// and the default. The rules under test are the ones the user asked for:
//
//   32 GB  → the Coder (only), 64 GB → IQ2_XS default, 96 GB+ → IQ3_S default,
//   every size that can run here selectable, the rest listed and greyed WITH the
//   reason.
//
// The two numbers matter (lib/model-tiers.js explains why): FEASIBILITY is judged on
// the RAM the machine can use — setup.py's own `ram_gb()`, i.e. MemTotal — so we can
// never show a size as selectable that setup would call infeasible. The DEFAULT
// follows the NOMINAL capacity (the box was sold as 96 GB, so the 96 GB row of
// docs/MODELS.md applies), because 96 GB of sticks report ~91 GiB and comparing 91
// against the doc's "96" is what left this machine in the 64–96 gap and let setup
// recommend IQ3_XXS over an installed IQ3_S.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FAMILIES,
  MODELS,
  MODEL_ORDER,
  feasibility,
  modelFamilies,
  nominalCapacityGiB,
  parseModelName,
  recommend,
  setupModelPlan,
  tierKey,
  usableRamGiB,
} from "../lib/model-tiers.js";
import { SETUP_PARAMS, initialSetupPlan, validateSetupParams } from "../lib/firstrun.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The one hardware profile this machine has: 91.15 GiB of MemTotal, a 16 GB NVIDIA
// card. Every "the incident" assertion below is that machine.
const HERE = { ramGiB: 91.15, vramGiB: 16, hip: false };
const plan = (hw) => setupModelPlan({ memGiB: hw.ramGiB, vramGiB: hw.vramGiB, hip: !!hw.hip });

test("usable RAM is setup.py's ram_gb(): the same number, from the same source", () => {
  const fromOs = usableRamGiB(os.totalmem());
  assert.ok(Math.abs(fromOs - os.totalmem() / 1024 ** 3) < 1e-9);
  // ram_gb() reads MemTotal (setup.py:423). On Linux that is exactly os.totalmem().
  if (process.platform === "linux" && fs.existsSync("/proc/meminfo")) {
    const kbs = Number((fs.readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s+(\d+)/m) || [])[1]);
    assert.ok(kibs(kbs) > 0);
    assert.ok(Math.abs(fromOs - kibs(kbs)) < 0.02, "our number and setup's must be the same number");
  }
  function kibs(kb) {
    return (kb * 1024) / 1024 ** 3;
  }
});

test("the tier comes from the capacity the box was SOLD AS, not from MemTotal", () => {
  // 96 GB of sticks → ~91 GiB of MemTotal (firmware + iGPU carve-out). Rounding up
  // is what keeps that out of the 64–96 gap.
  assert.equal(nominalCapacityGiB(91.15), 96);
  assert.equal(tierKey(91.15), "96");
  // A real 64 GB machine reports 61–63 GiB: it must stay 64, not climb to 96.
  for (const mem of [61.2, 62.4, 63.8]) {
    assert.equal(nominalCapacityGiB(mem), 64);
    assert.equal(tierKey(mem), "64");
  }
  // 128 / 192 GB machines must not be misread either.
  assert.equal(tierKey(123.0), "96");
  assert.equal(tierKey(185.0), "96");
  assert.equal(nominalCapacityGiB(123.0), 128);
  assert.equal(nominalCapacityGiB(185.0), 192);
  // 47 GiB is the README's own AMD machine ("47 GB RAM" = 48 GB of sticks).
  assert.equal(nominalCapacityGiB(46.9), 48);
  assert.equal(tierKey(46.9), "48");
  assert.equal(tierKey(31.5), "32");
  assert.equal(tierKey(23.4), "below");
  assert.equal(nominalCapacityGiB(15.2), 16);
});

test("the incident cannot repeat: this machine is offered IQ3_S, not IQ3_XXS", () => {
  const p = plan(HERE);
  assert.equal(p.ram.tier, "96");
  assert.equal(p.ram.usableGiB, 91.2);
  assert.equal(p.ram.nominalGiB, 96);
  assert.equal(p.recommended.model, "IQ3_S");
  assert.equal(p.recommended.source, "tier", "the tier's own pick, not a fallback");
  assert.equal(p.recommended.family, "qwen");
  const rec = p.models.find((m) => m.model === "IQ3_S" && m.family === "qwen");
  assert.equal(rec.recommended, true);
  assert.equal(rec.ok, true);
});

test("the user's three tiers behave as specified", () => {
  // 32 GB, an ordinary card: the Coder is the only size that fits.
  const small32 = plan({ ramGiB: 31.5, vramGiB: 8 });
  assert.deepEqual(small32.models.filter((m) => m.ok).map((m) => `${m.family}/${m.model}`), ["coder/IQ1_M"]);
  assert.equal(small32.recommended.model, "IQ1_M");

  // 64 GB: IQ2_XS default, with IQ3_XXS and IQ3_S selectable.
  const at64 = plan({ ramGiB: 62.4, vramGiB: 16 });
  assert.equal(at64.recommended.model, "IQ2_XS");
  for (const m of ["IQ2_XS", "IQ3_XXS", "IQ3_S"]) {
    assert.ok(at64.models.some((x) => x.model === m && x.ok), `${m} must be selectable on 64 GB`);
  }

  // 96 GB+: IQ3_S default, and everything that runs stays selectable.
  for (const mem of [91.15, 123.0, 185.0]) {
    const p = plan({ ramGiB: mem, vramGiB: 16 });
    assert.equal(p.recommended.model, "IQ3_S", `${mem} GiB must default to IQ3_S`);
    assert.ok(p.models.filter((m) => m.ok).length >= 6, "the feasible sizes are all offered");
  }
});

test("feasibility mirrors setup's own conditions (so the UI never contradicts it)", () => {
  // The plain path: setup.py:4978 `ram >= MODELS[m]["ram_gb"]`.
  assert.deepEqual(feasibility("IQ3_S", { ramGiB: 91.15 }), { ok: true, reason: "fits" });
  assert.deepEqual(feasibility("IQ3_S", { ramGiB: 61.0 }), { ok: false, reason: "needsRam" });
  // The low-RAM path (setup.py:3267/3295): too big for the RAM, but the card's VRAM
  // makes the rest fit. 32 GB + a 24 GB card is the docs' own example.
  assert.deepEqual(feasibility("Q2_0", { ramGiB: 31.5, vramGiB: 24 }), { ok: true, reason: "lowRam" });
  assert.deepEqual(feasibility("Q2_0", { ramGiB: 31.5, vramGiB: 8 }), { ok: false, reason: "needsRam" });
  // A budget size (Unsloth's) has no low-RAM variant at all (setup.py:4990).
  assert.deepEqual(feasibility("UD-IQ4_XS", { ramGiB: 31.5, vramGiB: 24 }), { ok: false, reason: "needsRam" });
  // An NVIDIA-only size on an AMD card.
  assert.deepEqual(feasibility("UD-Q4_K_XL", { ramGiB: 91.15, hip: true }), { ok: false, reason: "nvidiaOnly" });
  assert.ok(feasibility("UD-Q4_K_XL", { ramGiB: 91.15 }).ok);
  assert.equal(feasibility("NOPE", { ramGiB: 91.15 }).reason, "unknown");
});

test("a box that fits nothing full is not handed the Coder from a fallback", () => {
  // 48 GB: nothing full fits outright, so the low-RAM size that strains the RAM
  // least is offered — the Coder is a code model and is never the general answer.
  const at48 = recommend({ ramGiB: 46.9, vramGiB: 16 });
  assert.equal(at48.source, "lowRam");
  assert.notEqual(at48.model, "IQ1_M");
  // And with nothing at all feasible, no size is recommended instead of a bad one.
  assert.equal(recommend({ ramGiB: 12, vramGiB: 4 }).model, null);
});

test("the catalog is setup's: families, sizes, and the family a size belongs to", () => {
  assert.deepEqual(MODEL_ORDER, ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S", "IQ1_M", "UD-Q4_K_XL", "UD-IQ4_XS"]);
  assert.deepEqual(FAMILIES.map((f) => f.key), ["qwen", "swift", "coder", "unsloth"]);
  // setup.py defaults `families` to ("qwen", "swift").
  assert.deepEqual(modelFamilies("IQ2_XS"), ["qwen", "swift"]);
  assert.deepEqual(modelFamilies("IQ3_S"), ["qwen"]);
  assert.deepEqual(modelFamilies("Q2_0"), ["qwen"]);
  assert.deepEqual(modelFamilies("IQ1_M"), ["coder"]);
  // The RAM figures are setup's (setup.py's MODELS): the numbers a run is judged on.
  assert.deepEqual(
    Object.fromEntries(MODEL_ORDER.map((m) => [m, MODELS[m].ramGiB])),
    { Q2_0: 48, IQ2_XS: 48, IQ3_XXS: 60, IQ3_S: 62, IQ1_M: 32, "UD-Q4_K_XL": 48, "UD-IQ4_XS": 48 },
  );
});

test("the current config's model_name is parsed back into (family, size)", () => {
  // setup.py:5454 writes `<family name>-<model lowercased>`, no tag.
  assert.deepEqual(parseModelName("qwen3.8-flash-next-iq2_xs"), { family: "qwen", model: "IQ2_XS" });
  assert.deepEqual(parseModelName("qwen3.8-flash-next-q2_0"), { family: "qwen", model: "Q2_0" });
  assert.deepEqual(parseModelName("swift-1.5-iq2_xs"), { family: "swift", model: "IQ2_XS" });
  // The Coder / Unsloth names start with the plain family's name: the longest match
  // has to win.
  assert.deepEqual(parseModelName("qwen3.8-flash-next-coder-iq1_m"), { family: "coder", model: "IQ1_M" });
  assert.deepEqual(parseModelName("qwen3.8-flash-next-unsloth-ud-iq4_xs"), { family: "unsloth", model: "UD-IQ4_XS" });
  // A size outside the family it claims is not a match; nor is junk.
  assert.equal(parseModelName("swift-1.5-q2_0"), null, "Q2_0 ships in qwen only");
  assert.equal(parseModelName(""), null);
  assert.equal(parseModelName("llama-3-8b"), null);
});

test("the size travels to setup as its own flags, paired and validated", () => {
  assert.equal(SETUP_PARAMS.family.flag, "--family");
  assert.equal(SETUP_PARAMS.model.flag, "--model");
  assert.deepEqual(SETUP_PARAMS.model.values, MODEL_ORDER);
  assert.deepEqual(SETUP_PARAMS.family.values, FAMILIES.map((f) => f.key));

  const good = validateSetupParams({ family: "qwen", model: "IQ3_S" });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.clean, { family: "qwen", model: "IQ3_S" });
  // `--model` alone is what a single-family size needs: setup's own family menu then
  // decides (setup.py:4962).
  assert.deepEqual(validateSetupParams({ model: "IQ3_XXS" }).clean, { model: "IQ3_XXS" });
  // `--family` alone names a release without a size: refused.
  assert.match(validateSetupParams({ family: "swift" }).errors.join(), /family/);
  // A size that is not in that release: refused, not silently swapped.
  assert.match(validateSetupParams({ family: "swift", model: "IQ3_S" }).errors.join(), /IQ3_S/);
  // Unknown sizes/keys stay refused.
  assert.match(validateSetupParams({ model: "IQ9_Z" }).errors.join(), /model/);
  assert.match(validateSetupParams({ models: "IQ3_S" }).errors.join(), /models/);

  // The plan echoes exactly what will be handed over, and builds the command from
  // the same set (lib/firstrun.js:378 loops SETUP_PARAMS).
  const p = initialSetupPlan({ state: "stopped" }, { strataDir: "/tmp" }, { setup: { family: "qwen", model: "IQ3_S" } });
  assert.deepEqual(p.setup, { family: "qwen", model: "IQ3_S" });
  assert.deepEqual(p.setupErrors, []);
});

test("the dialog's plan: a recommendation, a current entry, and every size with a verdict", () => {
  const p = setupModelPlan({ memGiB: 91.15, vramGiB: 16, currentName: "qwen3.8-flash-next-iq2_xs" });
  assert.deepEqual(p.current, { family: "qwen", model: "IQ2_XS" });
  assert.ok(p.models.length >= 7, "one entry per (release, size) pair");
  for (const m of p.models) {
    assert.equal(typeof m.familyTitle, "string");
    assert.equal(typeof m.ok, "boolean");
    assert.ok(MODELS[m.model], `${m.model} is a real size`);
  }
  // Two releases ship IQ2_XS: both are listed, and the family title is what tells
  // them apart in the picker.
  const iq2 = p.models.filter((m) => m.model === "IQ2_XS");
  assert.deepEqual(iq2.map((m) => m.family), ["qwen", "swift"]);
  // A greyed entry always carries a reason the UI can put in words.
  for (const m of p.models.filter((x) => !x.ok)) {
    assert.ok(["needsRam", "nvidiaOnly"].includes(m.reason), `${m.model}: ${m.reason}`);
  }
});

test("(a) the dialog loads the current values BEFORE it fills them", () => {
  const js = read("ui/assets/panel.js");
  // One loader for the profile payload, used by the drawer AND the setup dialog.
  assert.match(js, /async function loadProfileFacts\(\)/, "the loader exists");
  assert.match(js, /visionInfo = profileData\?\.vision/, "the payload is read from an OUTER binding");
  assert.doesNotMatch(js, /const data = await api\("profiles"\)/, "not from a try-scoped const (that was a ReferenceError)");
  // The drawer and the dialog both go through it; the dialog waits for it.
  const drawer = js.slice(js.indexOf("async function openDrawer"), js.indexOf("async function openDrawer") + 600);
  assert.match(drawer, /await loadProfileFacts\(\)/);
  const handler = js.slice(js.indexOf('els.configSetupBtn.addEventListener("click"'), js.indexOf('els.configSetupBtn.addEventListener("click"') + 1200);
  assert.match(handler, /await loadProfileFacts\(\)/, "the dialog must load the current vision value first");
  assert.match(handler, /api\("config\/setup-plan"\)/, "and the machine's plan");
  // Filled from the loaded facts, and the size is preselected from the plan.
  assert.match(js, /function renderSetupModel\(plan\)/);
  assert.match(js, /sel\.value = rec \? `\$\{rec\.family\}\|\$\{rec\.model\}` : ""/);
  // "Let setup decide" is never the default of the size control.
  assert.doesNotMatch(js, /sel\.value = ""\s*;\s*\/\/ default/, "no accidental 'setup decides' default");
});

test("the copy says what the buttons do, and the old '由 setup 决定' illusion is gone", () => {
  const i18n = read("ui/assets/i18n.js");
  const keys = [
    "configPick.modelLabel",
    "configPick.modelHint",
    "configPick.modelLetSetup",
    "configPick.modelKeepCurrent",
    "configPick.modelRecommended",
    "configPick.modelNeedsRam",
    "configPick.modelNvidiaOnly",
    "configPick.modelExperimental",
    "configPick.modelRamLine",
  ];
  for (const k of keys) {
    assert.equal([...i18n.matchAll(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g"))].length, 6, `${k} × 6 languages`);
  }
  // "— 由 setup 决定 —" read as "keep the current value" and was not one. The option
  // now says it re-decides.
  const zh = [...i18n.matchAll(/"configPick\.setupDecide": "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(zh.length, 6);
  assert.ok(zh[0].includes("重新决定"), `zh copy must say it re-decides: ${zh[0]}`);
  for (const copy of zh) assert.doesNotMatch(copy, /^(— )?(由 setup 决定|setup decides|setup décide|решает setup|setup が決める|setup이 결정)( —)?$/, "the old wording must be gone");
  // The RAM line names both numbers, so the tier is never a mystery.
  const ram = i18n.match(/"configPick\.modelRamLine": "([^"]+)"/);
  assert.match(ram[1], /\{usable\}/);
  assert.match(ram[1], /\{nominal\}/);
});
