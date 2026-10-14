// Regression guards for the panel's "running = read-only" behaviour.
//
// The panel (ui/panel.html + ui/assets/panel.js) hides the parameter editor and
// the update action while the service is running, and turns the profile badge
// into a read-only detail drawer. These guards pin that behaviour.
//
// Two layers live in this file:
//
//   Layer 1 — always-on, ZERO-DEPENDENCY source guards.
//     They assert the running-state conditionals, the header/drawer markup and
//     the i18n copy are present and shaped as expected. They run under the
//     repo's plain `node --test test/*.js` with no install step (this repo has
//     no package.json / node_modules by design). They prove the code *says* the
//     right thing; they do not execute it.
//
//   Layer 2 — behavioural layer, gated on jsdom.
//     It loads the real ui/panel.html + ui/assets/panel.js in jsdom with a
//     stubbed SDK and drives the whole running-state flow (badge -> read-only
//     drawer -> x / scrim / Escape, the stopped state, the setup notice).
//     jsdom is NOT a dependency of this repo, so this layer is
//     reported as skipped by default. To enable it, add jsdom as a
//     devDependency (create package.json, `npm install`) — nothing else in this
//     file needs to change.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const panelHtml = read("ui/panel.html");
const panelJs = read("ui/assets/panel.js");
const panelCss = read("ui/assets/panel.css");
const i18nSrc = read("ui/assets/i18n.js");

// ── Layer 1: zero-dependency source guards ────────────────────────────────

test("running state hides the parameter editor and shows it only when stopped", () => {
  assert.match(panelJs, /const running = RUNNING_STATES\.has\(s\.state\)/);
  assert.match(panelJs, /els\.settingsBox\.hidden = isSetup \|\| running/);
});

