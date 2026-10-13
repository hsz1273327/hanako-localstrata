// hanako-localstrata v2 card logic.
// - Handshake through the App UI SDK (hana.ready()).
// - Routes are called via hana.api.fetch (carries this App's surface session).
// - Clipboard / external links go through hana.clipboard / hana.external.
// - Polls this App's GET /status route every refreshSec seconds.
import { hana } from "./sdk.js";
import { LANGS, LANG_NAMES, loadLang, saveLang, setLang, getLang, t, tp, applyI18n } from "./i18n.js";

// Resolve the UI language before anything renders.
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
  unsupportedBox: document.getElementById("unsupportedBox"),
  unsupportedTitle: document.getElementById("unsupportedTitle"),
  unsupportedMessage: document.getElementById("unsupportedMessage"),
  unsupportedLink: document.getElementById("unsupportedLink"),
  statusCard: document.getElementById("statusCard"),
  dot: document.getElementById("dot"),
  stateText: document.getElementById("stateText"),
  netMode: document.getElementById("netMode"),
  model: document.getElementById("model"),
  uptime: document.getElementById("uptime"),
  port: document.getElementById("port"),
  versionRows: document.getElementById("versionRows"),
  configRows: document.getElementById("configRows"),
  speedRows: document.getElementById("speedRows"),
  logLines: document.getElementById("logLines"),
  gpuBar: document.getElementById("gpuBar"),
  gpuText: document.getElementById("gpuText"),
  memBar: document.getElementById("memBar"),
  memText: document.getElementById("memText"),
  modeBtn: document.getElementById("modeBtn"),
  actionBtn: document.getElementById("actionBtn"),
  panel: document.querySelector(".panel"),
  confirmPopover: document.getElementById("confirmPopover"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmSub: document.getElementById("confirmSub"),
  confirmOk: document.getElementById("confirmOk"),
  confirmCancel: document.getElementById("confirmCancel"),
  accessRows: document.getElementById("accessRows"),
  statusConfigBox: document.getElementById("statusConfigBox"),
  versionBox: document.getElementById("versionBox"),
  configBox: document.getElementById("configBox"),
  speedBox: document.getElementById("speedBox"),
  resourceBox: document.getElementById("resourceBox"),
  logsBox: document.getElementById("logsBox"),
  settingsBox: document.getElementById("settingsBox"),
  overlay: document.getElementById("overlay"),
  overlayText: document.getElementById("overlayText"),
  overlayStep: document.getElementById("overlayStep"),
  overlayHint: document.getElementById("overlayHint"),
  overlayForceRefresh: document.getElementById("overlayForceRefresh"),
  overlayLogBtn: document.getElementById("overlayLogBtn"),
  overlayLog: document.getElementById("overlayLog"),
  error: document.getElementById("error"),
  refreshBtn: document.getElementById("refreshBtn"),
  langSelect: document.getElementById("langSelect"),
  editForm: document.getElementById("editForm"),
  saveBtn: document.getElementById("saveBtn"),
  saveRestartBtn: document.getElementById("saveRestartBtn"),
  diffBox: document.getElementById("diffBox"),
  diffList: document.getElementById("diffList"),
  editMessage: document.getElementById("editMessage"),
};

const state = {
  status: null,
  config: null,
  working: false,
  formFilled: false,
  configFileFilled: null,
  pluginFormFilled: false,
  pluginFormDirty: false,
};

// States where setup still needs input; the inline status form / config picker
// replaces the normal info panels.
const SETUP_STATES = new Set(["unconfigured", "not-installed", "python-missing", "no-config", "needs-config"]);
let pollMs = 5000;
let timer = null;
let overlayTimer = null;

function fmtK(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function fmtGiB(mib) {
  if (!Number.isFinite(mib)) return "";
  const g = mib / 1024;
  return g >= 10 ? `${Math.round(g)}G` : `${Math.round(g * 10) / 10}G`;
}

function fmtUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Compare dotted numeric versions: "0.1.38" vs "0.1.40.3" → -1 / 0 / 1.
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Label-value rows: [[label, value, extraClass?, copyValue?, hint?, action?], ...]
// action = { label, onClick } renders a small button on the right.
function renderKvRows(el, rows, emptyText = "—") {
  el.replaceChildren();
  if (!rows.length) {
    el.textContent = emptyText;
    return;
  }
  for (const [k, v, cls, copyValue, hint, action] of rows) {
    const row = document.createElement("div");
    row.className = cls ? `kv-row ${cls}` : "kv-row";
    const kEl = document.createElement("span");
    kEl.className = "kv-k";
    kEl.textContent = k;
    const rightEl = document.createElement("span");
    rightEl.className = "kv-right";
    const vEl = document.createElement("span");
    vEl.className = "kv-v";
    vEl.textContent = v;
    vEl.title = v === undefined || v === null ? "" : String(v);
    rightEl.append(vEl);
    if (copyValue !== undefined && copyValue !== null) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.textContent = t("common.copy");
      btn.addEventListener("click", () => copyWithFeedback(btn, copyValue));
      rightEl.append(btn);
    }
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "update-btn";
      btn.textContent = action.label || t("common.update");
      btn.disabled = state.working;
      btn.addEventListener("click", () => action.onClick(btn));
      rightEl.append(btn);
    }
    row.append(kEl, rightEl);
    el.append(row);
    if (hint) {
      const h = document.createElement("div");
      h.className = "kv-hint";
      h.textContent = hint;
      el.append(h);
    }
  }
}

