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
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

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
  assert.equal(prefs.defaultGgufDir, DEFAULTS.defaultGgufDir);
  assert.equal(prefs.defaultPort, DEFAULTS.defaultPort);
});

test("writePrefs persists the global keys, including the general fallbacks", async () => {
  const ctx = makeCtx({});
  const saved = await writePrefs(ctx, {
    autoStart: true,
    refreshSec: 12,
    apiKey: "secret-key",
    defaultGgufDir: "/general/models",
    defaultPort: 9000,
  });
  assert.equal(saved.autoStart, true);
  assert.equal(saved.refreshSec, 12);
  assert.equal(saved.hasApiKey, true);
  // The real key never leaves the backend; only the mask does.
  assert.equal(saved.apiKey, API_KEY_MASK);
  assert.equal(saved.defaultGgufDir, "/general/models");
  assert.equal(saved.defaultPort, 9000);
  assert.equal(ctx._store.apiKey, "secret-key");
  assert.equal(ctx._store.autoStart, true);
  assert.equal(ctx._store.refreshSec, 12);
  assert.equal(ctx._store.defaultGgufDir, "/general/models");
  assert.equal(ctx._store.defaultPort, 9000);
});

test("the general fallbacks can be cleared (empty dir / 0 port)", async () => {
  const ctx = makeCtx({ defaultGgufDir: "/x", defaultPort: 9000 });
  const cleared = await writePrefs(ctx, { defaultGgufDir: "  ", defaultPort: "" });
  assert.equal(cleared.defaultGgufDir, "");
  assert.equal(cleared.defaultPort, 0);
  assert.equal(ctx._store.defaultGgufDir, "");
  assert.equal(ctx._store.defaultPort, 0);
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
  await assert.rejects(() => writePrefs(ctx, { defaultGgufDir: 42 }), /defaultGgufDir must be a string/);
  await assert.rejects(() => writePrefs(ctx, { defaultPort: -1 }), /defaultPort must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { defaultPort: 70000 }), /defaultPort must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { defaultPort: 1.5 }), /defaultPort must be an integer/);
  await assert.rejects(() => writePrefs(ctx, { defaultPort: "abc" }), /defaultPort must be an integer/);
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

