// READ-ONLY items vs editable fields: what is now, then what can change.
//
// 1. A read-only item has ONE recognisable style — `.cf-readonly-item`, a neutral
//    block (a plain rule and a faint ground, no colour, nothing to push) — and
//    holds no control at all.
// 2. Inside a group (and overall) read-only items come BEFORE the editable fields.
// 3. It is NOT the same thing as the "引擎默认：X" line (`.field-default`): that one
//    belongs to an editable field and answers "what happens if you leave this
//    empty", while a read-only item answers "this value cannot be changed". Different
//    class, different place, different trigger (always vs only-while-empty).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The <fieldset class="group"> bodies of the params form, in order.
const groupBodies = () =>
  [...read("ui/panel.html").matchAll(/<fieldset class="group">([\s\S]*?)<\/fieldset>/g)].map((m) => m[1]);

// A block: the markup from `<div class="cf-readonly-item...` to its matching close.
function readOnlyBlocks(html) {
  const out = [];
  const open = /<div class="cf-readonly-item[^"]*"[^>]*>/g;
  let m;
  while ((m = open.exec(html))) {
    let depth = 1;
    let i = open.lastIndex;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf("<div", i);
      const nextClose = html.indexOf("</div>", i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        i = nextClose + 6;
      }
    }
    out.push({ start: m.index, end: i, text: html.slice(m.index, i) });
    open.lastIndex = i;
  }
  return out;
}

