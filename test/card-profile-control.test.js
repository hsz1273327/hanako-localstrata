// The slim card's environment control.
//
// The card (ui/card.html + ui/assets/card.js) is a 300–360 px iframe, so the "which
// environment" control has to answer the same question as the full page's header —
// pick while the service is down, report while it runs — without a badge that opens a
// drawer. Both hosts share ui/assets/profile-picker.js; this file pins the three states
// the card renders, the option list that must not be rebuilt under the user's hand, and
// the one request that persists a switch.
//
// Layers, honestly:
//   1. pure decisions   — profileControlPlan / canSelectProfile, no DOM at all
//   2. option list      — renderProfileOptions against a tiny DOM stub (this repo has
//                         no jsdom by design; the stub carries only the calls it makes)
//   3. the request      — requestProfileSelect with a fake api(): the route, the body,
//                         and the fact that nothing here touches fetch
//   4. wiring guards    — the card's own source: paintProfile is called from paint, the
//                         change listener reaches selectEnv, and a missing profile view
//                         hides the whole block instead of leaving an empty shell
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canSelectProfile,
  isServiceRunning,
  profileControlPlan,
  profileOptionText,
  profileTypeLabel,
  renderProfileOptions,
  requestProfileSelect,
} from "../ui/assets/profile-picker.js";
import { STRINGS, LANGS, setLang } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const cardHtml = read("ui/card.html");
const cardJs = read("ui/assets/card.js");
const cardCss = read("ui/assets/card.css");
const pickerJs = read("ui/assets/profile-picker.js");

const LOCAL = { id: "p1", name: "default", type: "local" };
const CONTAINER = { id: "p2", name: "docker · test environment with a long name", type: "container" };

// ── 1. the three states, as decisions ──────────────────────────────────────

test("stopped: the control is a picker, on the current profile", () => {
  const plan = profileControlPlan({
    state: "stopped",
    profile: LOCAL,
    activeProfileId: "p1",
    working: false,
  });
  assert.equal(plan.show, true);
  assert.equal(plan.mode, "picker");
  assert.equal(plan.selectedId, "p1", "the picker opens on the environment that would start");
  assert.equal(plan.disabled, false);
});

test("running (and starting/stopping/restarting): the control is read-only", () => {
  for (const state of ["running", "starting", "stopping", "restarting"]) {
    const plan = profileControlPlan({ state, profile: CONTAINER, activeProfileId: "p2", working: false });
    assert.equal(plan.show, true, `${state}: the environment is still named`);
    assert.equal(plan.mode, "readonly", `${state}: no dropdown while a service exists`);
    assert.equal(plan.name, CONTAINER.name);
    assert.equal(plan.typeLabel, profileTypeLabel("container"));
    assert.equal(plan.disabled, true, `${state}: and nothing to operate`);
  }
  // The state list is the same four the full page calls RUNNING_STATES.
  assert.equal(isServiceRunning("running"), true);
  assert.equal(isServiceRunning("stopped"), false);
  assert.equal(isServiceRunning(undefined), false);
});

test("unsupported, or no profile view: the whole block is hidden, not emptied", () => {
  for (const input of [
    { state: "unsupported", profile: LOCAL, activeProfileId: "p1" },
    { state: "stopped", profile: null, activeProfileId: "" },
    { state: "running", profile: undefined },
  ]) {
    const plan = profileControlPlan({ ...input, working: false });
    assert.equal(plan.show, false, `${input.state}/${input.profile}: nothing to show`);
    assert.equal(plan.mode, "none");
    assert.equal(plan.name, "");
    assert.equal(plan.typeLabel, "");
  }
});

test("while a switch is in flight the picker is disabled, not hidden", () => {
  const plan = profileControlPlan({ state: "stopped", profile: LOCAL, activeProfileId: "p1", working: true });
  assert.equal(plan.mode, "picker", "the choice stays visible so the card does not jump");
  assert.equal(plan.disabled, true, "but it cannot be operated twice");
});

test("the guard refuses the pointless round trips the backend would refuse too", () => {
  assert.equal(canSelectProfile({ working: false, id: "p2", activeId: "p1" }), true);
  assert.equal(canSelectProfile({ working: true, id: "p2", activeId: "p1" }), false, "one at a time");
  assert.equal(canSelectProfile({ working: false, id: "", activeId: "p1" }), false, "no empty id");
  assert.equal(canSelectProfile({ working: false, id: "p1", activeId: "p1" }), false, "already current");
});

// ── 2. the option list ─────────────────────────────────────────────────────

