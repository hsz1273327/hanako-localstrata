// The parameter editor is a list of THEMED groups: one subject per fieldset, and a
// subject never scattered across two of them.
//
//   Startup          context / sessionCache / mtp
//   KV cache         --kv + the streaming report (--kv-resident / --kv-streaming)
//   Sampling         temperature … presence_penalty
//   Shared           max_tokens / reasoning_effort
//   Experts & memory expert-cache / resident-budget / low-ram
//
// The same shape carries to the profile forms: 视觉 is its own section on both
// sides (the container's writable `Vision` switch, the local read-only report),
// out of the advanced drawer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every <fieldset class="group"> of the params form, with its legend key, its
// data-keys and its markup — so "which group is this field in" is a fact.
function groups() {
  const form = read("ui/panel.html").match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  return [...form.matchAll(/<fieldset class="group">([\s\S]*?)<\/fieldset>/g)].map((m) => {
    const body = m[1];
    return {
      legend: (body.match(/<legend>[\s\S]*?data-i18n="([^"]+)"/) || [])[1] || null,
      keys: [...body.matchAll(/data-key="([^"]+)"/g)].map((x) => x[1]),
      ids: [...body.matchAll(/id="([^"]+)"/g)].map((x) => x[1]),
      text: body,
    };
  });
}

const EXPECTED_KEYS = [
  "context",
  "sessionCache",
  "mtp",
  "kv",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "max_tokens",
  "reasoning_effort",
  "expertCache",
  "residentBudget",
  "lowRam",
];

test("the params form is a list of themed groups, in subject order", () => {
  const g = groups();
  assert.deepEqual(
    g.map((x) => x.legend),
    ["edit.startupLegend", "edit.kvLegend", "edit.samplingLegend", "edit.sharedLegend", "edit.expertsLegend"],
    "one legend per subject",
  );
  // Regrouping must not lose or duplicate a field: the inventory is the same set.
  const keys = g.flatMap((x) => x.keys);
  assert.deepEqual([...keys].sort(), [...EXPECTED_KEYS].sort(), "the same 14 editable fields, no more, no fewer");
  assert.equal(new Set(keys).size, keys.length, "each field appears in exactly one group");
  for (const group of g) assert.ok(group.keys.length > 0, `${group.legend} is not empty`);
});

test("the three KV flags share one group, and are not scattered", () => {
  const g = groups();
  const kv = g.find((x) => x.legend === "edit.kvLegend");
  assert.ok(kv, "the KV group exists");
  // --kv (writable) …
  assert.ok(kv.keys.includes("kv"), "--kv belongs to the KV group");
  // … the parked-conversation budget, which is a KV subject too …
  assert.ok(kv.keys.includes("sessionCache"), "--conversation-cache-mib is a KV-cache subject");
  // … --kv-resident (the report line) …
  assert.ok(kv.ids.includes("edit-kvResident"), "the streaming report is in the same group");
  assert.match(kv.text, /edit\.kvStreamHint/, "with the reason it cannot be edited here");
  // … and --kv-streaming, whose effect annotation is per field.
  assert.match(kv.text, /data-i18n="edit\.needsSetup"/, "the streaming row is annotated 'needs setup'");
  assert.match(kv.text, /data-i18n="edit\.needsRestart"/, "while the level itself is annotated 'needs restart'");

  // The subject is whole: no other group mentions KV, and the startup group no
  // longer owns the level OR the conversation cache.
  const startup = g.find((x) => x.legend === "edit.startupLegend");
  assert.equal(startup.keys.includes("kv"), false, "--kv left the startup group");
  assert.equal(startup.keys.includes("sessionCache"), false, "and so did the conversation cache");
  for (const other of g.filter((x) => x !== kv)) {
    assert.doesNotMatch(other.text, /edit\.kv|edit-kvResident|sessionCache/, `${other.legend} must not carry KV fields`);
  }
});

// ── "引擎默认：X" is shown, and nothing else changes ──────────────────────