function showError(message) {
  els.error.textContent = message || "";
  els.error.hidden = !message;
}

function paintBar(barEl, textEl, res) {
  if (!res || !Number.isFinite(res.usedGiB) || !Number.isFinite(res.totalGiB) || res.totalGiB <= 0) {
    barEl.style.width = "0%";
    barEl.classList.remove("high");
    textEl.textContent = "—";
    return;
  }
  const pct = Math.min(100, (res.usedGiB / res.totalGiB) * 100);
  barEl.style.width = `${pct}%`;
  barEl.classList.toggle("high", pct >= 90);
  textEl.textContent = `${res.usedGiB.toFixed(1)}/${res.totalGiB.toFixed(1)}G`;
}

// ── Clipboard ────────────────────────────────────────────────────────────

let copyFeedbackTimer = null;

async function copyText(text) {
  // Host capability (app/ui.clipboard-write).
  try {
    await hana.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the browser clipboard */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to manual selection */
  }
  return false;
}

function selectForManualCopy(text) {
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.readOnly = true;
  holder.style.position = "fixed";
  holder.style.left = "-9999px";
  holder.style.top = "0";
  document.body.append(holder);
  holder.select();
  holder.setSelectionRange(0, text.length);
  window.setTimeout(() => holder.remove(), 1500);
}

async function copyWithFeedback(btn, text) {
  const label = btn.textContent;
  const ok = await copyText(text);
  if (ok) {
    btn.textContent = t("common.copied");
  } else {
    selectForManualCopy(text);
    btn.textContent = t("common.selected");
  }
  btn.classList.add("copied");
  window.clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = window.setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove("copied");
  }, 1500);
}

function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 16) return `${key.slice(0, 6)}…`;
  return `${key.slice(0, 16)}...`;
}

// Open an external URL through the host capability, falling back to a new tab.
async function openExternal(url) {
  try {
    await hana.external.open(url);
    return true;
  } catch {
    try {
      window.open(url, "_blank", "noopener");
      return true;
    } catch {
      return false;
    }
  }
}

function paintVersion(s) {
  const version = s?.version;
  const local = typeof version?.local === "string" ? version.local : null;
  const latest = typeof version?.latest === "string" ? version.latest : null;
  const rows = [[t("label.version"), local || "—"]];
  if (version?.checkState === "checked" && latest) {
    if (local && compareVersions(latest, local) > 0) {
      rows.push([
        t("label.latestVersion"),
        tp("version.available", { version: latest }),
        "update",
        undefined,
        undefined,
        { label: t("common.update"), onClick: (btn) => promptUpdate(latest, btn) },
      ]);
    } else if (local) {
      rows.push([t("label.latestVersion"), t("version.upToDate")]);
    } else {
      rows.push([t("label.latestVersion"), latest]);
    }
  } else if (version?.checkState === "error") {
    rows.push([t("label.latestVersion"), t("version.checkFailed")]);
  } else {
    rows.push([t("label.latestVersion"), t("version.checking")]);
  }
  renderKvRows(els.versionRows, rows);
}

function paintNetMode(s) {
  if (SETUP_STATES.has(s.state)) {
    els.netMode.hidden = true;
    return;
  }
  els.netMode.hidden = false;
  const lan = !!(s?.network?.lanExposed);
  els.netMode.textContent = lan ? t("netMode.lan") : t("netMode.local");
  els.netMode.className = `net-mode ${lan ? "lan" : "local"}`;
}

function renderAccessRow(container, label, value, copyValue, titleValue) {
  const block = document.createElement("div");
  block.className = "stat-block";

  const head = document.createElement("div");
  head.className = "stat-block-head";
  const labelEl = document.createElement("span");
  labelEl.className = "stat-block-label";
  labelEl.textContent = label;
  head.append(labelEl);

  if (copyValue !== undefined && copyValue !== null) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = t("common.copy");
    btn.addEventListener("click", () => copyWithFeedback(btn, copyValue));
    head.append(btn);
  }

  const v = document.createElement("div");
  v.className = "stat-block-value";
  v.textContent = value;
  if (titleValue !== undefined) {
    v.title = titleValue;
  }

  block.append(head, v);
  container.append(block);
}

function paintAccessInfo(s) {
  const network = s?.network;
  const show = !!network;
  els.accessRows.hidden = !show;
  els.accessRows.replaceChildren();
  if (!show) return;
  if (network.addressUrl) {
    renderAccessRow(els.accessRows, t("label.address"), network.addressUrl, network.addressUrl, network.addressUrl);
  }
  if (network.hasApiKey && network.apiKey) {
    renderAccessRow(els.accessRows, t("label.apiKey"), maskApiKey(network.apiKey), network.apiKey);
  }
}

