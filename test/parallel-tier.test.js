// Concurrency by VRAM tier — the product's rule, not the engine's (the engine's window is
// 8 slots; these tiers cap far below that on small cards).
//
// Boundaries are in MiB because a "16 GB" card reports 16380 MiB (firmware reservation), so
// a GiB comparison against "> 16" would push it into the 24 GB tier. The exact boundaries
// below are the ones the specification names: ≤8 · ≤12 · ≤16 · ≤24 · ≤32 · above.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PARALLEL_HARD_MAX,
  PARALLEL_OFF,
  parallelBounds,
  parallelDefault,
  parallelTier,
} from "../ui/assets/parallel-tier.js";

const GB = 1024;

test("8 GB is refused, and the reason is a tier — not a silent grey", () => {
  for (const mib of [1024, 4096, 8192]) {
    const t = parallelTier(mib);
    assert.equal(t.disabled, true, `${mib} MiB must be disabled`);
    assert.equal(t.tier, "8");
    assert.equal(parallelDefault(mib), 0, "no default to offer");
  }
});

test("12 GB is allowed but flagged, and cannot go past 2", () => {
  const t = parallelTier(12 * GB);
  assert.equal(t.disabled, false);
  assert.equal(t.warn, true, "the copy says: allowed, not recommended");
  assert.equal(parallelDefault(12 * GB), 2);
  assert.deepEqual(parallelBounds(12 * GB), { min: 2, max: 2, tier: t });
  // Just above the 8 GB boundary already belongs to the 12 tier.
  assert.equal(parallelTier(8 * GB + 1).tier, "12");
});

test("16 GB: default 2, cap 3 — and a real 16 GB card reports 16380 MiB", () => {
  for (const mib of [12 * GB + 1, 16380, 16 * GB]) {
    const t = parallelTier(mib);
    assert.equal(t.tier, "16", `${mib} MiB is the 16 GB tier`);
    assert.equal(t.disabled, false);
    assert.equal(t.warn, false);
    assert.equal(parallelDefault(mib), 2, "recommended 2 on 16 GB");
    assert.equal(parallelBounds(mib).max, 3, "cap 3");
  }
});

test("the >16 … ≤24 tier starts one MiB above 16 GB, so exactly 24 stays in it", () => {
  assert.equal(parallelTier(16 * GB + 1).tier, "24");
  assert.equal(parallelTier(24 * GB).tier, "24", "exactly 24 GB is the 24 tier");
  assert.equal(parallelDefault(24 * GB), 3);
  assert.equal(parallelBounds(24 * GB).max, 4);
  assert.equal(parallelTier(24 * GB + 1).tier, "32", "one MiB more moves up");
});

test("the >24 … ≤32 tier, and everything above it", () => {
  assert.equal(parallelTier(32 * GB).tier, "32");
  assert.equal(parallelDefault(32 * GB), 4);
  assert.equal(parallelBounds(32 * GB).max, 6);
  assert.equal(parallelTier(32 * GB + 1).tier, "big");
  assert.equal(parallelTier(80 * GB).tier, "big");
  assert.equal(parallelDefault(80 * GB), 4, "still 4, not the cap");
  assert.equal(parallelBounds(80 * GB).max, PARALLEL_HARD_MAX, "the engine's own window");
});

test("no VRAM reading: allowed, on the middle tier, and said out loud", () => {
  for (const bad of [undefined, null, NaN, 0, -1, "x"]) {
    const t = parallelTier(bad);
    assert.equal(t.tier, "unknown", `${String(bad)} is unknown`);
    assert.equal(t.disabled, false, "a transient read failure must not take the feature away");
    assert.equal(parallelDefault(bad), 2);
    assert.equal(parallelBounds(bad).max, 3);
  }
});

test("the number never goes below 2 — 1 means off, and off writes no key", () => {
  assert.equal(PARALLEL_OFF, 1);
  for (const mib of [12 * GB, 16 * GB, 24 * GB, 32 * GB, 80 * GB, null]) {
    assert.equal(parallelBounds(mib).min, 2, `${String(mib)}: min is 2`);
  }
  // The default always sits inside the tier's window.
  for (const mib of [12 * GB, 16380, 24 * GB, 32 * GB, 80 * GB, null]) {
    const { min, max } = parallelBounds(mib);
    const def = parallelDefault(mib);
    assert.ok(def >= min && def <= max, `${mib}: ${def} is within ${min}..${max}`);
  }
});