const DEFAULT_KEYS = {
  mtp: "edit.mtpDefault",
  sessionCache: "edit.sessionCacheDefault",
  expertCache: "edit.expertCacheDefault",
  residentBudget: "edit.residentBudgetDefault",
  lowRam: "edit.lowRamDefault",
};

test("every leave-it-empty parameter carries an engine-default line", () => {
  const form = read("ui/panel.html").match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  for (const [key, i18nKey] of Object.entries(DEFAULT_KEYS)) {
    // The line must sit in the SAME field block as its control, or the wiring in
    // panel.js cannot tell which input it follows.
    const block = form.match(new RegExp(`<label class="field">(?:(?!</label>)[\\s\\S])*data-key="${key}"(?:(?!</label>)[\\s\\S])*</label>`));
    assert.ok(block, `#${key} must be inside a label.field`);
    assert.match(block[0], new RegExp(`class="field-default" data-i18n="${i18nKey.replace(".", "\\.")}" hidden`), `${key} needs its default line, hidden`);
  }
  // A select that cannot be empty still names its default, and so do the two
  // groups whose numbers we could not verify.
  assert.match(form, /data-i18n="edit\.startupDefaultNote"/);
  assert.match(form, /data-i18n="edit\.samplingDefaultNote"/);
  assert.match(form, /data-i18n="edit\.sharedDefaultNote"/);
  assert.match(read("ui/assets/panel.js"), /renderDefaultHints/, "and the panel must drive them");
  assert.match(read("ui/assets/panel.js"), /line\.hidden = !isAbsent\(control\.value\)/, "shown only while empty");
});

test("no default is ever prefilled, and the write layer is untouched", async () => {
  const form = read("ui/panel.html").match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  // Display only: no control gains a value attribute, so "empty" stays empty.
  for (const key of Object.keys(DEFAULT_KEYS)) {
    const tag = form.match(new RegExp(`<(?:input|select)[^>]*data-key="${key}"[^>]*>`))[0];
    assert.doesNotMatch(tag, /\svalue="/, `#${key} must not be prefilled with its default`);
  }
  // And behaviourally: an absent value left empty is still not an edit, while a
  // filled one still is. (This is the rule that keeps "empty" meaning "write
  // nothing" even though the page now names the default.)
  const { editDiff } = await import("../ui/assets/edit-diff.js");
  const untouched = editDiff({}, { residentBudget: "", lowRam: "" });
  assert.deepEqual(untouched.items, [], "empty on both sides is not a change");
  assert.deepEqual(untouched.payload, {}, "and it submits nothing");
  const filled = editDiff({}, { residentBudget: "48" }, { residentBudget: "number" });
  assert.deepEqual(filled.payload, { residentBudget: 48 }, "a real value still gets written");
});

test("the default copy exists in six locales, and never invents a number", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const keys = [...Object.values(DEFAULT_KEYS), "edit.startupDefaultNote", "edit.samplingDefaultNote", "edit.sharedDefaultNote"];
  // How each language says "we could not confirm this".
  const unconfirmed = /未确认|unconfirmed|confirm|не под|未確認|미확인/i;
  for (const lang of LANGS) {
    for (const key of keys) assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    // The two groups we could not verify must say so rather than guess.
    assert.match(STRINGS[lang]["edit.samplingDefaultNote"], unconfirmed, `${lang}.edit.samplingDefaultNote must admit it`);
    assert.match(STRINGS[lang]["edit.sharedDefaultNote"], unconfirmed, `${lang}.edit.sharedDefaultNote must admit it`);
    assert.match(STRINGS[lang]["edit.mtpDefault"], unconfirmed, `${lang}.edit.mtpDefault must admit it`);
    // The ones we DID verify carry the figure from the source we cite.
    assert.match(STRINGS[lang]["edit.sessionCacheDefault"], /0/, "conversation cache default is 0 (off)");
    assert.match(STRINGS[lang]["edit.residentBudgetDefault"], /24/, "RAM − 24 GB, per setup's help text");
    assert.match(STRINGS[lang]["edit.lowRamDefault"], /auto/);
    assert.match(STRINGS[lang]["edit.expertCacheDefault"], /auto/);
  }
  // Every default key is actually used by a template (no orphan copy). Scoped to
  // edit.* — profile.* defaults live on the settings page, not in this form.
  const html = read("ui/panel.html");
  for (const lang of LANGS) {
    for (const key of Object.keys(STRINGS[lang]).filter((k) => /^edit\..*Default(Note)?$/.test(k))) {
      assert.match(html, new RegExp(key.replace(".", "\\.")), `${key} is not used`);
    }
  }
});