test("the params groups hold editable fields, and the reports moved to 表一", () => {
  // The read-only rows used to sit at the head of the KV / experts groups. They
  // are setup's handwriting, so they now live together in the setup-facts table,
  // which comes before its picker and its button (read-only first).
  for (const body of groupBodies()) {
    const legend = (body.match(/data-i18n="(edit\.[a-zA-Z]*Legend)"/) || [])[1] || "?";
    assert.equal(readOnlyBlocks(body).length, 0, `${legend} must hold no read-only item`);
  }
  const html = read("ui/panel.html");
  const table = html.indexOf('id="setupFactsBox"');
  assert.ok(table > 0, "the setup-facts table exists");
  assert.ok(table < html.indexOf('id="configFileSelect"'), "and comes before the config picker");
  assert.ok(table < html.indexOf('id="configSetupBtn"'), "and before the setup button");
  assert.match(html, /id="setupFactsBox"/);
  // Its rows come from one list (the shared module), so the table, both pages and
  // the reports cannot drift.
  const facts = read("ui/assets/setup-facts.js");
  assert.match(facts, /export const SETUP_FACT_ROWS = \[/);
  for (const key of ["setupFacts.model", "setupFacts.backend", "setupFacts.gpu", "edit.lowRam", "edit.kvStream", "field.vision"]) {
    assert.ok(facts.includes(key), `${key} must be one of the rows`);
  }
  // 视觉 IS one of the rows (this config's property, like MTP), and the table is
  // the PANEL's: it reports a config file, and the panel owns the picker, the setup
  // entry and 参数编辑. The settings page defines environments, so it has neither.
  assert.ok(facts.includes("field.vision"), "the vision row");
  assert.match(facts, /\{ key: "vision"/);
  assert.match(read("ui/panel.html"), /id="setupFactsBox"/);
  assert.doesNotMatch(read("ui/settings.html"), /setup-facts|local-vision/, "settings: no table, no vision row");
  // The old per-page 视觉 mount points are gone (it would be the same fact twice).
  assert.doesNotMatch(read("ui/panel.html"), /ps-local-vision/);
});

test("no params group has a read-only item after an editable field", () => {
  // Vacuous while every report lives in 表一 — kept as the standing rule for the
  // day one comes back.
  for (const body of groupBodies()) {
    const legend = (body.match(/data-i18n="(edit\.[a-zA-Z]*Legend)"/) || [])[1] || "?";
    const firstKey = body.indexOf('data-key="');
    for (const block of readOnlyBlocks(body)) {
      assert.ok(firstKey < 0 || block.start < firstKey, `${legend}: a read-only item sits after an editable field`);
    }
  }
});

test("表一 is mounted in the panel, before that section's controls", () => {
  // The panel: in the 「配置文件」区, ahead of the picker and the setup button — the
  // table reports what the config IS, then the controls say what you can do.
  const panel = read("ui/panel.html");
  const boxAt = panel.indexOf('id="setupFactsBox"');
  assert.ok(boxAt > 0 && boxAt < panel.indexOf('id="configFileSelect"'), "panel: before the picker");
  assert.ok(boxAt < panel.indexOf('id="configSetupBtn"'), "panel: and before the setup button");
  // The settings page defines ENVIRONMENTS: no table, no vision row, no wiring.
  const settings = read("ui/settings.html");
  assert.doesNotMatch(settings, /setup-facts|setupFacts/, "settings: no 表一");
  assert.doesNotMatch(settings, /local-vision/, "settings: no vision row");
  assert.doesNotMatch(read("ui/assets/settings.js"), /createSetupFacts|renderSetupFacts/, "settings.js: no 表一 wiring");
  // The panel's mount is filled by the shared module (the same "one copy" pattern
  // the profile fields use), and the API key keeps its own mount point.
  assert.match(read("ui/assets/panel.js"), /createSetupFacts\(els\.setupFactsBox\)/);
  assert.match(panel, /id="ps-local-extra"/);
  assert.match(settings, /id="pf-local-extra"/);
});

test("read-only items and default-value lines are different things", () => {
  // Different classes, never nested, and the default line only exists inside a
  // field block that owns a control.
  for (const [file, form] of [
    ["ui/panel.html", read("ui/panel.html")],
  ]) {
    for (const block of readOnlyBlocks(form)) {
      assert.doesNotMatch(block.text, /class="field-default"/, `${file}: a default line inside a read-only item`);
    }
    for (const m of form.matchAll(/<span class="field-default"[^>]*>/g)) {
      const labelAt = form.lastIndexOf("<label", m.index);
      const labelEnd = form.indexOf("</label>", m.index);
      const label = form.slice(labelAt, labelEnd);
      assert.match(label, /data-key="/, `${file}: a default line must sit inside a field block that owns a control`);
    }
  }
  // The read-only block is the PANEL's (表一 and its rows). The settings page
  // defines environments, so its sheet carries neither block style.
  const panelCss = read("ui/assets/panel.css");
  assert.match(panelCss, /\.cf-readonly-item\s*\{/, "panel.css must style read-only items");
  assert.doesNotMatch(panelCss, /\.cf-readonly-item\s*,\s*\.field-default/, "panel.css must not merge the two");
  assert.match(panelCss, /\.field-default\s*\{/, "panel.css must style default lines");
  const settingsCss = read("ui/assets/settings.css");
  assert.doesNotMatch(settingsCss, /\.cf-readonly-item\s*\{/, "the settings sheet needs no read-only block");
  assert.doesNotMatch(settingsCss, /\ssf-row\s*\{/, "nor 表一's rows");
  // No colour: the read-only block uses neutral tokens only.
  const rule = panelCss.match(/\.cf-readonly-item \{([\s\S]*?)\}/)[1];
  assert.doesNotMatch(rule, /#[0-9a-f]{6}|rgb\(|accent|danger|warn/i, "read-only is neutral, colour stays for state/danger");
  assert.match(rule, /border-left/, "and it is visibly a block");
});

test("the read-only style lives on the page that has read-only items", async () => {
  const { STRINGS } = await import("../ui/assets/i18n.js");
  // The block's copy is the panel's; no new string was needed for the rule itself.
  for (const key of ["edit.kvStream", "edit.kvStreamHint", "setupFacts.title", "setupFacts.visionHint"]) {
    assert.ok(String(STRINGS.zh[key] || "").length > 0, `${key} missing`);
  }
  assert.match(read("ui/panel.html"), /setupFactsBox|cf-readonly/);
  // …and the settings page deliberately has none of it: it defines environments.
  assert.doesNotMatch(read("ui/settings.html"), /cf-readonly|setup-facts/);
});
