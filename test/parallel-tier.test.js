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
