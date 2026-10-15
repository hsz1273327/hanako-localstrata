// hanako-localstrata v2 card logic.
// - Handshake through the App UI SDK (hana.ready()).
// - Routes are called via hana.api.fetch (carries this App's surface session).
// - Clipboard / external links go through hana.clipboard / hana.external.
// - Polls this App's GET /status route every refreshSec seconds.
import { hana } from "./sdk.js";
import { LANGS, LANG_NAMES, loadLang, saveLang, setLang, getLang, t, tp, joinList, applyI18n } from "./i18n.js";
import { createContainerFields, createApiKeyField } from "./profile-fields.js";
import { isAbsent, editDiff, valuesFingerprint, needsRefill } from "./edit-diff.js";
import { copyToClipboard } from "./clipboard.js";

// Resolve the UI language before anything renders.
setLang(loadLang());

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await hana.api.fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.validation = data?.validation;
    err.data = data;
    throw err;
  }
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
  statusBody: document.getElementById("statusBody"),
  modelRow: document.getElementById("modelRow"),
  uptimeRow: document.getElementById("uptimeRow"),
  portRow: document.getElementById("portRow"),
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
  startOptionsHint: document.getElementById("startOptionsHint"),
  envSelectWrap: document.getElementById("envSelectWrap"),
  envSelect: document.getElementById("envSelect"),
  profileBadge: document.getElementById("profileBadge"),
  profileEditBtn: document.getElementById("profileEditBtn"),
  profileDrawerScrim: document.getElementById("profileDrawerScrim"),
  profileDrawer: document.getElementById("profileDrawer"),
  profileDrawerTitle: document.getElementById("profileDrawerTitle"),
  profileDrawerClose: document.getElementById("profileDrawerClose"),
  profileDrawerBody: document.getElementById("profileDrawerBody"),
  profileDrawerActions: document.getElementById("profileDrawerActions"),
  profileDrawerSave: document.getElementById("profileDrawerSave"),
  profileReadOnlyHint: document.getElementById("profileReadOnlyHint"),
  versionBox: document.getElementById("versionBox"),
  configBox: document.getElementById("configBox"),
  configManagedNotice: document.getElementById("configManagedNotice"),
  configPickBox: document.getElementById("configPickBox"),
  configFileSelect: document.getElementById("configFileSelect"),
  configSetupBtn: document.getElementById("configSetupBtn"),
  speedBox: document.getElementById("speedBox"),
  resourceBox: document.getElementById("resourceBox"),
  logsBox: document.getElementById("logsBox"),
  settingsBox: document.getElementById("settingsBox"),
  overlay: document.getElementById("overlay"),
  overlayText: document.getElementById("overlayText"),
  overlayStep: document.getElementById("overlayStep"),
  overlayStages: document.getElementById("overlayStages"),
  overlayHint: document.getElementById("overlayHint"),
  overlayForceRefresh: document.getElementById("overlayForceRefresh"),
  overlayLogBtn: document.getElementById("overlayLogBtn"),
  overlayLog: document.getElementById("overlayLog"),
  error: document.getElementById("error"),
  refreshBtn: document.getElementById("refreshBtn"),
  langSelect: document.getElementById("langSelect"),
  editForm: document.getElementById("editForm"),
  saveBtn: document.getElementById("saveBtn"),
  diffBox: document.getElementById("diffBox"),
  diffList: document.getElementById("diffList"),
  editMessage: document.getElementById("editMessage"),
};

const state = {
  status: null,
  config: null,
  working: false,
  formFilled: false,
  // { file, values } of the config view the form currently shows (null = none).
  configFilled: null,
  // The profile open in the drawer for EDITING (null in the read-only view).
  editingProfileId: null,
};

// States where setup still needs input; the inline status form / config picker
// replaces the normal info panels.
const SETUP_STATES = new Set(["unconfigured", "not-installed", "python-missing", "no-config", "needs-config"]);
const RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

// First launch = the local source has no usable config (no strata-*.json).
// A container profile performs its own setup, so it is never a first run here.
function needsFirstRun(s) {
  if (!s || s.state === "unsupported") return false;
  if (isDockerMethod(s)) return false;
  return s.state === "no-config";
}

function isDockerMethod(s) {
  return s?.profile?.type === "container" || s?.launch?.method === "docker";
}

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