function paintConfig(s) {
  const cs = s?.configSummary;
  const rows = [];
  if (Number.isFinite(cs?.context)) rows.push([t("label.context"), fmtK(cs.context)]);
  if (cs?.kv) rows.push([t("label.kv"), cs.kv]);
  if (Number.isFinite(cs?.sessionCache)) rows.push([t("label.sessionCache"), fmtGiB(cs.sessionCache)]);
  if (cs?.reasoningEffort) rows.push([t("label.reasoningEffort"), cs.reasoningEffort]);
  if (Number.isFinite(cs?.port)) rows.push([t("label.port"), String(cs.port)]);
  renderKvRows(els.configRows, rows);
}

function paintSpeeds(m) {
  const rows = [];
  if (Number.isFinite(m?.tg)) rows.push([t("label.tg"), `${m.tg} t/s`]);
  if (Number.isFinite(m?.pp)) rows.push([t("label.pp"), `${m.pp} t/s`]);
  if (Number.isFinite(m?.expertCacheHit)) rows.push([t("label.expertCache"), `${m.expertCacheHit}%`]);
  if (Number.isFinite(m?.kvHit)) rows.push([t("label.kvHit"), `${m.kvHit}%`]);
  renderKvRows(els.speedRows, rows);
}

function paintUptime(s) {
  const text = Number.isFinite(s?.uptime_s) ? fmtUptime(s.uptime_s) : "—";
  els.uptime.textContent = text;
}

function paintPort(s) {
  const text = Number.isFinite(s?.port) ? String(s.port) : "—";
  els.port.textContent = text;
}

function paintLogs(log) {
  const lines = log?.lines || [];
  els.logLines.textContent = lines.length ? lines.join("\n") : "—";
}

const ICONS = {
  start: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  starting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  lan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5L6.5 16.5M12 11.5l5.5 5"/></svg>',
};

function setActionIcon(btn, svg) {
  btn.innerHTML = svg;
}

async function doStop() {
  await act("stop");
}

async function doSwitchMode() {
  await switchMode(true);
}

function paintModeBtn(s) {
  const lan = !!(s?.network?.lanExposed);
  setActionIcon(els.modeBtn, lan ? ICONS.lan : ICONS.local);
  els.modeBtn.title = lan ? t("modeBtn.lan") : t("modeBtn.local");
  els.modeBtn.setAttribute("aria-label", els.modeBtn.title);
  els.modeBtn.disabled = state.working;
}

function paintActions(s) {
  if (SETUP_STATES.has(s.state)) {
    els.modeBtn.hidden = true;
    els.actionBtn.hidden = true;
    return;
  }

  const isRunning = s.state === "running";
  const isStarting = s.state === "starting";

  paintModeBtn(s);

  els.modeBtn.hidden = false;
  els.actionBtn.hidden = false;

  if (isRunning) {
    setActionIcon(els.actionBtn, ICONS.stop);
    els.actionBtn.className = "icon-btn status-action";
    els.actionBtn.title = t("action.stop");
    els.actionBtn.setAttribute("aria-label", t("action.stop"));
    els.actionBtn.disabled = state.working;
  } else if (isStarting) {
    setActionIcon(els.actionBtn, ICONS.starting);
    els.actionBtn.className = "icon-btn status-action spinning";
    els.actionBtn.title = t("action.starting");
    els.actionBtn.setAttribute("aria-label", t("action.starting"));
    els.actionBtn.disabled = true;
  } else {
    setActionIcon(els.actionBtn, ICONS.start);
    els.actionBtn.className = "icon-btn status-action";
    els.actionBtn.title = t("action.start");
    els.actionBtn.setAttribute("aria-label", t("action.start"));
    els.actionBtn.disabled = state.working;
  }
}

