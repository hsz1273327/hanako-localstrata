// Strata — the SLIM view.
//
// One route serves two hosts: the canvas card the user drags onto a page, and the
// right-hand function panel (`contributes.cards[].functionPanel`). Both are narrow,
// so both get the same three things: state, speed, start/stop. The full page
// (/panel.html: navigation, config, logs, the parameter editor) is a separate
// document on purpose — it boots ~2.5k lines of editor/drawer logic that a glanceable
// card must not pay for.
//
// Backend: exactly the two routes the full panel already uses — GET /status and
// POST /start|/stop. Nothing new.
import { hana } from "./sdk.js";
import { loadLang, setLang, t, tp, applyI18n } from "./i18n.js";

setLang(loadLang());

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await hana.api.fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const els = {
  dot: document.getElementById("slimDot"),
  state: document.getElementById("slimState"),
  scope: document.getElementById("slimScope"),
  tg: document.getElementById("slimTg"),
  pp: document.getElementById("slimPp"),
  start: document.getElementById("slimStart"),
  stop: document.getElementById("slimStop"),
  modelLine: document.getElementById("slimModelLine"),
  modelPre: document.getElementById("slimModelPre"),
  modelSuf: document.getElementById("slimModelSuf"),
  vision: document.getElementById("slimVision"),
  msg: document.getElementById("slimMsg"),
};

const RUNNING = new Set(["running", "starting", "stopping", "restarting"]);
const STATE_KEYS = {
  running: "state.running",
  starting: "state.starting",
  stopping: "state.stopping",
  restarting: "state.restarting",
  unconfigured: "state.unconfigured",
  "not-installed": "state.notInstalled",
  "python-missing": "state.pythonMissing",
  "needs-config": "state.needsConfig",
  "no-config": "state.noConfig",
};

const state = { status: null, working: false, refreshSec: 5, facts: { model: "", vision: null } };

// ── The model, and whether it reads images ──────────────────────────────────
//
// Neither is on /status: the model name comes from the config view (`setup.model`,
// lib/deployer/common.js:585 via setupFacts), the vision state from /profiles
// (`vision.available`, common.js:1352 readVisionInfo). Both are one-shot reads at
// boot, retried on a later poll if they failed — never part of the 5 s loop.
//
// The name is split at its LAST hyphen so a narrow card truncates the family prefix
// and keeps the quantization (`…ud-iq4_xs`), which is the part that identifies the
// size: an ellipsis that ate the suffix would leave "qwen3.8-…" on every row.
function splitModel(name) {
  const text = String(name || "").trim();
  if (!text) return null;
  const at = text.lastIndexOf("-");
  if (at <= 0) return { pre: text, suf: "" };
  return { pre: text.slice(0, at + 1), suf: text.slice(at + 1) };
}

async function loadFacts() {
  const [settings, profiles] = await Promise.allSettled([api("settings"), api("profiles")]);
  if (settings.status === "fulfilled") {
    const model = String(settings.value?.setup?.model || "").trim();
    if (model) state.facts.model = model;
  }
  if (profiles.status === "fulfilled") {
    const v = profiles.value?.vision;
    if (v && typeof v === "object") state.facts.vision = v.available === true;
  }
  paintFacts();
}

function paintFacts() {
  // No model (no config / setup not run) shows an em dash rather than an empty line: a
  // missing row would read as "this card is broken", which is a different fact.
  const parts = splitModel(state.facts.model) || { pre: "—", suf: "" };
  els.modelLine.hidden = false;
  els.modelPre.textContent = parts.pre;
  els.modelSuf.textContent = parts.suf;
  els.modelLine.title = state.facts.model || "";
  // The eye: an icon whose SHAPE says it (slash = off) and whose colour confirms it.
  // The two i18n keys are the accessible label and the hover text — the same words the
  // pill used to show, now spoken instead of written.
  const vision = state.facts.vision;
  const on = vision === true;
  els.vision.hidden = vision === null || !state.facts.model;
  els.vision.className = `slim-vision${on ? " on" : ""}`;
  const label = vision === null ? "" : t(on ? "card.vision" : "card.noVision");
  els.vision.setAttribute("aria-label", label);
  els.vision.title = label;
}

