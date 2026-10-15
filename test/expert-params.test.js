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
// "the engine's default" looks like (`--low-ram auto`, or a budget on a model
// whose experts fit). `arg-add` closes that gap; `arg` keeps its old strictness.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTextEdit, renderConfigEdits, validateEdits, flatConfig, EDIT_KEYS, LOW_RAM_VALUES } from "../lib/deployer/common.js";

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
  const next = applyTextEdit(text, { type: "arg-add", key: "--low-ram", value: "on" });
  assert.deepEqual(argsOf(next), ["--pack", "/p", "--spec", "4", "--low-ram", "on"]);
  // …and setting it again rewrites rather than appending a second pair.
  const twice = applyTextEdit(next, { type: "arg-add", key: "--low-ram", value: "off" });
  assert.deepEqual(argsOf(twice), ["--pack", "/p", "--spec", "4", "--low-ram", "off"]);
});

test("a `]` inside a path does not close the args array early", () => {
  const text = configText(["--pack", "/weird]dir/pack", "--native", "/m/a.gguf"]);
  const next = applyTextEdit(text, { type: "arg-add", key: "--resident-budget-gib", value: "48" });
  const args = argsOf(next);
  assert.ok(args.includes("/weird]dir/pack"), "the path survives");
  assert.deepEqual(args.slice(-2), ["--resident-budget-gib", "48"]);
});

test("an empty args array is filled without a leading comma", () => {
  const next = applyTextEdit(configText([]), { type: "arg-add", key: "--low-ram", value: "off" });
  assert.deepEqual(argsOf(next), ["--low-ram", "off"]);
});

test("the strict `arg` op still refuses a flag that is not there (no regression)", () => {
  const text = configText(["--spec", "4"]);
  assert.throws(() => applyTextEdit(text, { type: "arg", key: "--low-ram", value: "on" }), /配置中找不到参数/);
});

// ── validation ───────────────────────────────────────────────────────────

test("the three knobs validate their value domains", () => {
  for (const value of LOW_RAM_VALUES) {
    assert.deepEqual(validateEdits({ lowRam: value }).errors, [], `${value} must be accepted`);
  }
  assert.match(validateEdits({ lowRam: "maybe" }).errors.join(), /低内存模式/);
  assert.deepEqual(validateEdits({ expertCache: "auto" }).errors, []);
  assert.deepEqual(validateEdits({ expertCache: "9000" }).errors, []);
  assert.match(validateEdits({ expertCache: "lots" }).errors.join(), /专家缓存/);
  assert.deepEqual(validateEdits({ residentBudget: 48 }).errors, []);
  assert.match(validateEdits({ residentBudget: 0 }).errors.join(), /常驻专家量/);
  assert.match(validateEdits({ residentBudget: -1 }).errors.join(), /常驻专家量/);
  // The three are known keys (not "未知字段") and all need a restart.
  for (const key of ["expertCache", "residentBudget", "lowRam"]) {
    assert.ok(EDIT_KEYS[key], `${key} must be an edit key`);
    assert.equal(EDIT_KEYS[key].restart, true, `${key} takes effect on the next start`);
  }
});

// ── the writer's map: key → engine flag ──────────────────────────────────

test("an edit set reaches the args of the written config", () => {
  const mainText = configText(["--pack", "/p", "--expert-cache", "auto"]);
  const result = renderConfigEdits({
    clean: { expertCache: "9000", residentBudget: 48, lowRam: "on" },
    before: { expertCache: "auto" },
    mainText,
    sharedText: "{}",
  });
  const args = argsOf(result.newMainText);
  assert.deepEqual(args.slice(2), ["--expert-cache", "9000", "--resident-budget-gib", "48", "--low-ram", "on"]);
  assert.equal(result.restartRequired, true, "they are args: a restart applies them");
  assert.deepEqual(result.diff.map((d) => d.key).sort(), ["expertCache", "lowRam", "residentBudget"]);
});

test("flatConfig reports what the config carries (absent = the engine's default)", () => {
  const withFlags = flatConfig(JSON.parse(configText(["--expert-cache", "9000", "--low-ram", "mmap"])), {});
  assert.equal(withFlags.expertCache, "9000");
  assert.equal(withFlags.lowRam, "mmap");
  const without = flatConfig(JSON.parse(configText(["--spec", "4"])), {});
  assert.equal(without.expertCache, undefined);
  assert.equal(without.lowRam, undefined);
  assert.equal(without.residentBudget, undefined);
});

// ── the form ─────────────────────────────────────────────────────────────

test("the parameter editor carries the three fields in their own group", () => {
  const html = read("ui/panel.html");
  for (const id of ["ed-expertCache", "ed-residentBudget", "ed-lowRam"]) {
    assert.match(html, new RegExp(`id="${id}" data-key=`), `panel.html must carry #${id}`);
  }
  assert.match(html, /data-i18n="edit\.expertsLegend"/);
  // The select offers the engine's five values plus the "leave it alone" blank.
  const select = html.slice(html.indexOf('id="ed-lowRam"'), html.indexOf("</select>", html.indexOf('id="ed-lowRam"')));
  for (const value of LOW_RAM_VALUES) assert.match(select, new RegExp(`value="${value}"`), `low-ram option ${value}`);
  assert.match(select, /value=""/);
  // The diff list labels them.
  const js = read("ui/assets/panel.js");
  for (const key of ["expertCache", "residentBudget", "lowRam"]) {
    assert.match(js, new RegExp(`${key}: "edit\\.`), `panel.js must label ${key}`);
  }
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
  const keys = ["edit.expertsLegend", "edit.expertCache", "edit.expertCachePlaceholder", "edit.expertCacheHint", "edit.residentBudget", "edit.residentBudgetHint", "edit.lowRam", "edit.lowRamUnset", "edit.lowRamHint"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // The low-RAM hint must spell out the pack/experts.bin meaning of `on`.
    assert.match(STRINGS[lang]["edit.lowRamHint"], /experts\.bin|pack/i, `${lang}.edit.lowRamHint must explain on`);
    // And the env hint must name the image's two expert envs.
    assert.match(STRINGS[lang]["field.envVarsHint"], /LOW_RAM/, `${lang}.field.envVarsHint must name LOW_RAM`);
    assert.match(STRINGS[lang]["field.envVarsHint"], /RESIDENT_BUDGET_GIB/, `${lang}.field.envVarsHint must name RESIDENT_BUDGET_GIB`);
  }
});