// Regression guard for in-place environment management: the settings page
// must manage profiles through this App's own routes instead of bouncing the
// user to the panel card (the host settings modal could not be dismissed from
// inside the App once the panel opened).
//
// Updated 1.1.0 batch 9: the page no longer *switches* the active profile.
// The row action that used to POST /profiles/select was removed so the
// settings page only describes configurations; running the other one belongs
// to the stop page's start flow (stop → pick → start). The backend route and
// routes/start.js still use selectProfile, so only the page call is gone.
test("settings page manages environment profiles in place", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(src, /api\(\s*["']profiles["']\s*\)/);
  assert.match(src, /api\(\s*["']profiles\/save["']/);
  assert.match(src, /api\(\s*["']profiles\/delete["']/);
  // The panel entry is gone, and so is its host call.
  assert.doesNotMatch(src, /hana\.cards\.open/);
  assert.doesNotMatch(src, /settings\.openPanel/);
  // The selected config is no longer a profile field, so the in-place editor
  // neither renders nor carries a configFile through an edit.
  assert.doesNotMatch(src, /originalConfigFile/);
  assert.doesNotMatch(src, /body\.configFile\s*=/);
});

// The settings page describes configurations; it never picks which one runs.
// "Using" a profile means starting it, and that lives on the stop page.
test("settings page has no profile-switch entry, only the running badge", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.doesNotMatch(src, /profiles\/select/);
  assert.doesNotMatch(src, /chooseProfile/);
  assert.doesNotMatch(src, /profile\.use["']/);
  assert.doesNotMatch(src, /profile\.selecting/);
  assert.doesNotMatch(src, /profile\.selected/);
  // The running marker stays, and the icon it used to carry is dropped with it.
  assert.match(src, /t\(\s*["']profile\.active["']\s*\)/);
  assert.match(src, /profile-active-badge/);
  assert.doesNotMatch(src, /ICONS\.check/);
  // "使用中" means RUNNING, not merely selected: the badge is gated on
  // inUse (serviceRunning && isActive), while the green row highlight — which
  // expresses the persisted selection — stays on isActive.
  assert.match(src, /if \(inUse\) \{\s*const active = document\.createElement\("span"\)/);
  assert.doesNotMatch(src, /if \(isActive\) \{\s*const active = document\.createElement\("span"\)/);
  assert.match(src, /if \(isActive\) row\.classList\.add\("active"\)/);
  // Edit / delete / add are untouched by the removal.
  assert.match(src, /api\(\s*["']profiles\/save["']/);
  assert.match(src, /api\(\s*["']profiles\/delete["']/);
  assert.match(src, /openProfileEditor\(p,\s*inUse\)/);
});

// The remaining backend `/profiles/select` route is still used by the start
// route (start with an explicit profileId), so removing the page call must not
// have removed the backend path.
test("the profile switch still exists on the backend for the start flow", () => {
  const routes = fs.readFileSync(path.join(ROOT, "routes/settings.js"), "utf8");
  assert.match(routes, /app\.post\(\s*"\/profiles\/select"/);
  const start = fs.readFileSync(path.join(ROOT, "routes/start.js"), "utf8");
  assert.match(start, /selectProfile/);
});

// The row's leading ●/○ dot carried no information (the running state is the
// "使用中" badge, the type is the badge after the name), so the settings page no
// longer renders it. The panel page keeps its own copy — untouched.
test("the settings profile row has no information-free leading dot", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.doesNotMatch(src, /profile-row-dot/);
  const css = fs.readFileSync(path.join(ROOT, "ui/assets/settings.css"), "utf8");
  assert.doesNotMatch(css, /\.profile-row-dot/);
  // What is left in the row start is exactly the name plus the type badge…
  assert.match(src, /main\.append\(name, badge\)/);
  assert.match(src, /profile-type-badge/);
  // …and the running marker / row actions are untouched.
  assert.match(src, /profile-active-badge/);
  assert.match(src, /t\(\s*["']profile\.active["']\s*\)/);
  assert.match(src, /edit\.textContent\s*=\s*inUse/);
});

// Layout guard: dropping a flex child must not need any compensation — the row
// keeps its own padding and every row shifts by the same amount.
test("the profile row keeps its own inset without the dot", () => {
  const css = fs.readFileSync(path.join(ROOT, "ui/assets/settings.css"), "utf8");
  assert.match(css, /\.profile-row\s*\{[^}]*padding:\s*7px 9px/);
  assert.match(css, /\.profile-row-main\s*\{[^}]*gap:\s*6px/);
  // No positional selector was compensating for the removed first child.
  assert.doesNotMatch(css, /profile-row-main[^{]*:first-child/);
});

// The settings pull entry acquires a MISSING image (first pull). Refreshing an
// image that already exists locally is the panel's "pull again", so here the
// entry hides once the image is local.
test("the settings pull entry acquires a missing image", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  assert.match(html, /id="pf-image-pull-row"/);

  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(src, /function\s+renderImageAction\s*\(/);
  // Offered only while the image is NOT local.
  assert.match(src, /if\s*\(row\)\s*row\.hidden\s*=\s*!value\s*\|\|\s*local;/);
  // The wording is always "pull" here; "pull again" lives in the panel.
  assert.match(src, /els\.profileImagePull\.textContent\s*=\s*t\(["']field\.imagePull["']\)/);
  assert.match(
    src,
    /const\s+local\s*=\s*imageListLoaded\s*&&\s*imageAvailable\s*&&\s*!imageError\s*&&\s*imageMatches\(value\)/,
  );
  // renderImageStatus() is the single repaint point (open / input / language /
  // after a pull) and it always repaints the action row too.
  assert.ok((src.match(/renderImageStatus\(\)/g) || []).length >= 4);
  assert.equal((src.match(/renderImageAction\(\)/g) || []).length, 2); // definition + one call
  assert.match(src, /profileImagePullRow:\s*document\.getElementById\("pf-image-pull-row"\)/);
  // One pull flow: the label is the only difference.
  assert.match(src, /async function pullImage\(\)/);
  assert.match(src, /api\("images\/pull"/);
});

// The profile editor must expose the type-specific fields the settings page
// promises: local source vs container.
test("settings page profile editor exposes type-specific fields", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  for (const id of ["pf-name", "pf-type", "pfLocalFields", "pfContainerFields", "pf-strataDir", "pf-pythonPath", "pf-gpu", "pf-image-name", "pf-image-tag", "pf-containerName", "pf-container-extra", "pf-ggufDir", "pf-port"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
  // Delete still goes through an explicit confirmation step.
  for (const id of ["profileConfirm", "profileConfirmOk", "profileConfirmCancel"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
});

// The General section now exposes the two fallback defaults; they must be
// wired all the way through the page JS.
test("settings page exposes the general fallback controls", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  for (const id of ["defaultGgufDir", "defaultPort"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(src, /defaultGgufDir/);
  assert.match(src, /defaultPort/);
});

// Regression for in-place environment management while the service runs: only
// the profile the service is running from is frozen. It opens as a read-only
// "view"; every other profile stays editable, because editing it is a config
// write that cannot reach the running deployment.
test("only the in-use profile turns into a read-only view", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  // The lock is "running AND active", not "running".
  assert.match(src, /const\s+inUse\s*=\s*serviceRunning\s*&&\s*isActive/);
  assert.match(
    src,
    /edit\.textContent\s*=\s*inUse\s*\?\s*t\(\s*["']profile\.view["']\s*\)\s*:\s*t\(\s*["']profile\.edit["']\s*\)/,
  );
  assert.match(src, /edit\.disabled\s*=\s*working;/);
  assert.doesNotMatch(src, /edit\.disabled\s*=\s*working\s*\|\|\s*serviceRunning/);
  // A locked (in-use) row opens the read-only variant of the same editor.
  assert.match(src, /openProfileEditor\(p,\s*inUse\)/);
  assert.doesNotMatch(src, /openProfileEditor\(p,\s*serviceRunning\)/);
});

test("read-only editor disables every field and removes the save path", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  assert.match(src, /let\s+editorReadOnly\s*=\s*false/);
  assert.match(src, /function\s+setEditorReadOnly\s*\(/);
  assert.match(src, /field\.disabled\s*=\s*readOnly/);
  assert.match(src, /els\.profileSaveBtn\.hidden\s*=\s*readOnly/);
  // Saving is refused even if the hidden button were somehow invoked.
  assert.match(src, /if\s*\(\s*working\s*\|\|\s*editorReadOnly\s*\)\s*return/);
  assert.match(src, /t\(\s*["']profile\.viewTitle["']\s*\)/);
  // The hint lives inside the editor and is localized.
  assert.match(html, /id="profileReadOnlyHint"/);
  assert.match(html, /data-i18n="profile\.readOnlyHint"/);
});

// The editor points at the fields a profile still needs before it can RUN, using
// the readiness rule (lib/profiles.js profileReady: local → Strata dir;
// container → image + container name). That is not the save-time requirement —
// a local profile saves with an empty Strata dir but cannot start then.
test("the editor marks empty start-required fields", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "ui/assets/settings.css"), "utf8");
  assert.match(src, /const START_REQUIRED_FIELDS = \{/);
  assert.match(src, /local: \["profileStrataDir"\]/);
  assert.match(src, /container: \["profileImageName", "profileContainerName"\]/);
  assert.match(src, /hint\.textContent = t\("field\.neededToStart"\)/);
  // Never shown in the read-only "view" variant (nothing can be filled there).
  assert.match(src, /function renderStartHints\(\) \{\s*clearStartHints\(\);\s*if \(editorReadOnly\) return;/);
  assert.match(src, /renderStartHints\(\);/);
  assert.match(css, /\.field-required-hint\s*\{/);
});

// Deleting is the same kind of config write as editing, so it follows the same
// rule: the in-use profile is protected while the service runs, the others are
// not. "At least one profile" still applies to every row.
test("delete is blocked for the in-use profile only", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(
    src,
    /del\.disabled\s*=\s*working\s*\|\|\s*inUse\s*\|\|\s*profiles\.length\s*<=\s*1/,
  );
  assert.doesNotMatch(
    src,
    /del\.disabled\s*=\s*working\s*\|\|\s*serviceRunning\s*\|\|\s*profiles\.length\s*<=\s*1/,
  );
  // The confirmation gate refuses the in-use profile too, not everything.
  assert.match(src, /if\s*\(serviceRunning\s*&&\s*profile\.id\s*===\s*activeProfileId\)\s*return;/);
  assert.doesNotMatch(src, /if\s*\(working\s*\|\|\s*serviceRunning\)\s*return;/);
});

// The backend must keep refusing edits to the in-use profile even though the
// page renders a read-only view, so the frontend never relies on the hidden
// save. The guard is target-aware: another profile may be written while the
// service runs.
test("routes/settings.js refuses writes to the in-use profile only", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes/settings.js"), "utf8");
  assert.match(src, /async function assertProfileMutable\(ctx, cfg, profile, action\)/);
  assert.match(src, /RUNNING_STATES\.has\(status\.state\)/);
  // Only the active profile is refused…
  assert.match(src, /profile\.id === cfg\.activeProfileId/);
  assert.match(src, /await assertProfileMutable\(ctx, cfg, existing, "修改"\)/);
  assert.match(src, /await assertProfileMutable\(ctx, cfg, target, "删除"\)/);
  // …and the old blanket guard is gone for good.
  assert.doesNotMatch(src, /assertNotRunning/);
});

// Boundary check for the narrowed lock: the profile write paths are pure
// ctx.config writes, so nothing on them can stop / start / restart the service
// and editing another profile while it runs cannot interrupt it.
test("the profile routes never touch the service lifecycle", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes/settings.js"), "utf8");
  // \b keeps `restartService` from being read as a `startService` hit.
  assert.doesNotMatch(src, /\b(?:startService|stopService)\b/);
  // restartService exists for POST /settings (the config-file editor with
  // `restart: true`) only: one import plus one call site, neither of them in a
  // /profiles handler.
  assert.equal((src.match(/restartService/g) || []).length, 2);
});

// Layout guard for in-place profile management: the add action sits above the
// list, and the editor is a right-side drawer (scrim + its own close button +
// Esc) that floats over the page instead of pushing the list around.
test("profile editor is a right-side drawer with the add action above the list", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  // The add button precedes the list in source order.
  assert.ok(
    html.indexOf('id="profileAddBtn"') < html.indexOf('id="profileList"'),
    "profileAddBtn must come before profileList",
  );
  // Drawer chrome exists and is announced as a modal dialog.
  assert.match(html, /id="profileDrawerScrim"/);
  assert.match(html, /id="profileEditorCloseBtn"/);
  assert.match(html, /id="profileEditor"[^>]*role="dialog"/);
  // The close button reuses the existing localized close label.
  assert.match(html, /id="profileEditorCloseBtn"[\s\S]*?data-i18n-aria-label="profile\.close"/);

  const css = fs.readFileSync(path.join(ROOT, "ui/assets/settings.css"), "utf8");
  assert.match(css, /\.profile-editor\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.profile-drawer-scrim\s*\{[^}]*position:\s*fixed/);

  const src = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  // Scrim, close button and Esc all funnel through the existing close helper.
  assert.match(src, /function\s+setDrawerOpen\s*\(/);
  assert.match(src, /els\.profileDrawerScrim\.addEventListener\("click",\s*closeProfileEditor\)/);
  assert.match(src, /els\.profileEditorCloseBtn\.addEventListener\("click",\s*closeProfileEditor\)/);
  assert.match(src, /e\.key\s*===\s*"Escape"/);
});

// The four new labels must exist and be non-empty in all six locales.
test("read-only view i18n keys exist in every locale", () => {
  const keys = ["profile.view", "profile.viewTitle", "profile.readOnlyHint", "profile.close"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
  }
});