// Unsupported platform (macOS): show only the notice and hide every control,
// config form and info panel.
function paintUnsupported(s) {
  const url = typeof s.projectUrl === "string" && s.projectUrl ? s.projectUrl : "https://github.com/Niko1221/Strata";
  els.unsupportedTitle.textContent = t("unsupported.title");
  els.unsupportedMessage.textContent = s.reason || t("unsupported.reason");
  els.unsupportedLink.textContent = url.replace(/^https?:\/\//, "");
  els.unsupportedLink.dataset.url = url;
  els.unsupportedBox.hidden = false;

  els.statusCard.hidden = true;
  for (const box of [els.versionBox, els.configBox, els.speedBox, els.resourceBox, els.logsBox, els.settingsBox]) {
    box.hidden = true;
  }
  els.overlay.hidden = true;
  els.error.hidden = true;
}

function paint(s) {
  state.status = s;
  if (s.state === "unsupported") {
    paintUnsupported(s);
    return;
  }
  els.unsupportedBox.hidden = true;
  els.statusCard.hidden = false;
  const isRunning = s.state === "running";
  const isBusy = s.state === "starting" || s.state === "stopping" || s.state === "restarting";
  const isSetup = SETUP_STATES.has(s.state);

  els.dot.className = `dot ${isRunning ? "running" : isBusy ? "starting" : isSetup ? "error" : "stopped"}`;
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
  const stateLabel = t(STATE_KEYS[s.state] || "state.stopped");
  els.stateText.textContent = stateLabel;
  els.stateText.title = stateLabel;

  paintNetMode(s);
  els.model.textContent = s.model || "—";
  els.model.title = s.model || "—";
  paintUptime(s);
  paintPort(s);
  paintVersion(s);
  paintConfig(s);
  paintSpeeds(s.metrics);
  paintLogs(s.log);

  paintBar(els.gpuBar, els.gpuText, s.resources?.gpu);
  paintBar(els.memBar, els.memText, s.resources?.mem);

  els.versionBox.hidden = isSetup;
  els.configBox.hidden = isSetup;
  els.speedBox.hidden = isSetup;
  els.resourceBox.hidden = isSetup;
  els.logsBox.hidden = isSetup;
  els.settingsBox.hidden = isSetup;

  paintAccessInfo(s);
  paintActions(s);
  paintSetup(s);

  showError(s.authFailed ? t("error.authFailed") : (s.error || ""));
}

// ── Operation overlay ────────────────────────────────────────────────────

function overlayContent(op) {
  const map = {
    start: { text: t("overlay.start"), hint: t("overlay.startHint") },
    stop: { text: t("overlay.stop"), hint: "" },
    restart: { text: t("overlay.restart"), hint: t("overlay.restartHint") },
  };
  return map[op] || map.restart;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showOverlay(op) {
  const meta = overlayContent(op);
  els.overlayText.textContent = meta.text;
  els.overlayHint.textContent = meta.hint || "";
  els.overlayHint.hidden = !meta.hint;
  els.overlayForceRefresh.hidden = true;
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
  window.clearTimeout(overlayTimer);
  overlayTimer = null;
}

function startOverlayTimeout() {
  window.clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(() => {
    if (!state.working) return;
    els.overlayHint.textContent = t("overlay.timeout");
    els.overlayHint.hidden = false;
    els.overlayForceRefresh.hidden = false;
  }, 3 * 60 * 1000);
}

function setWorking(op) {
  state.working = true;
  showOverlay(op);
  startOverlayTimeout();
  const base = state.status || { state: "stopped" };
  paint({ ...base, state: op === "start" ? "starting" : op === "stop" ? "stopping" : "restarting" });
}

function endWorking() {
  state.working = false;
  hideOverlay();
}

async function waitForStable() {
  while (state.working) {
    await refresh();
    if (!state.working) return;
    const s = state.status;
    if (s && (s.state === "running" || s.state === "stopped")) {
      endWorking();
      return;
    }
    await sleep(Math.max(1000, pollMs));
  }
}

async function refresh() {
  let s = null;
  try {
    s = await api("status");
    if (Number.isFinite(s.refreshSec) && s.refreshSec > 0) pollMs = s.refreshSec * 1000;
    paint(s);
  } catch (e) {
    paint({ state: "stopped", error: String(e?.message || e) });
    return;
  }
  // Unsupported platforms have no config to read; skip the extra request.
  if (s.state !== "unsupported") await refreshConfig();
}

async function act(verb) {
  if (state.working) return;
  const op = verb === "start" ? "start" : verb === "stop" ? "stop" : "restart";
  setWorking(op);
  showError("");
  try {
    await api(verb, { method: "POST" });
    await waitForStable();
  } catch (e) {
    showError(String(e?.message || e));
    endWorking();
    await refresh();
  }
}

async function switchMode(restart) {
  if (state.working) return;
  const s = state.status || { state: "stopped" };
  const mode = s?.network?.lanExposed ? "local" : "lan";
  if (restart) {
    setWorking("restart");
  } else {
    state.working = true;
    paint(s);
  }
  showError("");
  try {
    await api("mode", { method: "POST", body: JSON.stringify({ mode, restart }) });
    if (restart) {
      await waitForStable();
    }
  } catch (e) {
    showError(String(e?.message || e));
    if (restart) {
      endWorking();
      await refresh();
    }
  } finally {
    if (!restart) {
      state.working = false;
      await refresh();
    }
  }
}

// ── Unified confirm popover ──────────────────────────────────────────────
// Absolute-positioned overlay anchored next to the trigger button. It is out
// of document flow, so opening/closing never reflows or squeezes the panel.
// Default timeout is 8s; the countdown pauses while the pointer hovers it.

const CONFIRM_TIMEOUT_MS = 8000;

const confirmState = {
  open: false,
  onConfirm: null,
  timer: null,
  remaining: 0,
  startedAt: 0,
  paused: false,
};

function confirmClearTimer() {
  if (confirmState.timer) {
    window.clearTimeout(confirmState.timer);
    confirmState.timer = null;
  }
}

function closeConfirm() {
  if (!confirmState.open) return;
  confirmState.open = false;
  confirmClearTimer();
  confirmState.onConfirm = null;
  els.confirmPopover.hidden = true;
  document.removeEventListener("pointerdown", confirmDocPointerDown, true);
}

function confirmSchedule() {
  confirmClearTimer();
  confirmState.startedAt = Date.now();
  confirmState.timer = window.setTimeout(closeConfirm, confirmState.remaining);
}

function confirmPause() {
  if (!confirmState.open || confirmState.paused) return;
  confirmState.paused = true;
  if (confirmState.timer) {
    window.clearTimeout(confirmState.timer);
    confirmState.timer = null;
    confirmState.remaining -= Date.now() - confirmState.startedAt;
    if (confirmState.remaining < 0) confirmState.remaining = 0;
  }
}

function confirmResume() {
  if (!confirmState.open || !confirmState.paused) return;
  confirmState.paused = false;
  confirmSchedule();
}

function confirmDocPointerDown(ev) {
  if (!confirmState.open) return;
  if (els.confirmPopover.contains(ev.target)) return;
  closeConfirm();
}

// Place the popover right-aligned under its trigger, clamped inside the panel.
function confirmPosition(trigger) {
  const anchor = trigger || els.actionBtn;
  const panelRect = els.panel.getBoundingClientRect();
  const triggerRect = anchor.getBoundingClientRect();
  els.confirmPopover.hidden = false;
  const popRect = els.confirmPopover.getBoundingClientRect();
  const gap = 6;
  const margin = 6;
  let left = triggerRect.right - panelRect.left - popRect.width;
  const maxLeft = panelRect.width - popRect.width - margin;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;
  let top = triggerRect.bottom - panelRect.top + gap;
  if (top + popRect.height > panelRect.height - margin) {
    top = triggerRect.top - panelRect.top - popRect.height - gap;
  }
  if (top < margin) top = margin;
  els.confirmPopover.style.left = `${Math.round(left)}px`;
  els.confirmPopover.style.top = `${Math.round(top)}px`;
}

function showConfirm({ title, sub, confirmText, cancelText, onConfirm, trigger, timeout } = {}) {
  closeConfirm();
  els.confirmTitle.textContent = title || "";
  els.confirmSub.textContent = sub || "";
  els.confirmSub.hidden = !sub;
  els.confirmOk.textContent = confirmText || t("common.confirm");
  els.confirmCancel.textContent = cancelText || t("common.cancel");
  confirmState.onConfirm = typeof onConfirm === "function" ? onConfirm : null;
  confirmState.open = true;
  confirmState.paused = false;
  confirmState.remaining = Number.isFinite(timeout) && timeout > 0 ? timeout : CONFIRM_TIMEOUT_MS;
  confirmPosition(trigger);
  confirmSchedule();
  // Defer the outside-click listener so the click that opened the popover does
  // not immediately close it.
  window.setTimeout(() => {
    if (confirmState.open) document.addEventListener("pointerdown", confirmDocPointerDown, true);
  }, 0);
}

// ── 更新 Strata ──────────────────────────────────────────────────────────

function promptUpdate(tag, trigger) {
  if (state.working) return;
  const label = tag ? String(tag).replace(/^v/, "") : "";
  showConfirm({
    title: tag ? tp("update.confirmTitle", { version: label }) : t("update.confirmTitlePlain"),
    sub: t("update.confirmSub"),
    confirmText: t("update.confirmAction"),
    trigger,
    onConfirm: () => runUpdate(tag),
  });
}

function showUpdateOverlay() {
  els.overlayText.textContent = t("update.running");
  els.overlayStep.textContent = "";
  els.overlayStep.hidden = true;
  els.overlayHint.textContent = t("update.steps");
  els.overlayHint.hidden = false;
  els.overlayForceRefresh.hidden = true;
  els.overlayLogBtn.hidden = true;
  els.overlayLog.hidden = true;
  els.overlayLog.textContent = "";
  els.overlay.hidden = false;
}

function paintUpdateProgress(u) {
  if (!u?.running) return;
  const n = Number.isFinite(u.step) ? u.step : 0;
  const total = Number.isFinite(u.totalSteps) ? u.totalSteps : 0;
  els.overlayStep.textContent = total
    ? tp("update.progressStep", {
        n: Math.max(1, n),
        total,
        label: u.stepLabel ? tp("update.progressLabel", { label: u.stepLabel }) : "",
      })
    : t("update.progress");
  els.overlayStep.hidden = false;
}

function showUpdateError(u) {
  els.overlayText.textContent = t("update.failed");
  els.overlayStep.hidden = true;
  const detail = u?.error || t("update.unknownError");
  const rollback = u?.rollbackHint || "";
  els.overlayHint.textContent = [detail, rollback].filter(Boolean).join("；");
  els.overlayHint.hidden = false;
  els.overlayLogBtn.hidden = !u?.logFile;
  els.overlayForceRefresh.hidden = false;
}

async function runUpdate(tag) {
  if (state.working) return;
  state.working = true;
  showUpdateOverlay();
  showError("");
  try {
    await api("update", { method: "POST", body: JSON.stringify({ tag }) });
    await waitForUpdate();
  } catch (e) {
    showUpdateError({ error: String(e?.message || e) });
    state.working = false;
  }
}

async function waitForUpdate() {
  while (state.working) {
    await sleep(2000);
    let u = null;
    try {
      u = await api("update");
    } catch {
      continue;
    }
    if (!u) continue;
    paintUpdateProgress(u);
    if (u.error) {
      showUpdateError(u);
      state.working = false;
      await refresh();
      return;
    }
    if (u.done) {
      state.working = false;
      hideOverlay();
      await refresh();
      return;
    }
  }
}

async function toggleUpdateLog() {
  if (!els.overlayLog.hidden) {
    els.overlayLog.hidden = true;
    els.overlayLog.textContent = "";
    els.overlayLogBtn.textContent = t("overlay.viewFullLog");
    return;
  }
  let data = null;
  try {
    data = await api("update/log");
  } catch {
    /* ignore */
  }
  const tail = data?.tail || "";
  if (tail) {
    els.overlayLog.textContent = tail;
    els.overlayLog.hidden = false;
    els.overlayLogBtn.textContent = t("overlay.hideLog");
  } else if (data?.path) {
    els.overlayLog.textContent = tp("update.logFileEmpty", { path: data.path });
    els.overlayLog.hidden = false;
    els.overlayLogBtn.textContent = t("overlay.hideLog");
  }
}

// ── Settings edit form ────────────────────────────────────────────────────

// Technical sampling fields keep their literal names; only UI-owned labels
// are translated.
const FIELD_LABEL_KEYS = {
  context: "edit.context",
  kv: "edit.kv",
  sessionCache: "edit.sessionCache",
  max_tokens: "edit.maxTokens",
  reasoning_effort: "edit.reasoningEffort",
};

function fieldLabel(key) {
  return FIELD_LABEL_KEYS[key] ? t(FIELD_LABEL_KEYS[key]) : key;
}

const editFields = [...document.querySelectorAll("#editForm [data-key]")];

function collectEdits() {
  const edits = {};
  for (const el of editFields) {
    const key = el.dataset.key;
    const raw = el.value;
    if (el.type === "number") {
      if (raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) edits[key] = n;
    } else {
      edits[key] = raw;
    }
  }
  return edits;
}

function fillEditForm(values) {
  for (const el of editFields) {
    const v = values?.[el.dataset.key];
    el.value = v === undefined || v === null ? "" : String(v);
  }
  state.formFilled = true;
}

function renderDiff() {
  if (!state.config?.hasConfig) {
    els.diffBox.hidden = true;
    els.diffList.replaceChildren();
    return;
  }
  const current = state.config?.values || {};
  const edits = collectEdits();
  const items = [];
  for (const [key, val] of Object.entries(edits)) {
    if (String(current[key]) !== String(val)) {
      items.push({ key, old: current[key], new: val });
    }
  }
  els.diffBox.hidden = items.length === 0;
  els.diffList.replaceChildren();
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = `${fieldLabel(it.key)}: ${it.old ?? "—"} → ${it.new ?? "—"}`;
    els.diffList.append(li);
  }
}

function setMessage(text, kind = "info") {
  els.editMessage.textContent = text || "";
  els.editMessage.className = `message ${kind}`;
}

async function refreshConfig() {
  try {
    const cfg = await api("settings");
    state.config = cfg;
    if (cfg.hasConfig) {
      // Refill when the selected file changes so the editor always shows the
      // chosen config's values.
      if (state.configFileFilled !== cfg.configFile) {
        fillEditForm(cfg.values || {});
        state.configFileFilled = cfg.configFile;
      }
    } else {
      state.formFilled = false;
      state.configFileFilled = null;
    }
    renderDiff();
  } catch {
    state.config = null;
    renderDiff();
  }
}

function applySaveResult(result) {
  const changed = result.diff?.length || 0;
  const backups = result.backups?.length
    ? tp("edit.backups", { list: result.backups.join(", ") })
    : "";
  if (result.saved) {
    setMessage(tp("edit.saved", {
      count: changed,
      backups,
      restart: result.restartRequired ? t("edit.restartRequired") : "",
    }), "ok");
  } else {
    setMessage(result.note || t("edit.noChange"), "warn");
  }
}

async function save(restart) {
  if (state.working) return;
  const edits = collectEdits();
  if (!Object.keys(edits).length) {
    setMessage(t("edit.noEdits"), "warn");
    return;
  }

  if (restart) {
    setWorking("restart");
    setMessage(t("edit.savingRestart"), "info");
    try {
      const result = await api("settings", { method: "POST", body: JSON.stringify({ edits, restart: true }) });
      applySaveResult(result);
      await waitForStable();
    } catch (e) {
      setMessage(String(e?.message || e), "error");
      endWorking();
      await refresh();
    }
    return;
  }

  state.working = true;
  paint(state.status || { state: "stopped" });
  setMessage(t("edit.saving"), "info");
  try {
    const result = await api("settings", { method: "POST", body: JSON.stringify({ edits, restart: false }) });
    applySaveResult(result);
  } catch (e) {
    setMessage(String(e?.message || e), "error");
  } finally {
    state.working = false;
    await refresh();
  }
}

// ── Setup forms: step 1 (paths) and step 2 (config picker) ───────────────

let pluginForm = null;
let pluginFormEls = null;
let setupView = null;

function ensurePluginForm() {
  if (pluginForm) return pluginForm;
  const tpl = document.getElementById("pluginSettingsTemplate");
  if (!tpl) return null;
  pluginForm = tpl.content.cloneNode(true).querySelector("form");
  pluginFormEls = {
    form: pluginForm,
    strataDir: pluginForm.querySelector('[data-key="strataDir"]'),
    pythonPath: pluginForm.querySelector('[data-key="pythonPath"]'),
    pythonPathHint: pluginForm.querySelector("#ps-pythonPath-hint"),
    notInstalledBox: pluginForm.querySelector("#psNotInstalledBox"),
    serverScript: pluginForm.querySelector("#psServerScript"),
    message: pluginForm.querySelector("#psMessage"),
    saveBtn: pluginForm.querySelector("#psSaveBtn"),
  };
  pluginFormEls.saveBtn.addEventListener("click", savePluginSettings);
  pluginFormEls.form.addEventListener("input", () => {
    state.pluginFormDirty = true;
    setPsMessage("");
  });
  return pluginForm;
}

function fillPluginForm(values) {
  pluginFormEls.strataDir.value = values?.strataDir ?? "";
  pluginFormEls.pythonPath.value = values?.pythonPath ?? "";
}

// Only the two required paths are hand-typed; configFile / port are resolved.
function collectPluginSettings() {
  return {
    strataDir: pluginFormEls.strataDir.value.trim(),
    pythonPath: pluginFormEls.pythonPath.value.trim(),
  };
}

function setPsMessage(text, kind = "info") {
  pluginFormEls.message.textContent = text || "";
  pluginFormEls.message.className = `message ${kind}`;
}

// Renders whichever setup UI the current state needs inside the status card.
function paintSetup(s) {
  const show = SETUP_STATES.has(s.state);
  els.statusConfigBox.hidden = !show;
  if (!show) {
    setupView = null;
    return;
  }

  if (s.state === "unconfigured" || s.state === "not-installed" || s.state === "python-missing") {
    const form = ensurePluginForm();
    if (!form) return;
    if (!state.pluginFormFilled && s.settings) {
      fillPluginForm(s.settings);
      state.pluginFormFilled = true;
    }
    if (setupView !== "form") {
      els.statusConfigBox.replaceChildren(form);
      setupView = "form";
    }
    paintPluginForm(s);
  } else if (s.state === "needs-config") {
    const form = ensureConfigSelectForm();
    if (!form) return;
    renderConfigCandidates(s.configCandidates || []);
    if (setupView !== "select") {
      els.statusConfigBox.replaceChildren(form);
      setupView = "select";
    }
  } else {
    // no-config
    els.statusConfigBox.replaceChildren(buildNoConfigNotice(s));
    setupView = "no-config";
  }
}

function paintPluginForm(s) {
  pluginFormEls.notInstalledBox.hidden = s.state !== "not-installed";
  if (s.state === "not-installed" && s.serverScript) {
    pluginFormEls.serverScript.textContent = s.serverScript;
  }
  // Show the resolver's error verbatim (bad configured path, or no system
  // python3 when the field is left empty).
  const pythonError = s.settings?.pythonError || "";
  pluginFormEls.pythonPathHint.hidden = !pythonError;
  if (pythonError) pluginFormEls.pythonPathHint.textContent = pythonError;
  pluginFormEls.saveBtn.disabled = state.working;
}

function noConfigSub(s) {
  const dir = s.settings?.strataDir || "";
  return tp("setup.noConfigSub", { dir });
}

function buildNoConfigNotice(s) {
  const box = document.createElement("div");
  box.className = "not-installed-box";
  const title = document.createElement("div");
  title.className = "not-installed-title";
  title.textContent = t("setup.noConfigTitle");
  const sub = document.createElement("div");
  sub.className = "not-installed-sub";
  sub.textContent = noConfigSub(s);
  box.append(title, sub);
  return box;
}

// ── Step 2: config file picker ───────────────────────────────────────────

let configSelectForm = null;
let configSelectEls = null;
let configCandidatesKey = "";

function ensureConfigSelectForm() {
  if (configSelectForm) return configSelectForm;
  const tpl = document.getElementById("configSelectTemplate");
  if (!tpl) return null;
  configSelectForm = tpl.content.cloneNode(true).querySelector("form");
  configSelectEls = {
    form: configSelectForm,
    title: configSelectForm.querySelector("#csTitle"),
    list: configSelectForm.querySelector("#csList"),
    message: configSelectForm.querySelector("#csMessage"),
    useBtn: configSelectForm.querySelector("#csUseBtn"),
  };
  configSelectEls.useBtn.addEventListener("click", () => {
    const picked = configSelectEls.form.querySelector('input[name="configFile"]:checked')?.value;
    if (picked) selectConfigFile(picked);
  });
  configSelectEls.list.addEventListener("change", () => setCsMessage(""));
  return configSelectForm;
}

function setCsMessage(text, kind = "info") {
  if (!configSelectEls) return;
  configSelectEls.message.textContent = text || "";
  configSelectEls.message.className = `message ${kind}`;
}

function renderConfigCandidates(candidates) {
  const key = candidates.map((c) => `${c.file}:${c.context ?? ""}`).join("|");
  if (key === configCandidatesKey) return;
  configCandidatesKey = key;
  configSelectEls.list.replaceChildren();

  const single = candidates.length === 1;
  configSelectEls.title.textContent = single
    ? tp("setup.autoSelected", { file: candidates[0].file })
    : t("setup.chooseConfig");
  configSelectEls.useBtn.textContent = single ? t("setup.useThis") : t("setup.useSelected");

  candidates.forEach((c, i) => {
    const row = document.createElement("label");
    row.className = "config-candidate";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "configFile";
    radio.value = c.file;
    if (i === 0) radio.checked = true; // auto-select the first / only one
    const body = document.createElement("span");
    body.className = "config-candidate-body";
    const name = document.createElement("span");
    name.className = "config-candidate-name";
    name.textContent = c.file;
    body.append(name);
    const parts = [];
    if (c.quant) parts.push(c.quant);
    if (Number.isFinite(c.context)) parts.push(tp("setup.candidateContext", { context: c.context }));
    if (parts.length) {
      const meta = document.createElement("span");
      meta.className = "config-candidate-meta";
      meta.textContent = parts.join(" · ");
      body.append(meta);
    }
    row.append(radio, body);
    configSelectEls.list.append(row);
  });
}

async function selectConfigFile(file) {
  if (state.working) return;
  state.working = true;
  setCsMessage(t("edit.saving"), "info");
  showError("");
  try {
    const result = await api("settings/config", {
      method: "POST",
      body: JSON.stringify({ configFile: file }),
    });
    state.configFileFilled = null;
    state.formFilled = false;
    if (result.status) paint(result.status);
    setCsMessage(t("setup.selected"), "ok");
  } catch (e) {
    setCsMessage(String(e?.message || e), "error");
  } finally {
    state.working = false;
    await refresh();
  }
}

async function savePluginSettings() {
  if (state.working) return;
  const values = collectPluginSettings();
  // Only the Strata directory is required; pythonPath may stay empty to use
  // the system python3.
  if (!values.strataDir) {
    setPsMessage(t("setup.needDir"), "error");
    return;
  }

  state.working = true;
  paint(state.status || { state: "stopped" });
  setPsMessage(t("setup.savingDetect"), "info");
  showError("");

  try {
    const result = await api("settings/plugin", { method: "POST", body: JSON.stringify(values) });
    state.pluginFormDirty = false;
    state.pluginFormFilled = true;
    state.configFileFilled = null;
    state.formFilled = false;
    setPsMessage(t("setup.saved"), "ok");
    if (result.status) paint(result.status);
  } catch (e) {
    setPsMessage(String(e?.message || e), "error");
  } finally {
    state.working = false;
    paint(state.status || { state: "stopped" });
  }
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    if (!state.working && !document.hidden) await refresh();
    schedule();
  }, pollMs);
}