test("no group introduces a second level of folding", () => {
  const form = read("ui/panel.html").match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(form, /<details|<summary/, "the groups are fieldsets, not nested collapsibles");
  assert.equal((form.match(/<fieldset class="group">/g) || []).length, groups().length, "the extraction sees them all");
  assert.equal((form.match(/<\/fieldset>/g) || []).length, groups().length, "and every one is closed");
});

test("every group name is a subject, present in all six locales", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const legends = ["edit.startupLegend", "edit.kvLegend", "edit.samplingLegend", "edit.sharedLegend", "edit.expertsLegend"];
  const added = ["edit.kvLegend", "edit.kvStream", "edit.needsSetup"];
  for (const lang of LANGS) {
    for (const key of [...legends, ...added]) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // "needs setup" is its own annotation, not a synonym of "needs restart".
    assert.notEqual(STRINGS[lang]["edit.needsSetup"], STRINGS[lang]["edit.needsRestart"], `${lang} must distinguish them`);
    // The KV group's own field label must be there too.
    assert.ok(String(STRINGS[lang]["edit.kvStream"] || "").length > 0, `${lang}.edit.kvStream`);
  }
  // No legend key is left dangling in i18n without a group using it.
  for (const lang of LANGS) {
    for (const key of Object.keys(STRINGS[lang]).filter((k) => /Legend$/.test(k))) {
      assert.match(read("ui/panel.html"), new RegExp(key), `${key} is not used by any group`);
    }
  }
});

test("视觉 is one section on both sides, out of the advanced drawer", () => {
  const fields = read("ui/assets/profile-fields.js");
  // The container's switch and the local report both name it the same way, and
  // both live in a `.cf-section-vision`.
  assert.match(fields, /cf-section cf-section-vision/, "the section class exists");
  assert.match(fields, /i18nSpan\("field\.vision", "cf-section-title"\)/, "the local report is titled 视觉");
  assert.match(fields, /children: \[i18nSpan\("field\.vision"\), visionInput/, "the container's switch carries the same name");
  // The switch is no longer an advanced key, and no longer in the drawer. (It
  // stays in OWNED_KEYS: the module still owns the field, it just places it in its
  // own section.)
  const advKeys = fields.match(/const ADVANCED_KEYS = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(advKeys, /"Vision"/, "Vision left ADVANCED_KEYS");
  assert.match(fields.match(/const OWNED_KEYS = new Set\(\[([\s\S]*?)\]\);/)[1], /"Vision"/, "but the module still owns it");
  const drawer = fields.match(/advancedPanel\.replaceChildren\(([\s\S]*?)\);/)[1];
  assert.doesNotMatch(drawer, /visionField/, "the switch is not in the advanced panel");
  const host = fields.match(/host\.replaceChildren\(([\s\S]*?)\);/)[1];
  assert.match(host, /visionSection,/, "it is mounted as its own section");
  assert.ok(host.indexOf("visionSection,") < host.indexOf("advToggle,"), "before the drawer toggle");
  // Both pages get the styling.
  for (const css of ["ui/assets/panel.css", "ui/assets/settings.css"]) {
    assert.match(read(css), /\.cf-section-title/, `${css} styles the section title`);
  }
});