test("running state drops the update action button but keeps the version row", () => {
  // The running branch pushes the latest-version row with the hint and WITHOUT
  // the 6th (action) element.
  assert.match(
    panelJs,
    /else if \(RUNNING_STATES\.has\(s\.state\)\) \{\s*rows\.push\(\[\s*t\("label\.latestVersion"\),\s*tp\("version\.available", \{ version: latest \}\),\s*"update",\s*undefined,\s*t\("version\.stopToUpdate"\),\s*\]\);/,
  );
  // The stopped path still renders the real update button.
  assert.match(panelJs, /label: t\("common\.update"\), onClick: \(btn\) => promptUpdate\(latest, btn\)/);
});

test("the header control mirrors the running state: badge while running, picker while stopped", () => {
  // The read-only badge is shown only in a running state; the picker only while stopped.
  assert.match(panelJs, /els\.profileBadge\.hidden = !show \|\| !running;/);
  assert.match(panelJs, /els\.envSelect\.hidden = !show \|\| running;/);
  assert.match(panelJs, /els\.profileBadge\.title = t\("profile\.viewDetails"\);/);
  // The detail drawer stays running-only.
  assert.match(panelJs, /if \(!RUNNING_STATES\.has\(state\.status\?\.state\)\) return;/);
  // Unsupported (macOS) hides both header controls explicitly.
  assert.match(panelJs, /els\.profileBadge\.hidden = true;\s*els\.envSelect\.hidden = true;/);
});

test("the drawer never auto-closes on a repaint — only the user (or a successful save)", () => {
  // The retired rule: paint() used to close the drawer whenever the state was
  // not running, so the ~5s poll closed a stopped edit drawer on its own.
  assert.doesNotMatch(panelJs, /if \(!running && els\.profileDrawer/);
  // paint() must not touch the drawer at all.
  const paintBody = panelJs.slice(panelJs.indexOf("function paint(s) {"), panelJs.indexOf("function overlayContent("));
  assert.ok(paintBody.length > 0, "paint() body not found");
  assert.doesNotMatch(paintBody, /closeProfileDetail|profileDrawer/);
  // The one automatic close is the natural end of a successful save.
  assert.match(panelJs, /if \(ok\) \{\s*closeProfileDetail\(\);\s*await refresh\(\);/);
});

test("the read-only detail reuses the panel's existing editor, not a third form", () => {
  // Exactly one profile editor template in the panel.
  assert.equal((panelHtml.match(/id="pluginSettingsTemplate"/g) || []).length, 1);
  // The very same #psEditor node is moved into the drawer and moved back.
  assert.match(panelJs, /els\.profileDrawerBody\.replaceChildren\(pluginFormEls\.editor\)/);
  assert.match(panelJs, /pluginFormEls\.root\.append\(pluginFormEls\.editor\)/);
  // Read-only = disable every field and hide the write actions.
  assert.match(panelJs, /function setProfileEditorReadOnly\(readOnly\)/);
  assert.match(panelJs, /pluginFormEls\.editor\.querySelectorAll\("input, select"\)/);
  // The panel change must not reach into the settings page.
  assert.doesNotMatch(panelJs, /settings\.js/);
});

test("the detail drawer closes three ways: x, scrim click and Escape", () => {
  assert.match(panelJs, /els\.profileDrawerClose\.addEventListener\("click", closeProfileDetail\)/);
  assert.match(panelJs, /els\.profileDrawerScrim\.addEventListener\("click", closeProfileDetail\)/);
  assert.match(panelJs, /e\.key === "Escape" && !els\.profileDrawer\.hidden/);
  // The drawer markup it drives exists, with the read-only hint copy.
  assert.match(panelHtml, /id="profileDrawerScrim"/);
  assert.match(panelHtml, /id="profileDrawerBody"/);
  assert.match(panelHtml, /id="profileReadOnlyHint"[^>]*data-i18n="profile\.readOnlyHint"/);
});

test("the badge sits in the header title row, not in the status card", () => {
  assert.equal((panelHtml.match(/id="profileBadge"/g) || []).length, 1);
  // Right after the Strata title, inside .brand.
  assert.match(
    panelHtml,
    /<span class="title">Strata<\/span>\s*<button[^>]*id="profileBadge"[^>]*class="profile-badge"/,
  );
  // The status head is left with only dot + state text + net-mode chip.
  const head = panelHtml.match(/<div class="status-head">([\s\S]*?)<\/div>/);
  assert.ok(head, "status-head block not found");
  assert.doesNotMatch(head[1], /profileBadge/);
  assert.match(head[1], /id="dot"/);
  assert.match(head[1], /id="stateText"/);
  assert.match(head[1], /id="netMode"/);
});

test("header layout guards keep the badge from crowding or clipping the right-side controls", () => {
  // The header is a grid item of .panel; min-width:0 lets its track shrink so the
  // badge ellipsizes instead of pushing the controls off-screen.
  assert.match(panelCss, /\.panel-header \{[^}]*min-width: 0;/);
  assert.match(panelCss, /\.header-actions \{[^}]*flex: none;/);
  const badgeRule = panelCss.match(/\.profile-badge \{[^}]*\}/);
  assert.ok(badgeRule, ".profile-badge rule not found");
  assert.match(badgeRule[0], /min-width: 0;/);
  assert.match(badgeRule[0], /max-width: 14em;/);
  assert.match(badgeRule[0], /overflow: hidden;/);
  assert.match(badgeRule[0], /text-overflow: ellipsis;/);
  assert.match(badgeRule[0], /white-space: nowrap;/);
});

test("the new i18n copy exists and is non-empty in all six locales", async () => {
  const { STRINGS, LANGS } = await import(pathToFileURL(path.join(ROOT, "ui/assets/i18n.js")).href);
  assert.equal(LANGS.length, 6);
  for (const key of ["profile.viewDetails", "version.stopToUpdate", "setup.configureInSettings", "profile.missingFields", "field.neededToStart"]) {
    for (const lang of LANGS) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
  }
});

test("the profile-management gear and its manager block are gone from the panel", () => {
  assert.doesNotMatch(panelHtml, /id="configBtn"/);
  assert.doesNotMatch(panelHtml, /id="psProfileList"|id="psAddBtn"|id="psSaveBtn"|id="psCancelBtn"|class="section-title"/);
  for (const gone of ["function paintSetup\\(", "renderProfileList", "profileListKey", "openProfileEditor\\(profile\\)", "closeProfileEditor\\(", "saveProfile\\(", "removeProfile\\(", "confirmDeleteProfile", "showConfig"]) {
    assert.doesNotMatch(panelJs, new RegExp(gone), `panel.js must no longer reference ${gone}`);
  }
  // No "open the settings surface" hack was hard-coded: the host exposes no such API.
  assert.doesNotMatch(panelJs, /cards\.open|openSettings/);
  // The gear's only i18n key is now an orphan and was removed from every locale.
  assert.doesNotMatch(i18nSrc, /deploy\.openConfig/);
});

test("setup states show a plain-text pointer to the Settings page, not an editor", () => {
  assert.match(panelHtml, /id="statusConfigBox"[\s\S]*?<p id="setupNotice"[^>]*data-i18n="setup\.configureInSettings"/);
  assert.match(panelJs, /function paintSetupNotice\(s\) \{/);
  assert.match(panelJs, /const show = SETUP_STATES\.has\(s\.state\);/);
  assert.match(panelJs, /paintSetupNotice\(s\);/);
});

test("a start-blocked environment names the missing fields, not a vague prompt", () => {
  assert.match(panelJs, /function missingStartFields\(profile\)/);
  assert.match(panelJs, /function startBlockedMessage\(profile\)/);
  assert.match(panelJs, /tp\("profile\.missingFields", \{ fields: joinList\(missing\) \}\)/);
  // Readiness is the backend's verdict (`launch.canStart`) plus the per-profile
  // `missing` keys — never re-derived from a summary that carries no fields.
  assert.match(panelJs, /function canStartCurrent\(s\) \{\s*return s\?\.launch\?\.canStart !== false;/);
  assert.match(panelJs, /\(profile\?\.missing \|\| \[\]\)\.map/);
  assert.doesNotMatch(panelJs, /if \(!profile\.image\) missing\.push/);
  // The retired radio picker is gone.
  assert.doesNotMatch(panelJs, /profileHasFields|profileIsReady|selectedStartProfile|canStartSelected|paintStartOptions|startProfileId|startProfileList/);
  // The hint hangs on the status card (next to the start button), not the picker.
  assert.match(panelJs, /els\.startOptionsHint\.textContent = blocked \? startBlockedMessage\(s\.profile\) : ""/);
  assert.doesNotMatch(panelJs, /showError\(t\("profile\.notReady"\)\)/);
});

test("the header picker switches the current environment and refreshes every card", () => {
  assert.match(panelHtml, /id="envSelect"[^>]*data-i18n-aria-label="profile\.selectEnv"/);
  assert.match(panelJs, /function paintEnv\(s\)/);
  // Running stays read-only: the picker hides, the badge shows.
  assert.match(panelJs, /els\.profileBadge\.hidden = !show \|\| !running;/);
  assert.match(panelJs, /els\.envSelect\.hidden = !show \|\| running;/);
  assert.match(panelJs, /els\.envSelect\.addEventListener\("change", \(\) => selectEnv\(els\.envSelect\.value\)\)/);
  // Selecting persists the choice via the still-present route, then refreshes.
  assert.match(panelJs, /await api\("profiles\/select", \{ method: "POST", body: JSON\.stringify\(\{ id \}\) \}\)/);
  assert.match(panelJs, /state\.working = false;\s*await refresh\(\);/);
});

test("a header action edits the CURRENT environment through the shared drawer", () => {
  assert.match(panelHtml, /id="profileEditBtn"[^>]*data-i18n-aria-label="profile\.editTitle"/);
  assert.match(panelHtml, /id="profileDrawerSave"/);
  assert.match(panelJs, /function openProfileEditor\(\)/);
  assert.match(panelJs, /els\.profileEditBtn\.hidden = !show \|\| running;/);
  assert.match(panelJs, /els\.profileEditBtn\.addEventListener\("click", openProfileEditor\)/);
  // Reuses the ONE drawer/editor (no second editor, no management UI).
  assert.match(panelJs, /async function openDrawer\(readOnly\)/);
  assert.match(panelJs, /els\.profileDrawerActions\.hidden = readOnly;/);
  assert.doesNotMatch(panelJs, /profiles\/delete/);
  assert.doesNotMatch(panelJs, /openProfileEditor\(null\)/);
  // Saving goes through the existing route and then refreshes.
  assert.match(panelJs, /await api\("profiles\/save", \{ method: "POST", body: JSON\.stringify\(collectProfileEdits\(\)\) \}\)/);
  assert.match(panelJs, /if \(ok\) \{\s*closeProfileDetail\(\);\s*await refresh\(\);/);
});

// ── Layer 2: behavioural layer (requires jsdom) ───────────────────────────
//
// Skipped unless jsdom resolves. This repo is dependency-free by design; the
// behavioural coverage of these guards therefore only activates once jsdom is
// added as a devDependency. Nothing below imports anything else.

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}

const STUB_SDK = `// Stub of ./sdk.js: values are read from globalThis.__API__ at call time.
function res(data) {
  return { ok: true, status: 200, json: async () => data };
}
export const hana = {
  ready: async () => {},
  api: {
    fetch: async (p, init) => {
      const s = globalThis.__API__ || {};
      if (p === "status") {
        globalThis.__API__.statusCalls = (globalThis.__API__.statusCalls || 0) + 1;
        return res(s.status || { state: "stopped" });
      }
      if (p === "settings") return res(s.settings || { hasConfig: true, values: {}, configFile: "" });
      if (p === "profiles") return res(s.profiles || { profiles: [], activeProfileId: "" });
      if (p === "profiles/running") return res({ running: false });
      if (p === "profiles/select") {
        const id = init && init.body ? JSON.parse(init.body).id : null;
        (globalThis.__API__.selectCalls = globalThis.__API__.selectCalls || []).push(id);
        if (s.select && s.select.status) globalThis.__API__.status = s.select.status;
        if (s.select && s.select.profiles) globalThis.__API__.profiles = s.select.profiles;
        return res({ saved: true, activeProfileId: id });
      }
      if (p === "profiles/save") {
        const body = init && init.body ? JSON.parse(init.body) : null;
        (globalThis.__API__.saveCalls = globalThis.__API__.saveCalls || []).push(body);
        return res(s.save || { saved: true });
      }
      return res({});
    },
  },
  clipboard: { writeText: async () => {} },
  external: { open: async () => {} },
  resources: { pick: async () => ({ resources: [] }) },
};
`;

function runningStatus() {
  return {
    state: "running",
    profile: { id: "p1", name: "default", type: "local" },
    profiles: [{ id: "p1", name: "default", type: "local", ready: true, missing: [] }],
    activeProfileId: "p1",
    version: { checkState: "checked", local: "0.1.40", latest: "0.1.44.1" },
    network: { lanExposed: false, addressUrl: "http://127.0.0.1:8080" },
    model: "test-model",
    port: 8080,
    uptime_s: 100,
    configCandidates: [],
    metrics: { tg: 12, pp: 345, expertCacheHit: 80, kvHit: 90 },
    log: { lines: ["[strata] ready"] },
    resources: { gpu: { usedGiB: 2, totalGiB: 8 }, mem: { usedGiB: 4, totalGiB: 16 } },
  };
}

function stoppedStatus() {
  return {
    state: "stopped",
    // The current environment is not startable (its Strata directory is empty).
    profile: { id: "p1", name: "default", type: "local", ready: false, missing: ["strataDir"] },
    profiles: [
      { id: "p1", name: "default", type: "local", ready: false, missing: ["strataDir"] },
      { id: "p2", name: "alt", type: "local", ready: true, missing: [] },
      { id: "p3", name: "dockertest", type: "container", ready: true, missing: [] },
    ],
    activeProfileId: "p1",
    version: { checkState: "checked", local: "0.1.40", latest: "0.1.44.1" },
    network: null,
    port: 8080,
    launch: { method: "local", canStart: false, canChoose: false, allowed: ["local"], localReady: false, reason: "unconfigured" },
    configCandidates: [],
    log: { lines: [] },
    resources: {},
  };
}

// After switching the current environment to the container profile "dockertest"
// (the reported, fully filled case): the env AND the cards must follow.
function switchedStatus() {
  return {
    ...stoppedStatus(),
    profile: { id: "p3", name: "dockertest", type: "container", ready: true, missing: [] },
    activeProfileId: "p3",
    launch: { method: "docker", canStart: true, canChoose: false, allowed: ["docker"], localReady: false, reason: null },
  };
}

function setupStatus() {
  return {
    state: "unconfigured",
    profile: { id: "p1", name: "default", type: "local" },
    profiles: [{ id: "p1", name: "default", type: "local" }],
    activeProfileId: "p1",
    version: { checkState: "checked", local: null, latest: null },
    network: null,
    configCandidates: [],
    log: { lines: [] },
    resources: {},
  };
}

test(
  "panel running=read-only — behaviour in a real DOM (requires jsdom)",
  { skip: JSDOM ? false : "jsdom is not installed (this repo is dependency-free by design); add it as a devDependency to enable this behavioural layer" },
  async () => {
    const { window } = new JSDOM(panelHtml, { url: "http://localhost/", pretendToBeVisual: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strata-panel-"));
    fs.writeFileSync(path.join(tmp, "sdk.js"), STUB_SDK);
    fs.copyFileSync(path.join(ROOT, "ui/assets/panel.js"), path.join(tmp, "panel.js"));
    fs.copyFileSync(path.join(ROOT, "ui/assets/i18n.js"), path.join(tmp, "i18n.js"));

    const saved = ["window", "document", "navigator", "localStorage", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"];
    const restore = {};
    for (const k of saved) restore[k] = Object.getOwnPropertyDescriptor(globalThis, k);

    const pin = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    globalThis.window = window;
    globalThis.document = window.document;
    pin("navigator", window.navigator);
    pin("localStorage", window.localStorage);
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Event = window.Event;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.MouseEvent = window.MouseEvent;

    const $ = (id) => window.document.getElementById(id);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const waitFor = async (pred, tries = 80) => {
      for (let i = 0; i < tries; i++) {
        if (pred()) return true;
        await tick();
      }
      return pred();
    };
    const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const esc = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    try {
      globalThis.__API__ = {
        status: runningStatus(),
        profiles: {
          profiles: [{ id: "p1", name: "default", type: "local", strataDir: "/srv/Strata", pythonPath: "python3", gpu: "", ggufDir: "/models/x", configFile: "", port: 8080 }],
          activeProfileId: "p1",
        },
        settings: { hasConfig: true, values: {}, configFile: "" },
      };

      await import(pathToFileURL(path.join(tmp, "panel.js")).href);
      await waitFor(() => $("profileBadge").hidden === false && $("profileBadge").disabled === false);

      // Running state.
      assert.equal($("settingsBox").hidden, true, "parameter editor must be hidden while running");
      assert.ok(($("versionRows").textContent || "").includes("0.1.44.1"), "version row keeps the available version");
      assert.equal($("versionRows").querySelector(".update-btn"), null, "no update button while running");
      assert.ok(($("versionRows").textContent || "").includes("Stop the service to update"), "running update row carries the hint");
      assert.equal($("profileBadge").hidden, false, "badge visible while running");
      assert.equal($("profileBadge").disabled, false, "badge clickable while running");
      assert.equal($("actionBtn").hidden, false, "start/stop button still present");

      // Sections with content while running stay visible (unchanged behaviour).
      assert.equal($("speedBox").hidden, false, "performance shown while running");
      assert.equal($("resourceBox").hidden, false, "resources shown while running");
      assert.equal($("logsBox").hidden, false, "logs shown while running");
      assert.equal($("modelRow").hidden, false, "model row shown while running");
      assert.equal($("profileEditBtn").hidden, true, "no edit entry while running");
      assert.equal($("uptimeRow").hidden, false, "uptime row shown while running");

      // Badge -> read-only drawer.
      click($("profileBadge"));
      await waitFor(() => $("profileDrawer").hidden === false);
      assert.equal($("profileDrawerScrim").hidden, false, "scrim shown");
      assert.ok($("profileDrawerBody").contains($("psEditor")), "#psEditor moved into the drawer");
      const fields = [...$("psEditor").querySelectorAll("input, select")];
      assert.ok(fields.length > 0 && fields.every((f) => f.disabled), "every editor field disabled in the drawer");
      assert.equal($("psEditor").querySelector(".edit-actions"), null, "no save/cancel row exists in the read-only editor");
      assert.equal($("profileDrawerActions").hidden, true, "the read-only view has no save action");

      // The ~5s poll must not close the drawer on its own.
      const runsBefore = globalThis.__API__.statusCalls || 0;
      click($("refreshBtn"));
      await waitFor(() => (globalThis.__API__.statusCalls || 0) > runsBefore);
      assert.equal($("profileDrawer").hidden, false, "a poll refresh must not close the read-only drawer");

      // Three dismissal paths.
      click($("profileDrawerClose"));
      await waitFor(() => $("profileDrawer").hidden === true);
      assert.equal($("profileDrawerScrim").hidden, true, "x closes the drawer");
      assert.equal($("profileDrawerBody").children.length, 0, "#psEditor left the drawer body");

      click($("profileBadge"));
      await waitFor(() => $("profileDrawer").hidden === false);
      esc();
      await waitFor(() => $("profileDrawer").hidden === true);
      assert.equal($("profileDrawer").hidden, true, "Escape closes the drawer");

      click($("profileBadge"));
      await waitFor(() => $("profileDrawer").hidden === false);
      click($("profileDrawerScrim"));
      await waitFor(() => $("profileDrawer").hidden === true);
      assert.equal($("profileDrawer").hidden, true, "scrim click closes the drawer");

      // Stopped state.
      globalThis.__API__.status = stoppedStatus();
      click($("refreshBtn"));
      await waitFor(() => $("settingsBox").hidden === false);
      assert.equal($("settingsBox").hidden, false, "parameter editor reappears when stopped");

      // No content → the section is hidden, not parked as a "—" placeholder.
      assert.equal($("speedBox").hidden, true, "no performance section while stopped");
      assert.equal($("resourceBox").hidden, true, "no whole-machine resources while stopped");
      assert.equal($("logsBox").hidden, true, "no logs section while stopped");
      assert.equal($("modelRow").hidden, true, "no model row while stopped");
      assert.equal($("uptimeRow").hidden, true, "no uptime row while stopped");
      assert.equal($("portRow").hidden, false, "the configured port still shows while stopped");
      assert.equal($("configBox").hidden, false, "service config still shows while stopped");
      assert.equal($("versionBox").hidden, false, "version still shows while stopped");
      assert.ok($("versionRows").querySelector(".update-btn"), "update button reappears when stopped");
      // While stopped the header shows the PICKER, not the badge, and the
      // picker reflects the current environment.
      assert.equal($("profileBadge").hidden, true, "the badge is hidden while stopped");
      assert.equal($("envSelect").hidden, false, "the picker is shown while stopped");
      assert.equal($("envSelect").value, "p1", "the picker reflects the current environment");
      assert.equal($("envSelect").options.length, 3, "every environment is offered");

      // "Cannot start" is about the CURRENT environment, and the hint hangs on
      // the status card next to the start button, naming the missing field.
      assert.equal($("actionBtn").hidden, false, "start button still present when stopped");
      assert.equal($("actionBtn").disabled, true, "a not-ready environment disables start");
      assert.equal($("startOptionsHint").hidden, false, "the not-ready hint is shown");
      assert.match($("startOptionsHint").textContent, /Strata directory/, "the hint names the missing field");

      // Switching the environment persists the choice AND refreshes every card.
      globalThis.__API__.select = {
        status: switchedStatus(),
        profiles: {
          profiles: [{ id: "p3", name: "dockertest", type: "container", image: "strata:latest", containerName: "strata", dataDir: "/data/strata-docker-config", ggufDir: "", port: 0, configFile: "" }],
          activeProfileId: "p3",
        },
      };
      const sel = $("envSelect");
      sel.value = "p3";
      sel.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitFor(() => /dockertest/.test($("configRows").textContent || ""));
      assert.deepEqual(globalThis.__API__.selectCalls, ["p3"], "the choice was persisted via POST /profiles/select");
      assert.equal($("envSelect").value, "p3", "the picker follows the new environment");
      assert.match($("configRows").textContent || "", /dockertest/, "the service-config card followed the new environment");
      assert.equal($("actionBtn").disabled, false, "a ready environment enables start");
      assert.equal($("startOptionsHint").hidden, true, "no 'cannot start' hint for a ready environment");

      // The header pencil opens the SAME drawer, editable, for the current
      // environment; saving goes through the existing route and refreshes.
      assert.equal($("profileEditBtn").hidden, false, "the edit entry is offered while stopped");
      click($("profileEditBtn"));
      await waitFor(() => $("profileDrawer").hidden === false);
      assert.equal($("profileDrawerActions").hidden, false, "the editable view shows a save action");
      assert.equal($("profileDrawerTitle").textContent, "Edit profile", "the editable view is titled as editing");
      assert.ok(
        [...$("psEditor").querySelectorAll("input, select")].every((f) => !f.disabled),
        "the fields are editable",
      );

      // A poll must neither close the editing drawer nor disturb the fields.
      $("ps-name").focus();
      const activeBefore = window.document.activeElement;
      const fieldState = [...$("psEditor").querySelectorAll("input, select")].map((f) => f.disabled);
      const stoppedBefore = globalThis.__API__.statusCalls || 0;
      click($("refreshBtn"));
      await waitFor(() => (globalThis.__API__.statusCalls || 0) > stoppedBefore);
      assert.equal($("profileDrawer").hidden, false, "a poll refresh must not close the editing drawer");
      assert.equal($("profileDrawerActions").hidden, false, "the editing view stays editable across a poll");
      assert.ok($("profileDrawerBody").contains($("psEditor")), "#psEditor stays in the drawer across a poll");
      assert.equal(window.document.activeElement, activeBefore, "focus survives a poll");
      assert.deepEqual(
        [...$("psEditor").querySelectorAll("input, select")].map((f) => f.disabled),
        fieldState,
        "field state is unchanged across a poll",
      );

      click($("profileDrawerSave"));
      await waitFor(() => $("profileDrawer").hidden === true);
      assert.equal(globalThis.__API__.saveCalls.length, 1, "save went through POST /profiles/save");
      assert.equal(globalThis.__API__.saveCalls[0].id, "p3", "the CURRENT environment was edited");
      assert.equal(globalThis.__API__.saveCalls[0].type, "container", "the edited fields were sent");

      // The gear + the in-panel profile manager are gone; nothing shows while stopped.
      assert.equal($("configBtn"), null, "gear button removed from the panel");
      assert.equal($("statusConfigBox").hidden, true, "no config box / notice while stopped");

      // A setup state shows a plain-text pointer, and mounts no editor at all.
      globalThis.__API__.status = setupStatus();
      click($("refreshBtn"));
      await waitFor(() => $("statusConfigBox").hidden === false);
      assert.equal($("statusConfigBox").hidden, false, "setup notice shown in a setup state");
      assert.ok(($("setupNotice").textContent || "").trim().length > 0, "setup notice carries copy");
      assert.equal($("profileBadge").hidden, true, "profile badge hidden in a setup state");
      assert.equal($("envSelect").hidden, false, "the picker is shown in a setup state too");
      assert.equal($("profileDrawerBody").children.length, 0, "no editor is mounted in the panel");
    } finally {
      // The panel schedules a poll timer; fire its beforeunload cleanup so the
      // test process can exit, then tear everything down.
      try {
        window.dispatchEvent(new window.Event("beforeunload"));
      } catch {
        /* ignore */
      }
      window.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const k of saved) {
        if (restore[k]) Object.defineProperty(globalThis, k, restore[k]);
        else delete globalThis[k];
      }
      delete globalThis.__API__;
    }
  },
);