// The reason line sits at the very bottom of the panel, below the logs and the
// parameter editor — a failure reported only there is easy to miss when the
// button you pressed is at the top. Pull it into view when it carries news.
function revealError() {
  try {
    els.error.scrollIntoView({ block: "nearest" });
  } catch {
    /* not every host has scrollIntoView; the line is still there */
  }
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

// A hidden, selected textarea. Chromium fills the clipboard from the current
// Selection for the legacy command — and keeping the node lets the user copy by
// hand when even that fails.
let manualCopyHolder = null;

function clearManualCopy() {
  if (manualCopyHolder) {
    manualCopyHolder.remove();
    manualCopyHolder = null;
  }
}

function mountManualCopy(text) {
  clearManualCopy();
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.readOnly = true;
  holder.style.position = "fixed";
  holder.style.left = "-9999px";
  holder.style.top = "0";
  document.body.append(holder);
  holder.select();
  holder.setSelectionRange(0, text.length);
  return holder;
}

// The LEGACY path, and it is the interesting one here: `execCommand("copy")`
// needs no clipboard-write permission, only focus and a Selection. This host
// gives every card iframe a `sandbox` attribute and NO `allow` at all, so
// `navigator.clipboard` is refused inside the card — the legacy command is the
// one that can still work there.
function legacyCopy(value) {
  const holder = mountManualCopy(value);
  let ok = false;
  try {
    ok = !!(document.execCommand && document.execCommand("copy"));
  } catch {
    ok = false;
  }
  if (ok) {
    holder.remove();
    return;
  }
  manualCopyHolder = holder; // leave it selected for a manual Ctrl+C
  throw new Error("execCommand('copy') refused");
}

// The clipboard paths this page actually has, in the order they are tried.
function clipboardDeps() {
  return {
    hostWrite: typeof hana?.clipboard?.writeText === "function" ? (text) => hana.clipboard.writeText(text) : null,
    browserWrite:
      typeof navigator !== "undefined" && navigator.clipboard?.writeText
        ? (text) => navigator.clipboard.writeText(text)
        : null,
    legacyWrite: legacyCopy,
  };
}

async function copyText(text) {
  return copyToClipboard(text, clipboardDeps());
}

// Why a copy failed, in words the user can act on. The ledger's answer for
// `app/ui.clipboard-write` separates "never granted" (fixable in
// 设置 → 安全 → 应用能力) from "granted, yet the write still failed" (an
// environment problem). No answer → the generic wording below, which is honest.
async function copyFailureMessage(res) {
  let status = "";
  try {
    const caps = await api("capabilities");
    status = caps?.capabilities?.["app/ui.clipboard-write"]?.status || "";
  } catch {
    /* the generic wording is still honest */
  }
  // The per-path reasons go INTO the message, not only the tooltip: a tooltip is
  // not discoverable, and "which path failed with what" is the whole diagnosis.
  const error = String(res?.error || "").slice(0, 300);
  if (status === "always" || status === "session") return tp("copy.failedGranted", { status, error });
  return tp("copy.failedUngranted", { status: status || "not_asked", error });
}

async function copyWithFeedback(btn, text) {
  const label = btn.textContent;
  const res = await copyText(text);
  if (res.ok) {
    btn.textContent = t("common.copied");
    btn.title = "";
    showError("");
  } else {
    // "已选中" read as SUCCESS, which is exactly what made the failure invisible.
    // Now the label says failed, the tooltip carries the raw reason, the text is
    // left selected for a manual copy, and the reason line is scrolled into view
    // (it lives at the bottom of a long panel).
    if (!manualCopyHolder) manualCopyHolder = mountManualCopy(text);
    btn.textContent = t("common.copyFailed");
    btn.title = res.error || "";
    showError(await copyFailureMessage(res));
    revealError();
  }
  btn.classList.add("copied");
  window.clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = window.setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove("copied");
    // The manual selection is only meant to survive long enough to press Ctrl+C.
    clearManualCopy();
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

// The "name:tag" reference the docker CLI consumes, from the profile's two
// image fields (the backend sends them on the container profile view).
function imageRefOf(profile) {
  const name = String(profile?.imageName || "").trim();
  const tag = String(profile?.imageTag || "").trim();
  if (!name) return "";
  return tag ? `${name}:${tag}` : name;
}

function paintVersion(s) {
  const rows = [];
  if (isDockerMethod(s)) {
    // A container is versioned by its IMAGE, pulled from a registry — show the
    // two image fields (name + tag), the same ones the editor and the service
    // card use, and nothing build-related: a locally built image's timestamp
    // says nothing about a pulled image.
    const prof = s.profile;
    if (prof?.imageName) rows.push([t("field.imageName"), prof.imageName]);
    if (prof?.imageTag) rows.push([t("field.imageTag"), prof.imageTag]);
    renderKvRows(els.versionRows, rows);
    return;
  }

  const version = s?.version;
  const local = typeof version?.local === "string" ? version.local : null;
  const latest = typeof version?.latest === "string" ? version.latest : null;
  rows.push([t("label.version"), local || "—"]);
  if (version?.checkState === "checked" && latest) {
    if (local && compareVersions(latest, local) > 0) {
      if (RUNNING_STATES.has(s.state)) {
        rows.push([
          t("label.latestVersion"),
          tp("version.available", { version: latest }),
          "update",
          undefined,
          t("version.stopToUpdate"),
        ]);
      } else {
        rows.push([
          t("label.latestVersion"),
          tp("version.available", { version: latest }),
          "update",
          undefined,
          undefined,
          { label: t("common.update"), onClick: (btn) => promptUpdate(latest, btn) },
        ]);
      }
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

function dockerStateLabel(state) {
  const key = `dockerState.${String(state || "").toLowerCase()}`;
  const label = t(key);
  return label === key ? String(state || "—") : label;
}

function paintNetMode(s) {
  if (SETUP_STATES.has(s.state)) {
    els.netMode.hidden = true;
    return;
  }
  els.netMode.hidden = false;
  const lan = !!(s?.network?.lanExposed);
  if (isDockerMethod(s)) {
    // The container publishes the port on all host interfaces by default;
    // distinguish "published to the LAN" from local mode's loopback default.
    els.netMode.textContent = lan ? t("netMode.containerLan") : t("netMode.containerLocal");
    els.netMode.className = `net-mode ${lan ? "lan" : "local"}`;
    els.netMode.title = t("netMode.containerTitle");
    return;
  }
  els.netMode.textContent = lan ? t("netMode.lan") : t("netMode.local");
  els.netMode.className = `net-mode ${lan ? "lan" : "local"}`;
  els.netMode.title = "";
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

function profileTypeLabel(type) {
  return type === "container" ? t("profile.typeContainer") : t("profile.typeLocal");
}

// Current profile name + type marker (shown while a service is running).
// The "current environment" control in the header. While running it is the
// read-only name·type badge (clicking it opens the read-only detail drawer);
// while stopped it is a picker that switches the current environment.
function paintEnv(s) {
  const prof = s?.profile;
  const running = RUNNING_STATES.has(s.state);
  const show = !!prof && s.state !== "unsupported";
  els.profileBadge.hidden = !show || !running;
  els.envSelectWrap.hidden = !show || running;
  els.profileEditBtn.hidden = !show || running;
  if (show && running) {
    els.profileBadge.textContent = `${prof.name} · ${profileTypeLabel(prof.type)}`;
    els.profileBadge.className = `profile-badge ${prof.type}`;
    els.profileBadge.title = t("profile.viewDetails");
    els.profileBadge.setAttribute("aria-label", t("profile.viewDetails"));
  } else if (show) {
    renderEnvOptions(s.profiles);
    els.envSelect.value = s.activeProfileId || "";
    els.envSelect.disabled = state.working;
  }
}

function paintConfig(s) {
  const cs = s?.configSummary;
  const rows = [];
  const prof = s?.profile;
  if (prof && !SETUP_STATES.has(s.state)) {
    rows.push([t("label.profile"), `${prof.name} (${profileTypeLabel(prof.type)})`]);
  }
  if (isDockerMethod(s) && s.docker) {
    rows.push([t("label.container"), s.docker.containerName || "—"]);
    const prof = s.profile;
    if (prof?.imageName) rows.push([t("field.imageName"), prof.imageName]);
    if (prof?.imageTag) rows.push([t("field.imageTag"), prof.imageTag]);
    rows.push([t("label.containerState"), dockerStateLabel(s.docker.state)]);
  }
  if (Number.isFinite(cs?.context)) rows.push([t("label.context"), fmtK(cs.context)]);
  if (cs?.kv) rows.push([t("label.kv"), cs.kv]);
  if (Number.isFinite(cs?.sessionCache)) rows.push([t("label.sessionCache"), fmtGiB(cs.sessionCache)]);
  if (cs?.reasoningEffort) rows.push([t("label.reasoningEffort"), cs.reasoningEffort]);
  if (Number.isFinite(cs?.port)) rows.push([t("label.port"), String(cs.port)]);
  renderKvRows(els.configRows, rows);
}

// The config picker (local source, stopped only). The candidate list already
// rides on getStatus(), so no extra backend read is needed. Selecting persists
// the choice server-side, then the next refresh repaints every card from it.
let configSelectKey = "";

function paintConfigPick(s) {
  const local = !isDockerMethod(s);
  const running = RUNNING_STATES.has(s.state);
  const show = local && !running && !SETUP_STATES.has(s.state);
  els.configPickBox.hidden = !show;
  if (!show) return;
  const candidates = Array.isArray(s.configCandidates) ? s.configCandidates : [];
  const selected = s.configFile || "";
  const key = candidates.map((c) => `${c.file}:${c.context ?? ""}`).join("|") + `#${selected}`;
  els.configFileSelect.disabled = state.working;
  els.configSetupBtn.disabled = state.working;
  if (key === configSelectKey) return;
  configSelectKey = key;
  els.configFileSelect.replaceChildren();
  for (const c of candidates) {
    const opt = document.createElement("option");
    opt.value = c.file;
    const parts = [];
    if (c.quant) parts.push(c.quant);
    if (Number.isFinite(c.context)) parts.push(tp("configPick.context", { context: c.context }));
    opt.textContent = parts.length ? `${c.file} · ${parts.join(" · ")}` : c.file;
    els.configFileSelect.append(opt);
  }
  els.configFileSelect.value = selected;
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
  // A local profile in a setup state (no server.py, no config) has nothing to
  // start and no config to edit; a container profile can still be started
  // (the app pulls/creates the container), so keep its action button.
  if (SETUP_STATES.has(s.state) && !needsFirstRun(s) && !isDockerMethod(s)) {
    els.modeBtn.hidden = true;
    els.actionBtn.hidden = true;
    return;
  }

  const isRunning = s.state === "running";
  const isStarting = s.state === "starting";

  paintModeBtn(s);

  // host / api_key are read-only for a container profile: changing them needs
  // a container recreate, which is out of scope. First-run setup also has no
  // config to edit yet, so hide it there too.
  els.modeBtn.hidden = needsFirstRun(s) || isDockerMethod(s);
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
    // Disable when the current environment cannot start.
    els.actionBtn.disabled = state.working || !canStartCurrent(s);
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
  els.profileBadge.hidden = true;
  els.envSelectWrap.hidden = true;
  els.profileEditBtn.hidden = true;
  for (const box of [els.versionBox, els.configBox, els.speedBox, els.resourceBox, els.logsBox, els.settingsBox]) {
    box.hidden = true;
  }
  els.overlay.hidden = true;
  els.error.hidden = true;
}

function paint(s) {
  state.status = s;
  const running = RUNNING_STATES.has(s.state);
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
  paintEnv(s);
  els.model.textContent = s.model || "—";
  els.model.title = s.model || "—";
  paintUptime(s);
  paintPort(s);
  paintVersion(s);
  paintConfig(s);
  paintConfigPick(s);
  paintSpeeds(s.metrics);
  paintLogs(s.log);

  paintBar(els.gpuBar, els.gpuText, s.resources?.gpu);
  paintBar(els.memBar, els.memText, s.resources?.mem);

  // No content → hide the section rather than leave a "—" placeholder: a dash
  // reads as "could not read it" when the truth is "there is nothing yet".
  els.versionBox.hidden = isSetup || !els.versionRows.children.length;
  els.configBox.hidden = isSetup || !els.configRows.children.length;
  // Container configs are derived from the container's own env: say so instead
  // of offering a picker that does not apply.
  els.configManagedNotice.hidden = els.configBox.hidden || !isDockerMethod(s);
  els.speedBox.hidden = isSetup || !els.speedRows.children.length;
  // Resources are whole-machine figures (nvidia-smi / os.freemem), not this
  // service's; while it is not running they are not this page's job, so hide.
  els.resourceBox.hidden = isSetup || !isRunning;
  els.logsBox.hidden = isSetup || !(s.log?.lines?.length);
  els.settingsBox.hidden = isSetup || running;

  // The status card's runtime rows show "—" while stopped; hide the empty ones.
  els.modelRow.hidden = !s.model;
  els.uptimeRow.hidden = !Number.isFinite(s?.uptime_s);
  els.portRow.hidden = !Number.isFinite(s?.port);

  paintAccessInfo(s);
  els.statusBody.hidden =
    els.modelRow.hidden && els.uptimeRow.hidden && els.portRow.hidden && els.accessRows.hidden;
  paintActions(s);
  paintStartHint(s);
  paintSetupNotice(s);

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
  els.overlayStep.textContent = "";
  els.overlayStep.hidden = true;
  if (els.overlayStages) els.overlayStages.hidden = true;
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

function startOverlayTimeout(ms = 3 * 60 * 1000) {
  window.clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(() => {
    if (!state.working) return;
    els.overlayHint.textContent = t("overlay.timeout");
    els.overlayHint.hidden = false;
    els.overlayForceRefresh.hidden = false;
  }, ms);
}

// ── First-run staged progress ────────────────────────────────────────────
// A first launch can take minutes to hours (download/convert), so the
// overlay shows the four stages instead of a single "starting…" line.

function renderFirstRunStages(p) {
  if (!els.overlayStages) return;
  els.overlayStages.replaceChildren();
  const stages = Array.isArray(p?.stages) ? p.stages : [];
  const index = p?.stageIndex || 0;
  stages.forEach((id, i) => {
    const li = document.createElement("li");
    li.className = "overlay-stage";
    if (p?.done || i + 1 < index) li.classList.add("done");
    if (!p?.done && i + 1 === index) li.classList.add("active");
    li.textContent = t(`firstRun.stage.${id}`);
    els.overlayStages.append(li);
  });
}

function showFirstRunOverlay(p, textKey = "firstRun.running") {
  els.overlayText.textContent = t(textKey);
  els.overlayStep.textContent = "";
  els.overlayStep.hidden = true;
  els.overlayHint.textContent = p?.mayDownload ? t("firstRun.mayDownload") : t("firstRun.usingGguf");
  els.overlayHint.hidden = false;
  els.overlayForceRefresh.hidden = true;
  renderFirstRunStages(p);
  if (els.overlayStages) els.overlayStages.hidden = false;
  els.overlay.hidden = false;
  // A first run can legitimately take hours; do not time out at 3 minutes.
  startOverlayTimeout(12 * 60 * 60 * 1000);
}

async function waitForFirstRun() {
  while (state.working) {
    await sleep(2500);
    let p = null;
    try {
      p = await api("start");
    } catch {
      continue;
    }
    if (!p) continue;
    renderFirstRunStages(p);
    if (p.error) {
      state.working = false;
      showError(p.error);
      hideOverlay();
      await refresh();
      return;
    }
    if (p.done) {
      state.working = false;
      hideOverlay();
      await refresh();
      return;
    }
    // The job disappeared (e.g. the App host restarted mid-setup): stop
    // polling instead of hanging on the overlay forever.
    if (p.running === false && p.firstRun !== true) {
      state.working = false;
      hideOverlay();
      await refresh();
      return;
    }
  }
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

async function act(verb, profileId) {
  if (state.working) return;
  const op = verb === "start" ? "start" : verb === "stop" ? "stop" : "restart";
  setWorking(op);
  showError("");
  try {
    const init = { method: "POST" };
    if (verb === "start" && profileId) init.body = JSON.stringify({ profileId });
    const res = await api(verb, init);
    // First launch: the backend returns a background setup job and the staged
    // overlay; poll GET /start until it is done. Existing installs keep the
    // original synchronous behaviour.
    if (verb === "start" && res && res.firstRun && res.running !== false) {
      showFirstRunOverlay(res);
      await waitForFirstRun();
      return;
    }
    await waitForStable();
  } catch (e) {
    const message = String(e?.message || e);
    endWorking();
    // Repaint the status *before* restoring the message: paint() owns #error
    // and clears it on every refresh, so a message shown first would vanish on
    // the next frame (a failed stop used to look like nothing happened).
    await refresh();
    showError(message);
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
  if (els.overlayStages) els.overlayStages.hidden = true;
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
  mtp: "edit.mtp",
  max_tokens: "edit.maxTokens",
  reasoning_effort: "edit.reasoningEffort",
};

function fieldLabel(key) {
  return FIELD_LABEL_KEYS[key] ? t(FIELD_LABEL_KEYS[key]) : key;
}

const editFields = [...document.querySelectorAll("#editForm [data-key]")];

// The inputs' raw values + their types, shaped for `editDiff`.
function editInputs() {
  const raw = {};
  const types = {};
  for (const el of editFields) {
    raw[el.dataset.key] = el.value;
    types[el.dataset.key] = el.type;
  }
  return { raw, types };
}

// What the editor currently shows vs what the config file holds. The diff list and
// the save payload both come from here, so they cannot disagree.
function configEdits() {
  const { raw, types } = editInputs();
  return editDiff(state.config?.values || {}, raw, types);
}

function fillEditForm(values) {
  for (const el of editFields) {
    const v = values?.[el.dataset.key];
    el.value = v === undefined || v === null ? "" : String(v);
  }
  state.formFilled = true;
}

// "—" for a value that is not there (as opposed to the literal empty string).
function fmtEditValue(value) {
  return isAbsent(value) ? "—" : String(value);
}

// An empty editor that invites typing is how a good config gets overwritten with
// blanks, so when there is a config file but it cannot be read (a stopped
// container is the usual reason) the fields are locked and the reason is said
// out loud. Readable again on the next refresh.
function setEditFormReadable(readable, cfg) {
  for (const el of editFields) el.disabled = !readable;
  if (readable) {
    if (state.unreadableNotice) {
      state.unreadableNotice = false;
      setMessage("");
    }
    return;
  }
  const file = cfg?.configFile || cfg?.files?.main || "";
  state.unreadableNotice = true;
  if (!file) {
    // No config file at all — the panel's own setup notice / config picker says
    // what to do about that; here it just must not look editable.
    setMessage(t("state.noConfig"), "warn");
    return;
  }
  setMessage(tp("edit.configUnreadable", { file }), "warn");
}

function renderDiff() {
  const { items, cleared } = configEdits();
  const readable = !!state.config?.hasConfig;
  els.diffBox.hidden = !readable || items.length === 0;
  els.diffList.replaceChildren();
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = `${fieldLabel(it.key)}: ${fmtEditValue(it.old)} → ${fmtEditValue(it.next)}`;
    els.diffList.append(li);
  }
  // A field the user emptied is a change worth showing, but it cannot be written:
  // say so instead of dropping it silently (the save is held back — see save()).
  if (readable && cleared.length) {
    const note = document.createElement("li");
    note.className = "diff-note";
    note.textContent = t("edit.clearUnsupported");
    els.diffList.append(note);
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
      // Refill when the ANSWER changes — a different file OR the same file whose
      // values were not readable before (a name-only guard left the form blank
      // forever). Identical values are left alone, so a poll never stomps what
      // the user is typing.
      if (needsRefill(state.configFilled, cfg)) {
        fillEditForm(cfg.values || {});
        state.configFilled = { file: cfg.configFile, values: valuesFingerprint(cfg.values) };
      }
      setEditFormReadable(true, cfg);
    } else {
      state.formFilled = false;
      state.configFilled = null;
      setEditFormReadable(false, cfg);
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

// Save the parameter edits.
//
// There is deliberately no "save & restart" button: this editor is only visible
// while the service is STOPPED (`els.settingsBox.hidden = isSetup || running`),
// so there is nothing to restart. The old button did not simply no-op —
// `restart()` on a stopped deployment fails its stop phase, waits 3 s and then
// STARTS the service, so "save & restart" quietly meant "save & start". Plain
// save is also what the params want: every edited field is restart-gated, so it
// takes effect at the next start (the success message says so via
// `edit.restartRequired`).
//
// If running-state editing of the instant-effect params ever returns, the way
// back is already in place on the backend: POST /settings still accepts a
// restart flag alongside the edits and runs restartService after a successful
// save (the panel itself no longer sends one).
async function save() {
  if (state.working) return;
  const { payload: edits, cleared } = configEdits();
  if (cleared.length) {
    // Never send an empty value: the writer rewrites flags, it cannot remove them.
    setMessage(t("edit.clearUnsupported"), "warn");
    return;
  }
  if (!Object.keys(edits).length) {
    setMessage(t("edit.noEdits"), "warn");
    return;
  }

  state.working = true;
  paint(state.status || { state: "stopped" });
  setMessage(t("edit.saving"), "info");
  try {
    const result = await api("settings", { method: "POST", body: JSON.stringify({ edits }) });
    applySaveResult(result);
  } catch (e) {
    setMessage(String(e?.message || e), "error");
  } finally {
    state.working = false;
    await refresh();
  }
}

// ── Configuration page: manage environment profiles ─────────────────────
//
// A profile is one way to run Strata (local source or container). The list
// shows every profile; the inline editor creates/edits one. While a service is
// running the backend refuses edits/deletes and the buttons are disabled.

let pluginFormEls = null;
let editorType = "local";
// The card-model catalog (GET /presets), the same one the settings page loads.
let gpuModels = [];
let presetsLoaded = false;
// Where a local deployment's effective key would come from (name + boolean
// only), refreshed from GET /profiles.
let keySource = { file: "", hasKey: false };

async function loadPanelPresets() {
  if (presetsLoaded) return;
  try {
    const data = await api("presets");
    gpuModels = Array.isArray(data?.models) ? data.models : [];
    presetsLoaded = true;
  } catch {
    // The picker stays usable with the profile's own value; only the catalog is
    // missing.
    presetsLoaded = false;
  }
}

function canCopyPath() {
  return typeof hana?.clipboard?.writeText === "function";
}
function canOpenPath() {
  return typeof hana?.resources?.open === "function";
}

function ensurePluginForm() {
  if (pluginFormEls) return pluginFormEls;
  const tpl = document.getElementById("pluginSettingsTemplate");
  if (!tpl) return null;
  // The editor lives in a <template>; clone it into a detached fragment that
  // parks #psEditor while the drawer is closed and holds it between opens.
  const root = tpl.content.cloneNode(true);
  pluginFormEls = {
    root,
    editor: root.querySelector("#psEditor"),
    editorTitle: root.querySelector("#psEditorTitle"),
    name: root.querySelector("#ps-name"),
    type: root.querySelector("#ps-type"),
    localFields: root.querySelector("#psLocalFields"),
    containerFields: root.querySelector("#psContainerFields"),
    strataDir: root.querySelector("#ps-strataDir"),
    pythonPath: root.querySelector("#ps-pythonPath"),
    gpu: root.querySelector("#ps-gpu"),
    imageName: root.querySelector("#ps-imageName"),
    imageTag: root.querySelector("#ps-imageTag"),
    imagePull: root.querySelector("#ps-imagePull"),
    imageStatus: root.querySelector("#ps-imageStatus"),
    containerName: root.querySelector("#ps-containerName"),
    // The local source's model folder / port; a container owns its own pair.
    ggufDir: root.querySelector("#ps-ggufDir"),
    port: root.querySelector("#ps-port"),
    message: root.querySelector("#psMessage"),
  };
  // The full new container model (card model + vendor split, model bind pair,
  // list fields, compose directory) is the SAME module the settings page uses,
  // rendered into #ps-container-extra.
  pluginFormEls.container = createContainerFields(root.querySelector("#ps-container-extra"), {
    idPrefix: "ps-",
    api,
    notify: setPsMessage,
    apiKeySource: () => keySource,
    copyText: canCopyPath()
      ? (text) => {
          // The advanced group's "copy path" button: report the outcome into the
          // drawer's own message line instead of swallowing it.
          void copyText(text).then(async (res) => {
            if (res.ok) setPsMessage(t("common.copied"), "ok");
            else setPsMessage(await copyFailureMessage(res), "error");
          });        }
      : null,
    openDir: canOpenPath()
      ? (path) => {
          Promise.resolve(hana.resources.open({ kind: "local-file", path })).catch(() =>
            setPsMessage(t("field.openDirFailed"), "error"),
          );
        }
      : null,
    profileId: () => state.editingProfileId || "",
    containerName: () => pluginFormEls?.containerName?.value || "",
  });
  // The LOCAL profile's own override: the same fragment the container block
  // mounts, so the mask semantics and the "in effect" line cannot drift.
  pluginFormEls.localApiKey = createApiKeyField(root.querySelector("#ps-local-extra"), {
    idPrefix: "psl-",
    apiKeySource: () => keySource,
  });
  // Switching the profile type toggles which fields apply (edit mode only; the
  // select is disabled in the read-only view).
  pluginFormEls.type.addEventListener("change", () => setEditorType(pluginFormEls.type.value));
  pluginFormEls.imagePull.addEventListener("click", panelPullImage);
  pluginFormEls.imageName.addEventListener("input", renderPanelImage);
  pluginFormEls.imageTag.addEventListener("input", renderPanelImage);
  // The resolved compose-directory line is derived from the container name, so
  // it must be re-probed as the user edits it.
  pluginFormEls.containerName.addEventListener("input", () => pluginFormEls.container.refreshDeployPath());
  return pluginFormEls;
}

function setEditorType(type) {
  editorType = type === "container" ? "container" : "local";
  pluginFormEls.localFields.hidden = editorType !== "local";
  pluginFormEls.containerFields.hidden = editorType !== "container";
  renderPanelImage();
}

function fillProfileEditorFields(profile) {
  pluginFormEls.name.value = profile?.name || "";
  pluginFormEls.type.value = profile?.type || "local";
  pluginFormEls.strataDir.value = profile?.strataDir || "";
  pluginFormEls.pythonPath.value = profile?.pythonPath || "";
  pluginFormEls.gpu.value = profile?.gpu || "";
  pluginFormEls.imageName.value = profile?.imageName || "";
  pluginFormEls.imageTag.value = profile?.imageTag || "";
  pluginFormEls.containerName.value = profile?.containerName || "";
  pluginFormEls.ggufDir.value = profile?.ggufDir || "";
  pluginFormEls.port.value = profile?.port ? String(profile.port) : "";
  // The local override (masked when set); the source line follows it.
  pluginFormEls.localApiKey.render(profile?.apiKey || "");
  // The container block preserves any field it does not render (see the shared
  // module), so nothing needs to be carried here.
  pluginFormEls.container.render(profile);
  setEditorType(pluginFormEls.type.value);
}

function setProfileEditorReadOnly(readOnly) {
  if (!pluginFormEls) return;
  for (const el of pluginFormEls.editor.querySelectorAll("input, select")) {
    el.disabled = readOnly;
  }
  // The module's add/remove row buttons are not inputs; toggle them too.
  if (pluginFormEls.container) pluginFormEls.container.setReadOnly(readOnly);
  if (pluginFormEls.localApiKey) pluginFormEls.localApiKey.setReadOnly(readOnly);
  if (pluginFormEls.message) pluginFormEls.message.hidden = readOnly;
  // A write-side action is never offered in the read-only view.
  if (readOnly && pluginFormEls.imagePull) pluginFormEls.imagePull.hidden = true;
}

// Open the shared profile drawer for the CURRENT environment. `readOnly` is the
// running-view variant; the editable variant is only reachable while stopped.
async function openDrawer(readOnly) {
  if (state.working || !ensurePluginForm() || !els.profileDrawer.hidden) return;
  let profile = null;
  let keySourceFromServer = null;
  try {
    const data = await api("profiles");
    const list = Array.isArray(data?.profiles) ? data.profiles : [];
    const activeId = data?.activeProfileId || state.status?.activeProfileId || "";
    profile = list.find((p) => p.id === activeId) || list[0] || state.status?.profile || null;
    keySourceFromServer = data?.keySource;
  } catch (e) {
    showError(String(e?.message || e));
    return;
  }
  if (!profile) return;
  if (keySourceFromServer && typeof keySourceFromServer === "object") {
    keySource = { file: String(keySourceFromServer.file || ""), hasKey: !!keySourceFromServer.hasKey };
  }
  pluginFormEls.localApiKey.refreshSource();
  state.editingProfileId = readOnly ? null : profile.id;
  // The card-model picker needs the catalog before it can hold the profile's
  // value; only the stopped (editable) path ever writes it back.
  await loadPanelPresets();
  pluginFormEls.container.setCatalog(gpuModels);
  fillProfileEditorFields(profile);
  setProfileEditorReadOnly(readOnly);
  setPsMessage("");
  const title = readOnly ? t("profile.viewTitle") : t("profile.editTitle");
  pluginFormEls.editorTitle.textContent = title;
  els.profileDrawerTitle.textContent = title;
  els.profileDrawerBody.replaceChildren(pluginFormEls.editor);
  applyI18n(pluginFormEls.editor);
  pluginFormEls.editor.hidden = false;
  els.profileReadOnlyHint.hidden = !readOnly;
  els.profileDrawerActions.hidden = readOnly;
  els.profileDrawer.hidden = false;
  els.profileDrawerScrim.hidden = false;
  // The panel offers "pull again" for an image that already exists locally.
  if (!readOnly) loadPanelImages();
}

// The header badge (running only) opens the read-only view; the header pencil
// (stopped only) opens the editable one.
function openProfileDetail() {
  if (!RUNNING_STATES.has(state.status?.state)) return;
  openDrawer(true);
}

// Edit the CURRENT environment only — list / create / delete / switch stay in
// the settings page.
function openProfileEditor() {
  if (RUNNING_STATES.has(state.status?.state)) return;
  openDrawer(false);
}

function closeProfileDetail() {
  if (!pluginFormEls) return;
  if (els.profileDrawer.hidden) return;
  pluginFormEls.root.append(pluginFormEls.editor);
  setProfileEditorReadOnly(false);
  pluginFormEls.editor.hidden = true;
  setPsMessage("");
  state.editingProfileId = null;
  stopPanelPull();
  panelImagesLoaded = false;
  if (pluginFormEls?.imageStatus) {
    pluginFormEls.imageStatus.textContent = "";
    pluginFormEls.imageStatus.className = "field-hint";
  }
  els.profileReadOnlyHint.hidden = true;
  els.profileDrawerActions.hidden = true;
  els.profileDrawer.hidden = true;
  els.profileDrawerScrim.hidden = true;
}

// The drawer's fields, shaped like the save route expects (mirrors the
// settings page's profile form). The container block comes straight from the
// shared field module; `ggufDir`/`port` belong to a local profile only (sending
// them on a container would re-trigger the legacy flat-field migration).
function collectProfileEdits() {
  const type = pluginFormEls.type.value === "container" ? "container" : "local";
  const body = {
    id: state.editingProfileId,
    name: pluginFormEls.name.value.trim(),
    type,
  };
  if (type === "container") {
    body.imageName = pluginFormEls.imageName.value.trim();
    body.imageTag = pluginFormEls.imageTag.value.trim();
    body.containerName = pluginFormEls.containerName.value.trim();
    Object.assign(body, pluginFormEls.container.collect());
  } else {
    body.ggufDir = pluginFormEls.ggufDir.value.trim();
    body.port = Number(pluginFormEls.port.value) || 0;
    body.strataDir = pluginFormEls.strataDir.value.trim();
    body.pythonPath = pluginFormEls.pythonPath.value.trim();
    body.gpu = pluginFormEls.gpu.value.trim();
    // The local override: the mask round-trips as "unchanged", empty clears.
    body.apiKey = pluginFormEls.localApiKey.value();
  }
  return body;
}

// ── Image re-pull (panel) ──────────────────────────────────────────────
//
// The panel only offers "pull again", and only for an image that already exists
// locally — acquiring a missing image is the settings page's job. Same backend
// flow as the settings page: POST /images/pull + GET /images/pull polling.

let panelImages = [];
let panelImagesLoaded = false;
let panelImagesAvailable = false;
let panelPullTimer = null;

function panelImageInputRef() {
  return imageRefOf({
    imageName: pluginFormEls.imageName.value,
    imageTag: pluginFormEls.imageTag.value,
  });
}

function panelImageExists(ref) {
  const want = String(ref || "").toLowerCase();
  if (!want) return false;
  for (const img of panelImages) {
    const repo = String(img?.repository || "").toLowerCase();
    const tag = String(img?.tag || "").toLowerCase();
    if (String(img?.ref || "").toLowerCase() === want) return true;
    if (repo && tag && `${repo}:${tag}` === want) return true;
    // An omitted/`latest` tag matches the bare repository name.
    if (repo && (!tag || tag === "<none>" || tag === "latest") && repo === want) return true;
  }
  return false;
}

function renderPanelImage() {
  if (!pluginFormEls?.imagePull) return;
  const local = panelImagesLoaded && panelImagesAvailable && panelImageExists(panelImageInputRef());
  pluginFormEls.imagePull.hidden = !local;
}

async function loadPanelImages() {
  try {
    const data = await api("images");
    panelImagesAvailable = data?.available !== false;
    panelImages = Array.isArray(data?.images) ? data.images : [];
  } catch {
    panelImagesAvailable = false;
    panelImages = [];
  }
  panelImagesLoaded = true;
  renderPanelImage();
}

function stopPanelPull() {
  if (panelPullTimer) {
    window.clearInterval(panelPullTimer);
    panelPullTimer = null;
  }
}

function setPanelPullStatus(text, kind = "") {
  if (!pluginFormEls?.imageStatus) return;
  pluginFormEls.imageStatus.textContent = text || "";
  pluginFormEls.imageStatus.className = kind ? `field-hint ${kind}` : "field-hint";
}

async function pollPanelPull(ref) {
  let st = null;
  try {
    st = await api("images/pull");
  } catch {
    stopPanelPull();
    return;
  }
  if (st?.running) {
    const tail = Array.isArray(st.tail) && st.tail.length ? st.tail[st.tail.length - 1] : "";
    setPanelPullStatus(tp("field.imagePullBusy", { image: st.image || ref, tail }), "info");
    return;
  }
  stopPanelPull();
  if (st?.ok) {
    panelImagesLoaded = false;
    await loadPanelImages();
    setPanelPullStatus(tp("field.imagePulled", { image: st.image || ref }), "ok");
  } else {
    setPanelPullStatus(tp("field.imagePullFailed", { error: st?.error || "" }), "error");
  }
}

async function panelPullImage() {
  const ref = panelImageInputRef();
  if (!ref || state.working) return;
  setPanelPullStatus(tp("field.imagePullBusy", { image: ref, tail: "" }), "info");
  try {
    const res = await api("images/pull", { method: "POST", body: JSON.stringify({ image: ref }) });
    const st = res?.state || res;
    if (st?.running) {
      stopPanelPull();
      panelPullTimer = window.setInterval(() => pollPanelPull(ref), 1500);
    } else if (st?.ok) {
      panelImagesLoaded = false;
      await loadPanelImages();
      setPanelPullStatus(tp("field.imagePulled", { image: ref }), "ok");
    } else {
      setPanelPullStatus(tp("field.imagePullFailed", { error: st?.error || "" }), "error");
    }
  } catch (e) {
    // 409: another surface already started a pull — follow it.
    if (e?.data?.already && e.data.state?.running) {
      stopPanelPull();
      panelPullTimer = window.setInterval(() => pollPanelPull(ref), 1500);
      return;
    }
    setPanelPullStatus(tp("field.imagePullFailed", { error: String(e?.message || e) }), "error");
  }
}

// Save-time validation is the backend's (lib/profiles.js validateProfile); its
// `validation` codes map to the same localized copy the settings page uses.
const SAVE_ERROR_KEYS = {
  nameRequired: "profile.errNameRequired",
  nameTaken: "profile.errNameTaken",
  imageRequired: "profile.errImageRequired",
  containerNameRequired: "profile.errContainerNameRequired",
  gpuModelRequired: "profile.errGpuModelRequired",
  gpuModelUnknown: "profile.errGpuModelUnknown",
  portInvalid: "profile.errPortInvalid",
};

async function saveProfileEdit() {
  if (state.working || !state.editingProfileId || !pluginFormEls) return;
  state.working = true;
  els.profileDrawerSave.disabled = true;
  setPsMessage(t("profile.saving"), "info");
  let ok = false;
  try {
    await api("profiles/save", { method: "POST", body: JSON.stringify(collectProfileEdits()) });
    ok = true;
  } catch (e) {
    const code = (e?.validation || [])[0];
    setPsMessage(code && SAVE_ERROR_KEYS[code] ? t(SAVE_ERROR_KEYS[code]) : String(e?.message || e), "error");
  } finally {
    state.working = false;
    if (els.profileDrawerSave) els.profileDrawerSave.disabled = false;
  }
  if (ok) {
    closeProfileDetail();
    await refresh();
  }
}

function setPsMessage(text, kind = "info") {
  if (!pluginFormEls) return;
  pluginFormEls.message.textContent = text || "";
  pluginFormEls.message.className = `message ${kind}`;
}

// The backend also reports which readiness fields are still empty, as stable
// keys (lib/profiles.js `missingProfileFields`); name them with the form's own
// field copy so the hint and the editor say the same thing.
const START_FIELD_LABELS = {
  strataDir: "field.strataDir",
  image: "field.imageName",
  containerName: "field.containerName",
};

function missingStartFields(profile) {
  return (profile?.missing || []).map((key) => t(START_FIELD_LABELS[key] || key));
}

// Why the selected profile cannot start yet: the concrete missing fields when
// that is the reason, otherwise a generic line (the block can be environmental
// — e.g. a missing Python interpreter — and is not a missing field).
function startBlockedMessage(profile) {
  const missing = missingStartFields(profile);
  return missing.length ? tp("profile.missingFields", { fields: joinList(missing) }) : t("profile.notReady");
}

// Setup states (no usable profile yet) used to open the in-panel profile
// manager. The panel no longer manages profiles; point at the Settings page.
function paintSetupNotice(s) {
  const show = SETUP_STATES.has(s.state);
  els.statusConfigBox.hidden = !show;
}

// ── Current environment: switching + startability ──────────────────────
//
// "Which environment" and "can it start" are two different questions. The
// header picker owns the first; the start button owns the second.

// The start button starts the CURRENT environment. Its readiness is the
// backend's verdict, which layers the environment checks (docker present,
// server.py, Python) on top of the readiness fields.
function canStartCurrent(s) {
  return s?.launch?.canStart !== false;
}

// Rebuild the picker's options only when the set of profiles changes, so a poll
// never resets an open dropdown.
let envOptionsKey = "";

function renderEnvOptions(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const key = list.map((p) => `${p.id}:${p.name}:${p.type}`).join("|");
  if (key === envOptionsKey) return;
  envOptionsKey = key;
  els.envSelect.replaceChildren();
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p.id;
    // Name + type, the same pair the running badge shows.
    opt.textContent = `${p.name || p.id} · ${profileTypeLabel(p.type)}`;
    els.envSelect.append(opt);
  }
  els.envSelect.value = "";
}

// "Cannot start" is a property of the current environment, so the hint hangs on
// the status card next to the start button — not on the picker.
function paintStartHint(s) {
  const blocked = !els.actionBtn.hidden && s?.state !== "unsupported" && !canStartCurrent(s);
  els.startOptionsHint.hidden = !blocked;
  els.startOptionsHint.textContent = blocked ? startBlockedMessage(s.profile) : "";
}

// Switching the current environment persists the choice (POST /profiles/select —
// the same route the start flow uses) and then refreshes everything, so the
// status / version / service-config cards follow the new environment.
async function selectEnv(id) {
  if (state.working || !id || id === state.status?.activeProfileId) return;
  state.working = true;
  els.envSelect.disabled = true;
  showError("");
  try {
    await api("profiles/select", { method: "POST", body: JSON.stringify({ id }) });
  } catch (e) {
    showError(String(e?.message || e));
  } finally {
    state.working = false;
    await refresh();
  }
}

// Config selection: persist the pick server-side, then reload every card. The
// backend refuses a running service, so no front-end guard is relied on.
async function selectConfigFile(file) {
  if (state.working || !file || file === state.status?.configFile) return;
  state.working = true;
  els.configFileSelect.disabled = true;
  els.configSetupBtn.disabled = true;
  showError("");
  try {
    await api("config/select", { method: "POST", body: JSON.stringify({ file }) });
  } catch (e) {
    showError(String(e?.message || e));
  } finally {
    state.working = false;
    await refresh();
  }
}

// Build a NEW config: the backend runs the same setup job as a first launch
// (without the trailing start); progress is polled through GET /start, the one
// staged-progress contract, via the shared first-run overlay.
async function startConfigSetup() {
  if (state.working) return;
  state.working = true;
  els.configFileSelect.disabled = true;
  els.configSetupBtn.disabled = true;
  showError("");
  try {
    const res = await api("config/setup", { method: "POST" });
    if (res && res.running !== false) {
      showFirstRunOverlay(res, "configPick.running");
      await waitForFirstRun();
      return;
    }
    endWorking();
    await refresh();
  } catch (e) {
    const message = String(e?.message || e);
    endWorking();
    await refresh();
    showError(message);
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
els.profileBadge.addEventListener("click", openProfileDetail);
els.profileEditBtn.addEventListener("click", openProfileEditor);
els.profileDrawerSave.addEventListener("click", saveProfileEdit);
els.envSelect.addEventListener("change", () => selectEnv(els.envSelect.value));
els.configFileSelect.addEventListener("change", () => selectConfigFile(els.configFileSelect.value));
els.configSetupBtn.addEventListener("click", () => {
  if (state.working) return;
  showConfirm({
    title: t("configPick.confirmTitle"),
    sub: tp("firstRun.confirmSub", {
      dir: state.status?.profile?.ggufDir || t("firstRun.noGgufDir"),
    }),
    confirmText: t("configPick.confirmAction"),
    trigger: els.configSetupBtn,
    onConfirm: startConfigSetup,
  });
});
els.profileDrawerClose.addEventListener("click", closeProfileDetail);
els.profileDrawerScrim.addEventListener("click", closeProfileDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.profileDrawer.hidden) {
    e.preventDefault();
    closeProfileDetail();
  }
});
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
    if (!canStartCurrent(s)) {
      showError(startBlockedMessage(s.profile));
      return;
    }
    const profileId = s.profile?.id;
    if (needsFirstRun(s) && s.profile?.type === "local") {
      showConfirm({
        title: t("firstRun.confirmTitle"),
        sub: tp("firstRun.confirmSub", {
          dir: s.profile?.ggufDir || t("firstRun.noGgufDir"),
        }),
        confirmText: t("firstRun.confirmAction"),
        trigger: els.actionBtn,
        onConfirm: () => act("start", profileId),
      });
    } else {
      act("start", profileId);
    }
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
els.saveBtn.addEventListener("click", () => save());
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
  envOptionsKey = "";
  if (state.status) paint(state.status);
  if (!els.profileDrawer.hidden && pluginFormEls) {
    const title = state.editingProfileId ? t("profile.editTitle") : t("profile.viewTitle");
    pluginFormEls.editorTitle.textContent = title;
    els.profileDrawerTitle.textContent = title;
    // The shared container block re-renders its own static copy + option labels.
    pluginFormEls.container.relocalize();
    pluginFormEls.localApiKey.relocalize();
  }
  renderDiff();
}

// Localize the static markup and the not-yet-cloned templates before boot.
applyI18n();
for (const tpl of document.querySelectorAll("template")) applyI18n(tpl.content);
initLangSelect();

// Handshake with the host, then start polling.
hana.ready();
refresh().then(schedule);