function makeSelect() {
  // Only what renderProfileOptions calls: replaceChildren / append / value / options.
  const select = {
    tagName: "SELECT",
    children: [],
    _text: "",
    _value: "",
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this.children = [];
      this._text = String(v);
    },
    get options() {
      return this.children.filter((c) => c.tagName === "OPTION");
    },
    get value() {
      return this._value;
    },
    set value(v) {
      this._value = String(v);
    },
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this._text = "";
      this.append(...nodes);
    },
    append(...nodes) {
      for (const n of nodes) {
        if (!n) continue;
        n.parent = this;
        this.children.push(n);
      }
    },
  };
  return select;
}

const makeDocument = () => ({
  createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: "", value: "", parent: null }),
});

test("the picker lists each profile as name · type", () => {
  const prev = globalThis.document;
  globalThis.document = makeDocument();
  try {
    setLang("en");
    const select = makeSelect();
    const rebuilt = renderProfileOptions(select, [LOCAL, CONTAINER], { key: "" });
    assert.equal(rebuilt, true);
    assert.equal(select.options.length, 2);
    assert.deepEqual(
      select.options.map((o) => o.textContent),
      ["default · Local (source)", `${CONTAINER.name} · Container (Docker)`],
    );
    assert.deepEqual(select.options.map((o) => o.value), ["p1", "p2"]);
    assert.equal(select.value, "", "the caller sets the current id afterwards (as both hosts do)");
  } finally {
    globalThis.document = prev;
  }
});

test("a poll with the same profiles never rebuilds the list", () => {
  const prev = globalThis.document;
  globalThis.document = makeDocument();
  try {
    const cache = { key: "" };
    const select = makeSelect();
    renderProfileOptions(select, [LOCAL, CONTAINER], cache);
    const painted = [...select.options];
    // The user's own selection must survive a poll: not just the same options, the same
    // NODES (a rebuild closes a native dropdown that is open right now).
    select.value = "p2";
    assert.equal(renderProfileOptions(select, [LOCAL, CONTAINER], cache), false);
    assert.equal(select.options[0], painted[0], "same option nodes, untouched");
    assert.equal(select.options[1], painted[1], "same option nodes, untouched");
    assert.equal(select.value, "p2", "and the selection is still the user's");

    // A rename, an add or a removal changes the key and does rebuild.
    assert.equal(renderProfileOptions(select, [LOCAL, { ...CONTAINER, name: "renamed" }], cache), true);
    assert.equal(select.options[1].textContent, `renamed · Container (Docker)`);
  } finally {
    globalThis.document = prev;
  }
});

test("the option text and the type label survive a locale change", () => {
  const prev = globalThis.document;
  globalThis.document = makeDocument();
  try {
    setLang("zh");
    assert.match(profileOptionText(LOCAL), /default · /);
    assert.equal(profileOptionText(LOCAL).includes("本机"), true, "the type is localised, the name is not");
    assert.equal(profileOptionText({ id: "x" }).startsWith("x · "), true, "a nameless profile falls back to its id");
  } finally {
    setLang("en");
    globalThis.document = prev;
  }
});

// ── 3. the request ─────────────────────────────────────────────────────────

test("switching calls POST /profiles/select with the id, through the caller's api()", async () => {
  const calls = [];
  const fakeApi = async (route, init) => {
    calls.push({ route, init });
    return { saved: true, activeProfileId: "p2" };
  };
  const out = await requestProfileSelect(fakeApi, "p2");
  assert.deepEqual(out, { saved: true, activeProfileId: "p2" }, "the reply is handed back");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "profiles/select", "the route the full page already used");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: "p2" });
  // No second transport: the route is not reached with fetch() from the UI.
  assert.doesNotMatch(pickerJs, /(^|[^.\w])fetch\s*\(/, "the shared module never talks to fetch");
});

// ── 4. the card's own wiring ───────────────────────────────────────────────