// ── the panel switch: enabled/disabled vs checked ───────────────────────────
//
// A switch that "cannot be clicked" is usually not disabled at all: `syncParallelUi` is
// called from paint() every refresh AND from the switch's own handler, so writing
// `.checked` there snapped every click straight back to the file's value.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("a 16 GB card (16380 MiB) leaves the switch ENABLED", () => {
  const t = parallelTier(16380);
  assert.equal(t.tier, "16");
  assert.equal(t.disabled, false, "16380 MiB must be allowed to turn concurrency on");
});

test("only the 8 GB tier disables it, and `.checked` is never refreshed while typing", () => {
  const js = read("ui/assets/panel.js");
  const fn = js.slice(js.indexOf("function syncParallelUi("), js.indexOf("function onParallelSwitch("));
  assert.ok(fn.length > 0, "syncParallelUi exists");
  // disabled comes from the tier alone
  assert.match(fn, /els\.parallelOn\.disabled = tier\.disabled;/);
  // `.checked` is assigned exactly once, and inside the resetValue guard
  const checked = [...fn.matchAll(/els\.parallelOn\.checked\s*=/g)];
  assert.equal(checked.length, 1, "one assignment, and it is the reset");
  assert.match(fn, /if \(resetValue\) \{\s*\n\s*els\.parallelOn\.checked = on;/);
  // paint() refreshes the switch's availability, never its value
  const start = js.indexOf("function paint(s) {");
  const paint = js.slice(start, js.indexOf("\n}\n", start) + 3);
  assert.ok(paint.length > 20, "paint() was found");
  assert.match(paint, /syncParallelUi\(\);/);
  assert.doesNotMatch(paint, /resetValue: true/, "a repaint must not reset the user's input");
  // …and the one place that DOES reset is a fresh config load.
  const fill = js.slice(js.indexOf("function fillEditForm("), js.indexOf("function parallelTotalMiB("));
  assert.match(fill, /syncParallelUi\(\{ resetValue: true \}\)/);
});

test("the ids on both sides match, and the handler is wired with an optional guard", () => {
  const html = read("ui/panel.html");
  const js = read("ui/assets/panel.js");
  const id = "ed-parallelOn";
  assert.ok(html.includes(`<input id="${id}" type="checkbox">`), "the checkbox is in the markup");
  assert.ok(js.includes(`document.getElementById("${id}")`), "and looked up by the same id");
  assert.match(js, new RegExp(`els\\.parallelOn\\?\\.addEventListener\\("change", onParallelSwitch\\)`));
});

test("the switch is a compact row, never the full-width input box", () => {
  const html = read("ui/panel.html");
  const form = html.match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  const group = [...form.matchAll(/<fieldset class="group">([\s\S]*?)<\/fieldset>/g)]
    .map((m) => m[1])
    .find((g) => g.includes("edit.parallelLegend"));
  assert.ok(group, "the concurrency group exists");
  // The checkbox lives in its own row, and no `.field` wrapper holds it: a `.field` is the
  // full-width input box (width:100%, border, padding), which made an empty slab.
  assert.match(group, /<div class="cf-switch">\s*\n\s*<label class="cf-switch-row">/);
  assert.match(group, /<label class="cf-switch-row">\s*\n\s*<input id="ed-parallelOn" type="checkbox">/);
  assert.doesNotMatch(
    group,
    /<label class="field">[^]*?<input id="ed-parallelOn"/,
    "the switch must not sit inside a .field",
  );
  // Its notes are a nested block (indented), not three full rows.
  assert.match(group, /<div class="cf-switch-notes">/);
  // The number field (a real text input) keeps `.field`, which is what it is for.
  assert.match(group, /<label class="field" id="ed-parallelField"[^>]*>[\s\S]*?data-key="parallel"/);
  // CSS: the compact row, and the checkbox guard inside `.field` for anything added later.
  const css = read("ui/assets/panel.css");
  assert.match(css, /\.cf-switch-row \{[^}]*display: flex/);
  assert.match(css, /\.cf-switch-row input\[type="checkbox"\] \{[^}]*width: 15px/);
  assert.match(css, /\.field input\[type="checkbox"\] \{[^}]*width: 15px/);
  assert.match(css, /\.cf-switch-notes \{[^}]*padding-left: 23px/);
});
