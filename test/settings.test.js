// Custom settings page backend (1.1.0 batch 5).
//
// The settings Tab now renders a custom HTML page, and these handlers are the
// authenticated route it talks to. They only touch the three global keys
// (autoStart / refreshSec / apiKey) through ctx.config; profiles and every
// other stored value must survive untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPrefs, writePrefs } from "../routes/settings.js";
import { readAllConfig, DEFAULTS } from "../lib/strata.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API_KEY_MASK = "********";

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async setMany(patch) {
        Object.assign(store, patch);
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

test("readPrefs falls back to schema defaults on a fresh install", async () => {
  const ctx = makeCtx({});
  const prefs = await readPrefs(ctx);
  assert.equal(prefs.autoStart, DEFAULTS.autoStart);
  assert.equal(prefs.refreshSec, DEFAULTS.refreshSec);
  assert.equal(prefs.apiKey, "");
  assert.equal(prefs.hasApiKey, false);
});

test("writePrefs persists the three global keys", async () => {
  const ctx = makeCtx({});
  const saved = await writePrefs(ctx, { autoStart: true, refreshSec: 12, apiKey: "secret-key" });
  assert.equal(saved.autoStart, true);
  assert.equal(saved.refreshSec, 12);
  assert.equal(saved.hasApiKey, true);
  // The real key never leaves the backend; only the mask does.
  assert.equal(saved.apiKey, API_KEY_MASK);
  assert.equal(ctx._store.apiKey, "secret-key");
  assert.equal(ctx._store.autoStart, true);
  assert.equal(ctx._store.refreshSec, 12);
});

test("a masked apiKey is treated as unchanged, an explicit value replaces it", async () => {
  const ctx = makeCtx({ autoStart: false, refreshSec: 5, apiKey: "original" });
  // Round-trips the masked value exactly as the page would.
  const before = await readPrefs(ctx);
  const kept = await writePrefs(ctx, { autoStart: true, refreshSec: 9, apiKey: before.apiKey });
  assert.equal(kept.hasApiKey, true);
  assert.equal(ctx._store.apiKey, "original");
  assert.equal(ctx._store.autoStart, true);
  assert.equal(ctx._store.refreshSec, 9);

  // An explicit non-mask value (including "" to clear) is written.
  await writePrefs(ctx, { apiKey: "replaced" });
  assert.equal(ctx._store.apiKey, "replaced");
  const cleared = await writePrefs(ctx, { apiKey: "" });
  assert.equal(ctx._store.apiKey, "");
  assert.equal(cleared.hasApiKey, false);
  assert.equal(cleared.apiKey, "");
});

test("writePrefs rejects invalid types and out-of-range values", async () => {
  const ctx = makeCtx({});
  await assert.rejects(() => writePrefs(ctx, { autoStart: "yes" }), /autoStart must be a boolean/);
  await assert.rejects(() => writePrefs(ctx, { refreshSec: 0 }), /refreshSec must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { refreshSec: 1.5 }), /refreshSec must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { refreshSec: "abc" }), /refreshSec must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { apiKey: 42 }), /apiKey must be a string/);
  // Nothing was written by the rejected calls.
  assert.deepEqual(Object.keys(ctx._store), []);
});

test("writing prefs never drops profiles or the legacy flat fallback", async () => {
  const profiles = JSON.stringify([
    { id: "p1", name: "default", type: "local", strataDir: "/srv/strata", ggufDir: "/models" },
  ]);
  const ctx = makeCtx({
    profiles,
    activeProfileId: "p1",
    strataDir: "/legacy-flat",
    pythonPath: "/legacy/python",
    port: 9999,
  });

  await writePrefs(ctx, { autoStart: true, refreshSec: 7, apiKey: "k" });

  // Internal keys are byte-for-byte intact.
  assert.equal(ctx._store.profiles, profiles);
  assert.equal(ctx._store.activeProfileId, "p1");
  assert.equal(ctx._store.strataDir, "/legacy-flat");
  assert.equal(ctx._store.pythonPath, "/legacy/python");
  assert.equal(ctx._store.port, 9999);

  // And readAllConfig still reconstructs the profile from the stored JSON.
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.activeProfileId, "p1");
  assert.equal(cfg.activeProfile.strataDir, "/srv/strata");
});

// Regression guard for the settings -> panel entry: it must use the official
// host API with the card id this App actually declares, and must keep a
// user-visible failure path.
test("settings page opens the declared panel card through hana.cards.open", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const cards = manifest?.contributes?.cards ?? [];
  assert.ok(cards.some((c) => c.id === "panel"), 'manifest must declare a card with id "panel"');

  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(src, /hana\.cards\.open\(\s*["']panel["']\s*\)/);
  assert.match(src, /settings\.openPanelFailed/);
});
