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

test("the KV streaming report is a read-only item, first in its group", () => {
  const bodies = groupBodies();
  const kv = bodies.find((b) => b.includes('data-i18n="edit.kvLegend"'));
  assert.ok(kv, "the KV group exists");
  const blocks = readOnlyBlocks(kv);
  assert.equal(blocks.length, 1, "one read-only item in the KV group");
  const firstKey = kv.indexOf('data-key="');
  assert.ok(blocks[0].start < firstKey, "it comes before every editable field of the group");
  // A report, not a control: nothing to type into.
  assert.doesNotMatch(blocks[0].text, /data-key=|<input|<select|<textarea/, "no control inside");
  // It keeps its label and its per-field annotation.
  assert.match(blocks[0].text, /cf-readonly-label/);
  assert.match(blocks[0].text, /data-i18n="edit\.needsSetup"/);
});

test("no other params group has a read-only item after an editable field", () => {
  for (const body of groupBodies()) {
    const legend = (body.match(/data-i18n="(edit\.[a-zA-Z]*Legend)"/) || [])[1] || "?";
    const firstKey = body.indexOf('data-key="');
    for (const block of readOnlyBlocks(body)) {
      assert.ok(firstKey < 0 || block.start < firstKey, `${legend}: a read-only item sits after an editable field`);
    }
  }
});

test("the local 视觉 report is mounted at the top of its block, on both pages", () => {
  const pages = [
    ["ui/panel.html", "ps-local-vision", "psLocalFields"],
    ["ui/settings.html", "pf-local-vision", "pfLocalFields"],
  ];
  for (const [file, mountId, blockId] of pages) {
    const html = read(file);
    const block = html.slice(html.indexOf(`id="${blockId}"`), html.indexOf(`id="${mountId}"`) + 200);
    assert.ok(html.includes(`id="${mountId}"`), `${file} needs the mount point`);
    // The mount point is a child of the block, before its first input.
    const mountAt = html.indexOf(`id="${mountId}"`);
    const blockAt = html.indexOf(`id="${blockId}"`);
    const firstInput = html.indexOf("<input", blockAt);
    assert.ok(blockAt < mountAt, `${mountId} must be inside ${blockId}`);
    assert.ok(mountAt < firstInput, `${file}: the read-only mount must precede the block's first editable field`);
    assert.ok(block.includes(mountId));
  }
  // The API key (editable) keeps its own mount point, below the fields.
  assert.match(read("ui/panel.html"), /id="ps-local-extra"/);
  assert.match(read("ui/settings.html"), /id="pf-local-extra"/);
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
  // The read-only block is styled in BOTH sheets (each page renders one); the
  // default-value line exists only in the params form, so only panel.css needs it.
  for (const css of ["ui/assets/panel.css", "ui/assets/settings.css"]) {
    const sheet = read(css);
    assert.match(sheet, /\.cf-readonly-item\s*\{/, `${css} must style read-only items`);
    assert.doesNotMatch(sheet, /\.cf-readonly-item\s*,\s*\.field-default/, `${css} must not merge the two`);
  }
  assert.match(read("ui/assets/panel.css"), /\.field-default\s*\{/, "panel.css must style default lines");
  // No colour: the read-only block uses neutral tokens only.
  const panelCss = read("ui/assets/panel.css");
  const rule = panelCss.match(/\.cf-readonly-item \{([\s\S]*?)\}/)[1];
  assert.doesNotMatch(rule, /#[0-9a-f]{6}|rgb\(|accent|danger|warn/i, "read-only is neutral, colour stays for state/danger");
  assert.match(rule, /border-left/, "and it is visibly a block");
});

test("the read-only style is described once, in both sheets", async () => {
  const { STRINGS } = await import("../ui/assets/i18n.js");
  // The block carries copy the user already has (labels/announcements); no new
  // string was needed for the rule itself.
  for (const key of ["edit.kvStream", "edit.kvStreamHint", "edit.needsSetup", "field.vision"]) {
    assert.ok(String(STRINGS.zh[key] || "").length > 0, `${key} missing`);
  }
  for (const html of ["ui/panel.html", "ui/settings.html"]) {
    assert.match(read(html), /cf-readonly|local-vision/, `${html} must expose the rule`);
  }
});
