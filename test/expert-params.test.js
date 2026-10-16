// The expert-memory knobs: what they are, and the writer change they needed.
//
// The engine holds a model's experts in three places — a VRAM budget
// (`--expert-cache`: `auto` or a slot count, docs/DETAILS.md "the expert cache
// size is a budget"), a RAM budget for the rest (`--resident-budget-gib`, for
// models whose experts do not all fit), and the low-RAM reading mode
// (`--low-ram auto|on|off|resident|mmap`, setup.py:4650). All three are engine
// args, so they take effect on the next start.
//
// The writer could only REWRITE a flag that was already in `args` and threw
// otherwise — which is not enough here, because an ABSENT flag is exactly what
// "the engine's default" looks like (a budget on a model whose experts fit, or a
// config with no expert cache at all). `arg-add` closes that gap; `arg` keeps its
// old strictness.
//
// The low-RAM MODE is deliberately not a field: setup translates its own
// `--low-ram` into `--resident-experts` / `--mmap-experts` when it generates the
// config (setup.py:5364), and the engine has no `--low-ram` — so the mode is read
// out of the args and reported (see lowRamModeOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTextEdit, renderConfigEdits, validateEdits, flatConfig, EDIT_KEYS, LOW_RAM_MODE_FLAGS, lowRamModeOf } from "../lib/deployer/common.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const configText = (args) => JSON.stringify({ exe: "strata", args, port: 8080, host: "127.0.0.1" }, null, 2);
const argsOf = (text) => JSON.parse(text).args;

// ── the writer: rewrite when present, add when absent ────────────────────

test("an existing flag is rewritten, never duplicated", () => {
  const text = configText(["--expert-cache", "auto", "--spec", "4"]);
  const next = applyTextEdit(text, { type: "arg-add", key: "--expert-cache", value: "9000" });
  assert.deepEqual(argsOf(next), ["--expert-cache", "9000", "--spec", "4"]);
});

test("a missing flag is added — that is what \"the engine's default\" looks like", () => {
  const text = configText(["--pack", "/p", "--spec", "4"]);
  const next = applyTextEdit(text, { type: "arg-add", key: "--resident-experts", value: "on" });
  assert.deepEqual(argsOf(next), ["--pack", "/p", "--spec", "4", "--resident-experts", "on"]);
  // …and setting it again rewrites rather than appending a second pair.
  const twice = applyTextEdit(next, { type: "arg-add", key: "--resident-experts", value: "off" });
  assert.deepEqual(argsOf(twice), ["--pack", "/p", "--spec", "4", "--resident-experts", "off"]);
});

test("a `]` inside a path does not close the args array early", () => {
  const text = configText(["--pack", "/weird]dir/pack", "--native", "/m/a.gguf"]);
  const next = applyTextEdit(text, { type: "arg-add", key: "--resident-budget-gib", value: "48" });
  const args = argsOf(next);
  assert.ok(args.includes("/weird]dir/pack"), "the path survives");
  assert.deepEqual(args.slice(-2), ["--resident-budget-gib", "48"]);
});

test("an empty args array is filled without a leading comma", () => {
  const next = applyTextEdit(configText([]), { type: "arg-add", key: "--resident-experts", value: "on" });
  assert.deepEqual(argsOf(next), ["--resident-experts", "on"]);
});

test("the strict `arg` op still refuses a flag that is not there (no regression)", () => {
  const text = configText(["--spec", "4"]);
  assert.throws(() => applyTextEdit(text, { type: "arg", key: "--resident-experts", value: "on" }), /配置中找不到参数/);
});

// ── validation ───────────────────────────────────────────────────────────

test("the three knobs validate their value domains", () => {
  assert.deepEqual(validateEdits({ expertCache: "auto" }).errors, []);
  assert.deepEqual(validateEdits({ expertCache: "9000" }).errors, []);
  assert.match(validateEdits({ expertCache: "lots" }).errors.join(), /专家缓存/);
  assert.deepEqual(validateEdits({ residentBudget: 48 }).errors, []);
  assert.match(validateEdits({ residentBudget: 0 }).errors.join(), /常驻专家量/);
  assert.match(validateEdits({ residentBudget: -1 }).errors.join(), /常驻专家量/);
  // `lowRam` and `port` are NOT editable: `--low-ram` is setup's flag (the config
  // carries `--resident-experts` / `--mmap-experts`, setup.py:5364), and the
  // config's `port` loses to the profile's own port field (resolvePort).
  for (const key of ["lowRam", "port"]) {
    assert.equal(EDIT_KEYS[key], undefined, `${key} must not be an edit key`);
    assert.match(validateEdits({ [key]: "1" }).errors.join(), /未知字段/, `${key} must be refused`);
  }
  for (const key of ["expertCache", "residentBudget"]) {
    assert.ok(EDIT_KEYS[key], `${key} must be an edit key`);
    assert.equal(EDIT_KEYS[key].restart, true, `${key} takes effect on the next start`);
  }
});