test("the card paints the control from the shared plan, and repaints it on every status", () => {
  assert.match(cardJs, /import \{[^}]*profileControlPlan[^}]*\} from "\.\/profile-picker\.js"/);
  assert.match(cardJs, /import \{[^}]*renderProfileOptions[^}]*\} from "\.\/profile-picker\.js"/);
  assert.match(cardJs, /function paintProfile\(s\) \{/);
  assert.match(cardJs, /const plan = profileControlPlan\(\{/, "the three states are the shared decision");
  assert.match(cardJs, /paintProfile\(s\);/, "paint() drives it, so state/speeds/model and the control move together");
  // Hidden means hidden: the block, the picker and the read-only line are toggled by mode.
  assert.match(cardJs, /els\.profile\.hidden = !plan\.show;/);
  assert.match(cardJs, /els\.envWrap\.hidden = plan\.mode !== "picker";/);
  assert.match(cardJs, /els\.profileView\.hidden = plan\.mode !== "readonly";/);
});

test("a switch persists through the shared request and then repaints the whole card", () => {
  assert.match(cardJs, /els\.env\.addEventListener\("change", \(\) => selectEnv\(els\.env\.value\)\)/);
  assert.match(cardJs, /async function selectEnv\(id\) \{/);
  assert.match(cardJs, /if \(!canSelectProfile\(\{ working: state\.working, id, activeId: state\.status\?\.activeProfileId \}\)\) return;/);
  assert.match(cardJs, /await requestProfileSelect\(api, id\)/, "the card's api() carries the ticket");
  assert.doesNotMatch(cardJs, /(^|[^.\w])fetch\s*\(/, "no bare fetch in the card either");
  // After the switch: status first, then the boot-time facts (model + vision belong to
  // the environment), then a fresh poll timer.
  const body = cardJs.slice(cardJs.indexOf("async function selectEnv(id)"));
  const done = body.slice(0, body.indexOf("\n}\n"));
  assert.match(done, /await refresh\(\);/);
  assert.match(done, /state\.facts = \{ model: "", vision: null \};/);
  assert.match(done, /await loadFacts\(\)/);
  assert.match(done, /schedule\(\);/);
});

test("the card's markup carries the picker and the read-only line, and hides both by default", () => {
  assert.match(cardHtml, /<div id="slimProfile" class="slim-profile" hidden>/);
  assert.match(cardHtml, /<span id="slimEnvWrap"[^>]*hidden>/);
  assert.match(cardHtml, /<select id="slimEnv"[^>]*data-i18n-aria-label="profile\.selectEnv"/);
  assert.match(cardHtml, /<p id="slimProfileView" class="slim-profile-view" hidden>/);
  assert.match(cardHtml, /<span id="slimProfileName"/);
  assert.match(cardHtml, /<span id="slimProfileType"/);
  // The behaviour the ids exist for is in card.js, not just in the markup.
  for (const id of ["slimProfile", "slimEnvWrap", "slimEnv", "slimProfileView", "slimProfileName", "slimProfileType"]) {
    assert.ok(cardJs.includes(`getElementById("${id}")`), `card.js reads #${id}`);
  }
  // It sits between the state line and the model line: which service, then which model.
  const at = (marker) => cardHtml.indexOf(marker);
  assert.ok(at("slimState") < at("slimProfile"), "under the state line");
  assert.ok(at("slimProfile") < at("slimModelLine"), "above the model");
});

test("the style keeps it neutral, full-width and truncating (a 300–360 px card)", () => {
  const css = cardCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => {
    const m = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : "";
  };
  // Full width, and the name truncates while the type marker stays whole.
  assert.match(rule(".slim-env"), /width:\s*100%/);
  assert.match(rule(".slim-env"), /text-overflow:\s*ellipsis/);
  assert.match(rule(".slim-env"), /min-width:\s*0/);
  assert.match(rule(".slim-profile-name"), /text-overflow:\s*ellipsis/);
  assert.match(rule(".slim-profile-type"), /flex:\s*0 0 auto/);
  // The type marker is SMALL TEXT, not a control.
  assert.match(rule(".slim-profile-type"), /font-size:\s*11px/);
  assert.doesNotMatch(css, /\.slim-profile-type[^{]*\{[^}]*cursor:\s*pointer/);
  // No new accent: the block only uses the card's existing greys and its one accent for
  // the keyboard focus ring (the same ring .slim-btn has).
  const block = css.slice(css.indexOf(".slim-profile {"), css.indexOf(".slim-row {"));
  assert.ok(block.length > 100, "the profile block was found");
  assert.doesNotMatch(block, /--(?:green|amber|danger)/, "no status colour on a neutral control");
  assert.doesNotMatch(block, /background:\s*var\(--accent/);
  // And `[hidden]` actually hides: several blocks here carry their own `display`.
  assert.match(css, /\[hidden\] \{\s*display:\s*none !important;/);
});

test("the copy it reuses exists in all six locales", () => {
  assert.equal(LANGS.length, 6);
  for (const lang of LANGS) {
    const value = STRINGS[lang]?.["profile.selectEnv"];
    assert.equal(typeof value, "string", `${lang} is missing profile.selectEnv`);
    assert.ok(value.length > 0, `${lang}.profile.selectEnv must not be empty`);
  }
});