// ── Errors: host codes are not sentences ─────────────────────────────────────
//
// The host answers with codes (`app_surface_session_expired`, …). Showing one raw is
// what put a red `app_surface_session_expired` on the card for a whole night. They map
// to four short sentences; prose (our own backend's errors) passes through untouched.
//
// A surface session cannot be renewed from here: the token arrives in the iframe URL
// (`readSurfaceSession`, ui/assets/sdk.js:2344) and is sent as
// `X-Hana-App-Surface-Session` (:2403) — there is no setter and no re-handshake call.
// So an expired session is fixed by a NEW iframe (close and reopen the card); what we
// can do is retry once in case the host was only restarting, then stop hammering.
const ERROR_KEYS = [
  [/^app_surface_session_/, "card.errSession"],
  [/^app_uninstalled$|^app_unloaded$|^app_disabled$/, "card.errUnavailable"],
  [/^app_runtime_stopped$|^app_service_/, "card.errRuntime"],
  [/^app_role_unavailable$|^app_capability_/, "card.errDenied"],
];

function isSessionError(raw) {
  return /^app_surface_session_/.test(String(raw || "").trim());
}

// A code is a single lowercase identifier; anything with a space or a CJK sentence in
// it is already human text and is left alone.
function describeError(raw) {
  const text = String(raw || "").trim();
  if (!/^[a-z][a-z0-9_.:-]*$/.test(text)) return text;
  for (const [re, key] of ERROR_KEYS) if (re.test(text)) return t(key);
  return tp("card.errGeneric", { code: text });
}

function rate(value) {
  return Number.isFinite(value) ? `${value} t/s` : "—";
}

function setMessage(text) {
  els.msg.textContent = text || "";
  els.msg.hidden = !text;
}

function paint(s) {
  state.status = s;
  const running = RUNNING.has(s.state);
  const busy = s.state === "starting" || s.state === "stopping" || s.state === "restarting";
  els.dot.className = `dot ${s.state === "running" ? "running" : busy ? "starting" : "stopped"}`;
  els.state.textContent = t(STATE_KEYS[s.state] || "state.stopped");
  // REACH: whether this service answers only on this machine or on the LAN too.
  // The host already computes it (`status.network`: lib/deployer/common.js:1401
  // buildNetwork → listenAddr/lanExposed/addressUrl, with isLanExposedAddr at :1277),
  // so this is a display of a fact, not a probe.
  const net = s.network;
  if (net && typeof net === "object") {
    const lan = net.lanExposed === true;
    els.scope.hidden = false;
    els.scope.className = `slim-scope${lan ? " lan" : ""}`;
    els.scope.textContent = t(lan ? "card.scopeLan" : "card.scopeLocal");
    const url = String(net.addressUrl || net.listenAddr || "");
    els.scope.title = url;
  } else {
    els.scope.hidden = true;
    els.scope.textContent = "";
    els.scope.title = "";
  }
  els.tg.textContent = rate(s.metrics?.tg);
  els.pp.textContent = rate(s.metrics?.pp);
  // Only the action that makes sense right now is offered.
  els.start.hidden = running;
  els.stop.hidden = !running;
  els.start.disabled = state.working || busy;
  els.stop.disabled = state.working || busy;
  if (Number.isFinite(s.refreshSec) && s.refreshSec >= 2) state.refreshSec = s.refreshSec;
  if (!state.working) setMessage(s.error ? describeError(s.error) : "");
}

// Polling backs off while the surface session is broken (×4, up to 60 s) instead of
// hammering a dead session every 5 s — but it never stops, so a host that comes back
// clears the message on its own.
let slowPoll = false;

async function refresh() {
  try {
    paint(await api("status"));
    slowPoll = false;
    // The model/vision read is one-shot; if it failed at boot (a race with the
    // host's own start), pick it up on the first poll that gets through.
    if (!state.facts.model) loadFacts().catch(() => {});
    return;
  } catch (e) {
    const raw = String(e?.message || e);
    if (isSessionError(raw)) {
      // One retry: a host restart or a reload race throws this for a moment.
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        paint(await api("status"));
        slowPoll = false;
        return;
      } catch {
        slowPoll = true;
      }
    }
    setMessage(describeError(raw));
  }
}

async function act(verb) {
  if (state.working) return;
  state.working = true;
  setMessage("");
  paint(state.status || { state: "stopped" });
  try {
    await api(verb, { method: "POST" });
    await refresh();
  } catch (e) {
    setMessage(describeError(String(e?.message || e)));
  } finally {
    state.working = false;
    await refresh();
    schedule();
  }
}

let timer = null;
function schedule() {
  window.clearTimeout(timer);
  const base = state.refreshSec * (slowPoll ? 4 : 1);
  const ms = Math.min(Math.max(2, base), 60) * 1000;
  timer = window.setTimeout(async () => {
    if (!state.working && !document.hidden) await refresh();
    schedule();
  }, ms);
}

els.start.addEventListener("click", () => act("start"));
els.stop.addEventListener("click", () => act("stop"));

applyI18n();
await hana.ready();
await refresh();
// Once, not per poll: the installed model and its vision state only change when a
// setup run rebuilds the config.
await loadFacts().catch(() => {});
schedule();
