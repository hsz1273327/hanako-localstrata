// The one editable value that is a TOP-LEVEL config key, not an engine arg: `parallel`.
//
// Every other value op matches `"key": …` anywhere in the file. That is fine for names
// that can only occur once (`port`) and unsafe for a word like `parallel`, which a
// config could also carry inside a nested block. `setTopLevelValue` therefore:
//   * refuses when the key appears more than once (nothing to disambiguate by);
//   * rewrites the existing member in place, or inserts a missing one at the END of the
//     root object in the file's own indentation;
//   * deletes the member for `value === undefined` — that is how the field goes back to
//     "the engine's default" (1), because an absent key IS the default;
//   * and after each edit parses the result, checks the key's value and checks that the
//     other top-level keys are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EDIT_KEYS,
  flatConfig,
  parseJsonText,
  renderConfigEdits,
  setTopLevelValue,
  validateEdits,
} from "../lib/deployer/common.js";

// The shape setup.py writes: one-space indentation, args first.
const fixture = (mutate = (o) => o) =>
  JSON.stringify(
    mutate({
      exe: "/opt/strata/engine/strata",
      args: ["--pack", "/p", "--native", "/m/a.gguf", "--max-context", "262144"],
      cwd: "/opt/strata",
      model_name: "qwen3.8-flash-next-iq3_s",
      sampling: { temperature: 0.7, top_p: 0.9 },
      port: 8080,
    }),
    null,
    1,
  );

test("inserting a missing key puts it at the end of the root object, in the file's indent", () => {
  const text = fixture();
  const next = setTopLevelValue(text, "parallel", 2);
  const parsed = parseJsonText(next);
  assert.equal(parsed.parallel, 2);
  // Everything else is untouched, byte for byte around the inserted line.
  assert.deepEqual(Object.keys(parsed), [...Object.keys(parseJsonText(text)), "parallel"]);
  assert.equal(parsed.args.length, parseJsonText(text).args.length);
  assert.deepEqual(parsed.sampling, { temperature: 0.7, top_p: 0.9 });
  // One-space indentation was detected from the file, and the diff is exactly one line.
  assert.ok(next.includes('\n "parallel": 2\n'), "inserted with the file's own indent");
  const added = next.split("\n").length - text.split("\n").length;
  assert.equal(added, 1, "exactly one line added");
  // The previous last member now ends with a comma, and the JSON still parses.
  assert.match(next, /"port": 8080,/);
});

test("an existing key is rewritten in place, not duplicated", () => {
  const text = fixture((o) => ({ ...o, parallel: 2 }));
  const next = setTopLevelValue(text, "parallel", 3);
  assert.equal(parseJsonText(next).parallel, 3);
  assert.equal((next.match(/"parallel"/g) || []).length, 1);
  assert.equal(next.split("\n").length, text.split("\n").length, "same line count");
});

test("value 1 deletes the key — an absent key IS the engine default", () => {
  const text = fixture((o) => ({ ...o, parallel: 2 }));
  const next = setTopLevelValue(text, "parallel", undefined);
  const parsed = parseJsonText(next);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "parallel"), false, "the key is gone");
  assert.equal(parsed.port, 8080);
  assert.equal(parsed.args.length, parseJsonText(text).args.length);
  // Deleting must not leave a dangling comma (JSON.parse above would catch it, this
  // pins the shape too).
  assert.doesNotMatch(next, /,\s*\n\s*\}/);
  // Deleting from a missing key is a no-op.
  assert.equal(setTopLevelValue(fixture(), "parallel", undefined), fixture());
});

test("a MIDDLE member is deleted cleanly (the leading and trailing comma cases)", () => {
  const text = `{\n "a": 1,\n "parallel": 2,\n "b": 2\n}`;
  const next = setTopLevelValue(text, "parallel", undefined);
  const parsed = JSON.parse(next);
  assert.deepEqual(Object.keys(parsed), ["a", "b"]);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b, 2);
  // and the only member of its own object
  const solo = setTopLevelValue(`{\n "parallel": 2\n}`, "parallel", undefined);
  assert.deepEqual(JSON.parse(solo), {});
});

test("it refuses when the key appears more than once, and when the value is not a number", () => {
  const nested = fixture((o) => ({ ...o, vision: { parallel: 4 } }));
  assert.throws(() => setTopLevelValue(nested, "parallel", 2), /不只在顶层/);
  // A hand-edited string ("2") is repaired to a number rather than refused: the value it
  // means is unambiguous, and the result is checked after the edit.
  const asString = `{\n "parallel": "2",\n "port": 1\n}`;
  const repaired = setTopLevelValue(asString, "parallel", 3);
  assert.equal(JSON.parse(repaired).parallel, 3);
  assert.equal(JSON.parse(repaired).port, 1);
});

