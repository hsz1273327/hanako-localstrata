// Strata Console — the right function panel (narrow).
//
// This is the App's `contributes.cards[].functionPanel` route: it renders in the
// host's right-hand panel and follows whichever of this App's cards is active on a
// PAGE surface (the host's own rule: the panel list is empty unless the active
// surface has `acceptsFunctionPanelContributions` — see
// docs/dev/v2-sidebar-notes.md for the exact call sites).
//
// Same backend as the full panel: GET /status, POST /start, POST /stop. Nothing
// here is a second API — the narrow view just shows less.
import { hana } from "./sdk.js";
import { loadLang, setLang, t, applyI18n } from "./i18n.js";

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
  dot: document.getElementById("sideDot"),
  state: document.getElementById("sideState"),
  port: document.getElementById("sidePort"),
  tg: document.getElementById("sideTg"),
  pp: document.getElementById("sidePp"),
  gpu: document.getElementById("sideGpu"),
  mem: document.getElementById("sideMem"),
  start: document.getElementById("sideStart"),
  stop: document.getElementById("sideStop"),
  open: document.getElementById("sideOpen"),
  msg: document.getElementById("sideMsg"),
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

const state = { status: null, working: false, refreshSec: 5 };

function rate(value) {
  return Number.isFinite(value) ? `${value} t/s` : "—";
}

function usage(res) {
  if (!res || !Number.isFinite(res.totalGiB)) return "—";
  return `${res.usedGiB} / ${res.totalGiB} GB`;
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
  els.port.textContent = Number.isFinite(s.port) ? `:${s.port}` : "";
  els.tg.textContent = rate(s.metrics?.tg);
  els.pp.textContent = rate(s.metrics?.pp);
  els.gpu.textContent = usage(s.resources?.gpu);
  els.mem.textContent = usage(s.resources?.mem);
  // Only the action that makes sense right now is offered.
  els.start.hidden = running;
  els.stop.hidden = !running;
  els.start.disabled = state.working || busy;
  els.stop.disabled = state.working || busy;
  if (Number.isFinite(s.refreshSec) && s.refreshSec >= 2) state.refreshSec = s.refreshSec;
  if (!state.working) setMessage(s.error || "");
}

async function refresh() {
  try {
    paint(await api("status"));
  } catch (e) {
    setMessage(String(e?.message || e));
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
    setMessage(String(e?.message || e));
  } finally {
    state.working = false;
    await refresh();
    schedule();
  }
}

let timer = null;
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    if (!state.working && !document.hidden) await refresh();
    schedule();
  }, state.refreshSec * 1000);
}

els.start.addEventListener("click", () => act("start"));
els.stop.addEventListener("click", () => act("stop"));
// Back to the full panel: the SDK's own card navigation (same App, card id "panel").
els.open.addEventListener("click", () => {
  Promise.resolve(hana.cards.open("panel")).catch((e) => setMessage(String(e?.message || e)));
});

applyI18n();
await hana.ready();
await refresh();
schedule();