test("the low-RAM mode is read out of the args setup writes, never written", () => {
  // setup TRANSLATES its own `--low-ram` into the pair the engine knows; a config
  // with `--low-ram` in it would be handing the engine a flag it has no help for.
  assert.deepEqual(LOW_RAM_MODE_FLAGS, ["--resident-experts", "--mmap-experts"]);
  assert.equal(lowRamModeOf(["--pack", "/p"]), "auto", "neither flag = setup's auto");
  assert.equal(lowRamModeOf(["--mmap-experts"]), "mmap");
  assert.equal(lowRamModeOf(["--mmap-experts", "--resident-experts"]), "resident", "resident is the stronger mode");
  assert.equal(flatConfig(JSON.parse(configText(["--mmap-experts"])), {}).lowRamMode, "mmap");
  assert.equal(flatConfig(JSON.parse(configText(["--spec", "4"])), {}).lowRamMode, "auto");
});

// ── the writer's map: key → engine flag ──────────────────────────────────

test("an edit set reaches the args of the written config", () => {
  const mainText = configText(["--pack", "/p", "--expert-cache", "auto"]);
  const result = renderConfigEdits({
    clean: { expertCache: "9000", residentBudget: 48 },
    before: { expertCache: "auto" },
    mainText,
    sharedText: "{}",
  });
  const args = argsOf(result.newMainText);
  assert.deepEqual(args.slice(2), ["--expert-cache", "9000", "--resident-budget-gib", "48"]);
  assert.equal(result.restartRequired, true, "they are args: a restart applies them");
  assert.deepEqual(result.diff.map((d) => d.key).sort(), ["expertCache", "residentBudget"]);
});

test("flatConfig reports what the config carries (absent = the engine's default)", () => {
  const withFlags = flatConfig(JSON.parse(configText(["--expert-cache", "9000", "--mmap-experts"])), {});
  assert.equal(withFlags.expertCache, "9000");
  assert.equal(withFlags.lowRamMode, "mmap");
  const without = flatConfig(JSON.parse(configText(["--spec", "4"])), {});
  assert.equal(without.expertCache, undefined);
  assert.equal(without.residentBudget, undefined);
  assert.equal(without.lowRamMode, "auto");
});

// ── the form ─────────────────────────────────────────────────────────────

test("the parameter editor carries the fields, and the reports moved to 表一", () => {
  const html = read("ui/panel.html");
  for (const id of ["ed-expertCache", "ed-residentBudget"]) {
    assert.match(html, new RegExp(`id="${id}" data-key=`), `panel.html must carry #${id}`);
  }
  // The low-RAM mode is a REPORT, and reports now live in the setup-facts table
  // (built from SETUP_FACT_ROWS at runtime), not inside the params groups.
  assert.match(html, /id="setupFactsBox"/, "the setup-facts table exists");
  const js = read("ui/assets/panel.js");
  assert.match(js, /\{ label: "edit\.lowRam", value: "edit-lowRamMode"/, "the mode is a row of that table");
  assert.doesNotMatch(html, /id="ed-lowRam"/, "the old select is gone");
  assert.doesNotMatch(html, /data-key="lowRam"/, "and nothing writes the mode");
  const form = html.match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(form, /data-key="port"/, "nor the config port");
  // The diff list labels what is left.
  for (const key of ["expertCache", "residentBudget"]) {
    assert.match(js, new RegExp(`${key}: "edit\\.`), `panel.js must label ${key}`);
  }
  assert.match(js, /lowRamMode: "edit\.lowRam"/, "and name the report row");
  assert.match(js, /function renderLowRamMode/, "which the panel must drive");
});

test("the container side tells the user those envs exist instead of adding fields", () => {
  // The image's counterparts are setup INPUTS (`REINSTALL=1` to re-run), and the
  // container profile already has a free-form environment list — so the honest
  // move is to name them there, not to invent a second field per flag.
  const hints = read("ui/assets/i18n.js");
  const names = ["LOW_RAM", "RESIDENT_BUDGET_GIB", "KV_STREAMING"];
  for (const name of names) {
    assert.ok(hints.includes(name), `the env hint must name ${name}`);
  }
  // …and no container field was added for them.
  const profiles = read("lib/profiles.js");
  assert.doesNotMatch(profiles, /ResidentBudget|LowRam|residentBudget|lowRam/, "no new container fields");
});

test("the new copy exists in all six locales", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const keys = ["edit.expertsLegend", "edit.expertCache", "edit.expertCachePlaceholder", "edit.expertCacheHint", "edit.residentBudget", "edit.residentBudgetHint", "edit.lowRam", "edit.lowRamHint", "edit.lowRamModeResident", "edit.lowRamModeMmap", "edit.lowRamModeAuto"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // The low-RAM hint must spell out the two flags setup writes.
    assert.match(STRINGS[lang]["edit.lowRamHint"], /resident-experts/, `${lang}.edit.lowRamHint must name the resident flag`);
    assert.match(STRINGS[lang]["edit.lowRamHint"], /mmap-experts/, `${lang}.edit.lowRamHint must name the mmap flag`);
    // And the env hint must name the image's two expert envs.
    assert.match(STRINGS[lang]["field.envVarsHint"], /LOW_RAM/, `${lang}.field.envVarsHint must name LOW_RAM`);
    assert.match(STRINGS[lang]["field.envVarsHint"], /RESIDENT_BUDGET_GIB/, `${lang}.field.envVarsHint must name RESIDENT_BUDGET_GIB`);
  }
});