test("the server accepts 1 (off) through 8 (the engine's window); the UI tier caps below that", () => {
  assert.deepEqual(EDIT_KEYS.parallel, { kind: "number", restart: true, top: true });
  for (const ok of [1, 2, 3, 4, 6, 8]) assert.deepEqual(validateEdits({ parallel: ok }).errors, []);
  for (const bad of [0, -1, 9, 2.5, "x"]) {
    assert.equal(validateEdits({ parallel: bad }).errors.length, 1, `${bad} must be refused`);
  }
  assert.match(validateEdits({ parallel: 9 }).errors[0], /1\.\.8/);
});

test("flatConfig reads an absent key as 1, so leaving the field alone is never an edit", () => {
  assert.equal(flatConfig(parseJsonText(fixture()), null).parallel, 1);
  assert.equal(flatConfig(parseJsonText(fixture((o) => ({ ...o, parallel: 2 }))), null).parallel, 2);
  // And an untouched config produces no ops at all.
  const text = fixture();
  const res = renderConfigEdits({
    clean: { parallel: 1 },
    before: flatConfig(parseJsonText(text), null),
    mainText: text,
    sharedText: "{}",
  });
  assert.deepEqual(res.diff, []);
  assert.equal(res.newMainText, text);
});

test("through renderConfigEdits: 2 adds the key, 1 removes it again", () => {
  const text = fixture();
  const before = flatConfig(parseJsonText(text), null);
  const on = renderConfigEdits({ clean: { parallel: 2 }, before, mainText: text, sharedText: "{}" });
  assert.equal(parseJsonText(on.newMainText).parallel, 2);
  assert.deepEqual(on.diff, [{ key: "parallel", old: 1, new: 2 }]);
  assert.equal(on.restartRequired, true, "the engine reads it at startup");
  const off = renderConfigEdits({
    clean: { parallel: 1 },
    before: flatConfig(parseJsonText(on.newMainText), null),
    mainText: on.newMainText,
    sharedText: "{}",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(parseJsonText(off.newMainText), "parallel"), false);
  // Round trip: on then off returns the original text byte for byte.
  assert.equal(off.newMainText, text);
});

// ── the panel side: the group, the warning, the two numbers ─────────────────

test("the field lives in its own group, after KV, as a switch plus a number", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const html = read("ui/panel.html");
  const form = html.match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  const legends = [...form.matchAll(/data-i18n="(edit\.[a-zA-Z]+Legend)"/g)].map((m) => m[1]);
  const at = (key) => legends.indexOf(key);
  assert.ok(at("edit.parallelLegend") > at("edit.kvLegend"), "after the KV group");
  assert.ok(at("edit.parallelLegend") < at("edit.expertsLegend"), "before experts & memory");

  const group = [...form.matchAll(/<fieldset class="group">([\s\S]*?)<\/fieldset>/g)]
    .map((m) => m[1])
    .find((g) => g.includes("edit.parallelLegend"));
  assert.ok(group, "the group exists");
  // A switch, not a pick: "one at a time" and "off" are the same state.
  assert.match(group, /<input id="ed-parallelOn" type="checkbox">/);
  assert.match(group, /<input id="ed-parallel" data-key="parallel" type="number" min="2"/);
  assert.doesNotMatch(group, /<select/);
  // 8 GB is refused with a line that says why, never a silent grey switch.
  assert.match(group, /id="ed-parallelBlocked"/);
  // The parked-conversation knob stays in KV; this group holds no read-only report and no
  // default line (a select always has a value, so "engine default" belongs in the hint).
  assert.doesNotMatch(group, /conversationSlots|cf-readonly-item|field-default/);
  assert.match(group, /id="ed-parallelNow"/);
  assert.match(group, /id="ed-parallelTier"/);
});

test("the panel asks before turning concurrency on, and shows asked vs actual", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/panel.js"), "utf8");
  // A confirm step BEFORE the write, carrying the measured facts.
  const save = js.slice(js.indexOf("async function save()"), js.indexOf("async function doSave("));
  assert.match(save, /Number\(edits\.parallel\) >= 2/);
  assert.match(save, /showConfirm\(/);
  assert.match(save, /edit\.parallelWarnTitle/);
  assert.match(save, /edit\.parallelWarnBody/);
  assert.match(save, /onConfirm: \(\) => doSave\(edits\)/);
  // The warning must NOT repeat the OOM claim we disproved.
  assert.doesNotMatch(save, /OOM|内存不足会/);
  // asked vs actual: the engine's own report, with the configured value beside it.
  assert.match(js, /concurrency\?\.serving/);
  assert.match(js, /edit\.parallelNowValue/);
});

test("the nine concurrency strings exist in all six languages", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const i18n = fs.readFileSync(path.join(ROOT, "ui/assets/i18n.js"), "utf8");
  const keys = [
    "edit.parallelLegend",
    "edit.parallel",
    "edit.parallelNow",
    "edit.parallelNowValue",
    "edit.parallelNowUnknown",
    "edit.parallelHint",
    "edit.parallelWarnTitle",
    "edit.parallelWarnBody",
    "edit.parallelWarnGo",
    "edit.parallelWarnStay",
  ];
  for (const key of keys) {
    assert.equal([...i18n.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g"))].length, 6, key);
  }
});