els.refreshBtn.addEventListener("click", () => refresh());
els.unsupportedLink.addEventListener("click", () => {
  openExternal(els.unsupportedLink.dataset.url || "https://github.com/Niko1221/Strata");
});
els.overlayForceRefresh.addEventListener("click", () => {
  endWorking();
  refresh();
});
els.actionBtn.addEventListener("click", () => {
  const s = state.status || { state: "stopped" };
  if (s.state === "running") {
    showConfirm({
      title: t("confirm.stopTitle"),
      confirmText: t("confirm.stopAction"),
      trigger: els.actionBtn,
      onConfirm: doStop,
    });
  } else if (s.state !== "starting") {
    act("start");
  }
});
els.modeBtn.addEventListener("click", () => {
  const s = state.status || { state: "stopped" };
  if (state.working) return;
  if (s.state === "running" || s.state === "starting") {
    showConfirm({
      title: t("confirm.switchModeTitle"),
      sub: t("confirm.switchModeSub"),
      confirmText: t("confirm.restartAction"),
      trigger: els.modeBtn,
      onConfirm: doSwitchMode,
    });
  } else {
    switchMode(false);
  }
});
els.confirmOk.addEventListener("click", () => {
  const cb = confirmState.onConfirm;
  closeConfirm();
  if (cb) cb();
});
els.confirmCancel.addEventListener("click", () => closeConfirm());
els.confirmPopover.addEventListener("pointerenter", confirmPause);
els.confirmPopover.addEventListener("pointerleave", confirmResume);
els.overlayLogBtn.addEventListener("click", () => toggleUpdateLog());
els.saveBtn.addEventListener("click", () => save(false));
els.saveRestartBtn.addEventListener("click", () => save(true));
els.editForm.addEventListener("input", () => renderDiff());
window.addEventListener("beforeunload", () => window.clearTimeout(timer));

// ── Language ─────────────────────────────────────────────────────────────

function initLangSelect() {
  if (!els.langSelect) return;
  els.langSelect.replaceChildren();
  for (const code of LANGS) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = LANG_NAMES[code];
    els.langSelect.append(opt);
  }
  els.langSelect.value = getLang();
  els.langSelect.addEventListener("change", () => {
    setLang(els.langSelect.value);
    saveLang(els.langSelect.value);
    relocalize();
  });
}

// Re-render every piece of copy after the language changes. Static markup goes
// first, then any value-driven rows, so dynamic text wins.
function relocalize() {
  applyI18n();
  for (const tpl of document.querySelectorAll("template")) applyI18n(tpl.content);
  if (state.status) paint(state.status);
  renderDiff();
}

// Localize the static markup and the not-yet-cloned templates before boot.
applyI18n();
for (const tpl of document.querySelectorAll("template")) applyI18n(tpl.content);
initLangSelect();

// Handshake with the host, then start polling.
hana.ready();
refresh().then(schedule);
