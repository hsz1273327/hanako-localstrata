// hanako-localstrata v2 card logic.
// - Handshake through the App UI SDK (hana.ready()).
// - Routes are called via hana.api.fetch (carries this App's surface session).
// - Clipboard / external links go through hana.clipboard / hana.external.
// - Polls this App's GET /status route every refreshSec seconds.
import { hana } from "./sdk.js";
import { LANGS, LANG_NAMES, loadLang, saveLang, setLang, getLang, t, tp, joinList, applyI18n } from "./i18n.js";
import { createContainerFields, createApiKeyField } from "./profile-fields.js";
import { isAbsent, editDiff, valuesFingerprint, needsRefill } from "./edit-diff.js";
import { createSetupFacts } from "./setup-facts.js";
import { backupDefaultName } from "./backup-name.js";
import { copyToClipboard } from "./clipboard.js";
import { parallelTier, parallelBounds, parallelDefault, PARALLEL_OFF } from "./parallel-tier.js";
import { versionRowPlan, compareVersions } from "./version-row.js";
import {
  canSelectProfile,
  profileTypeLabel,
  renderProfileOptions,
  requestProfileSelect,
} from "./profile-picker.js";

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
  setupParams: document.getElementById("setupParams"),
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
  setupFactsBox: document.getElementById("setupFactsBox"),
  confirmScrim: document.getElementById("confirmScrim"),
  saveBtn: document.getElementById("saveBtn"),
  diffBox: document.getElementById("diffBox"),
  diffList: document.getElementById("diffList"),
  editMessage: document.getElementById("editMessage"),
  modelDirNow: document.getElementById("ed-modelDirNow"),
  modelDirFile: document.getElementById("ed-modelDirFile"),
  parallelOn: document.getElementById("ed-parallelOn"),
  parallelField: document.getElementById("ed-parallelField"),
  parallel: document.getElementById("ed-parallel"),
  parallelTier: document.getElementById("ed-parallelTier"),
  parallelRange: document.getElementById("ed-parallelRange"),
  parallelBlocked: document.getElementById("ed-parallelBlocked"),
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
// Moved to ui/assets/version-row.js (with the update-row decision) and re-exported so
// this file keeps one copy of the rule.

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
  // An unknown local version stays an em dash — the row never invents a number. But it
  // no longer hides the update action: versionRowPlan() treats "unknown" as "not
  // provably up to date" (see ui/assets/version-row.js).
  const local = typeof version?.local === "string" ? version.local : null;
  const latest = typeof version?.latest === "string" ? version.latest : null;
  rows.push([t("label.version"), local || "—"]);
  const plan = versionRowPlan({ state: s?.state, local, latest, checkState: version?.checkState });
  if (plan === "action-update" || plan === "hint-stop") {
    rows.push([
      t("label.latestVersion"),
      tp("version.available", { version: latest }),
      "update",
      undefined,
      plan === "hint-stop" ? t("version.stopToUpdate") : undefined,
      plan === "hint-stop" ? undefined : { label: t("common.update"), onClick: (btn) => promptUpdate(latest, btn) },
    ]);
  } else if (plan === "up-to-date") {
    rows.push([t("label.latestVersion"), t("version.upToDate")]);
  } else if (version?.checkState === "error") {
    rows.push([t("label.latestVersion"), t("version.checkFailed")]);
  } else if (latest) {
    rows.push([t("label.latestVersion"), latest]);
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

// Current profile name + type marker (shown while a service is running).
// The "current environment" control in the header. While running it is the
// read-only name·type badge (clicking it opens the read-only detail drawer);
// while stopped it is a picker that switches the current environment.
// The option list and the guard live in ui/assets/profile-picker.js, shared with the
// slim card; `envOptionsCache` is this document's own key so a poll never rebuilds
// the dropdown under the user's hand.
const envOptionsCache = { key: "" };

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
    renderProfileOptions(els.envSelect, s.profiles, envOptionsCache);
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
  // Where this environment writes its products. The value comes from the
  // PROFILE (setup's own remembered `data_dir` is not consulted any more), so the
  // row says where it comes from; an empty one shows as "—" and is already named
  // by the "missing fields" line next to the start button.
  if (prof && prof.type !== "container" && !SETUP_STATES.has(s.state)) {
    rows.push([t("field.localDataDir"), prof.dataDir || "—", null, null, t("label.dataDirSource")]);
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
  // ALWAYS the same four rows, in the same order, each "—" until it is measured.
  // Omitting a row when its number was missing made the block grow and shrink a row
  // at a time (and, with the old visibility rule, disappear entirely); the metrics
  // legitimately go quiet whenever the log's last 512 KB holds no timed request.
  const value = (v, unit) => (Number.isFinite(v) ? `${v}${unit}` : "—");
  renderKvRows(els.speedRows, [
    [t("label.tg"), value(m?.tg, " t/s")],
    [t("label.pp"), value(m?.pp, " t/s")],
    [t("label.expertCache"), value(m?.expertCacheHit, "%")],
    [t("label.kvHit"), value(m?.kvHit, "%")],
  ]);
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
  renderParallelNow(s);
  // The tier depends on the card the service reports; refresh it with the status, but
  // never re-read the field's value here (that would step on what the user is typing).
  syncParallelUi();
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
  // PERFORMANCE is a STATE of the service, not a sample of the log.
  //
  // It used to be `!els.speedRows.children.length`, i.e. hidden whenever the metrics
  // came back empty — and they do come back empty periodically: `readRecentLogs`
  // parses only the log's last 512 KB (`parseMetrics(readTail(file))`), so once a
  // quiet stretch (or a long log that scrolled past the last timed request) pushes
  // the "… generated in N ms (X tok/s)" lines out of that window, every number is
  // null. The block then blinked out at the 5 s refresh and came back on the next
  // request — a data condition driving a layout decision.
  //
  // The rule now: visible while the service is up (running, or coming up/going
  // down), and the rows say "—" while nothing has been measured yet (renderKvRows's
  // empty case). Visibility no longer depends on a field that legitimately goes
  // quiet.
  els.speedBox.hidden = isSetup || !(isRunning || isBusy);
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
  if (els.confirmScrim) els.confirmScrim.hidden = true;
  els.confirmPopover.setAttribute("aria-modal", "false");
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
  // The scrim swallows the click instead of cancelling: a confirm that guards a
  // heavy operation (and may hold a form) is not dismissed by a stray click. The
  // drawer's own scrim does close its drawer — a view, not a decision.
  if (els.confirmScrim && ev.target === els.confirmScrim) return;
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

function showConfirm({ title, sub, confirmText, cancelText, onConfirm, trigger, timeout, body } = {}) {
  closeConfirm();
  els.confirmTitle.textContent = title || "";
  els.confirmSub.textContent = sub || "";
  els.confirmSub.hidden = !sub;
  // The setup parameters belong to the "Run setup…" dialog only; every other
  // dialog must not inherit them. The caller re-shows it when it wants it.
  if (els.setupParams) els.setupParams.hidden = !body;
  // A MODAL-ish confirm: a scrim over the whole panel so a click cannot reach the
  // main controls behind it. It does NOT dismiss the dialog (see
  // confirmDocPointerDown): this one guards a heavy operation and may hold a
  // half-filled form, so undoing it takes the explicit Cancel/confirm buttons.
  if (els.confirmScrim) els.confirmScrim.hidden = false;
  els.confirmPopover.setAttribute("aria-modal", "true");
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
  expertCache: "edit.expertCache",
  residentBudget: "edit.residentBudget",
  vramReserve: "edit.vramReserve",
  prefill: "edit.prefill",
  poolWorkers: "edit.poolWorkers",
  vramElastic: "edit.vramElastic",
  specMinP: "edit.specMinP",
  suffixDraft: "edit.suffixDraft",
  conversationSlots: "edit.conversationSlots",
  lowRamMode: "edit.lowRam",
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
  renderModelDirNow(values);
  // A freshly loaded config is the only time the concurrency switch re-reads its value
  // from the file (see syncParallelUi).
  syncParallelUi({ resetValue: true });
}

// ── Concurrency: a switch plus a number, not a 1/2/3 pick ───────────────────
//
// "One request at a time" and "off" are the same thing — an ABSENT `parallel` key — so the
// switch writes the key or removes it (the writer's `top-key` op). The tier comes from the
// card's TOTAL VRAM (ui/assets/parallel-tier.js): 8 GB cannot, 12 GB can but is told not
// to, and from 16 GB up each tier has its own recommendation and ceiling.
function parallelTotalMiB() {
  const gpu = state.status?.resources?.gpu || {};
  const mib = Number(gpu.totalMiB);
  return Number.isFinite(mib) && mib > 0 ? mib : null;
}

function vramTierText(totalMiB) {
  return totalMiB === null ? "" : String(Math.round(totalMiB / 1024));
}

function syncParallelUi({ resetValue = false } = {}) {
  if (!els.parallelOn) return;
  const total = parallelTotalMiB();
  const tier = parallelTier(total);
  const bounds = parallelBounds(total);
  const configured = Number(state.config?.values?.parallel ?? PARALLEL_OFF);
  const on = configured >= 2;

  // `.disabled` is a property of the MACHINE (the 8 GB tier) and is refreshed on every
  // paint. `.checked` is the USER'S INTENT: it may only come from the config file on a
  // fresh load (`resetValue`). This function is called from paint() every 5 s AND from
  // `onParallelSwitch` itself, so writing `.checked` here made every click snap straight
  // back — which reads as "the switch cannot be clicked at all".
  els.parallelOn.disabled = tier.disabled;
  if (resetValue) {
    els.parallelOn.checked = on;
    els.parallel.value = String(on ? configured : PARALLEL_OFF);
  }
  els.parallelField.hidden = !els.parallelOn.checked;
  els.parallel.min = String(bounds.min);
  els.parallel.max = String(bounds.max);

  const vram = vramTierText(total);
  els.parallelTier.textContent = tier.disabled
    ? ""
    : total === null
      ? t("edit.parallelNoGpu")
      : tp(tier.warn ? "edit.parallelTierWarn" : "edit.parallelTier", {
        vram,
        def: String(tier.recommended),
        max: String(tier.max),
      });
  els.parallelRange.textContent = on ? tp("edit.parallelRange", { min: String(bounds.min), max: String(bounds.max) }) : "";
  els.parallelBlocked.hidden = !tier.disabled;
  els.parallelBlocked.textContent = tier.disabled ? tp("edit.parallelBlocked8", { vram }) : "";
}

function onParallelSwitch() {
  const total = parallelTotalMiB();
  const tier = parallelTier(total);
  if (els.parallelOn.checked) {
    if (tier.disabled) {
      els.parallelOn.checked = false;
      return;
    }
    els.parallel.value = String(parallelDefault(total));
    els.parallelField.hidden = false;
  } else {
    els.parallel.value = String(PARALLEL_OFF);
    els.parallelField.hidden = true;
  }
  syncParallelUi();
  renderDiff();
}

// The model group's read-only item reports the CURRENT value (the config's own
// `--native`), never the input: it answers "what is this file reading now?" while
// the user is changing it. Unlike `.field-default` this is not a "what happens if
// you leave it empty" note — it follows the loaded config, not the field.
function renderModelDirNow(values) {
  if (!els.modelDirNow || !els.modelDirFile) return;
  const dir = values?.modelDir;
  const file = values?.modelFile;
  els.modelDirNow.textContent = isAbsent(dir) ? "—" : String(dir);
  els.modelDirFile.textContent = isAbsent(file)
    ? ""
    : tp("edit.modelDirFile", { file: String(file).split(/[\\/]/).pop() });
}

// "—" for a value that is not there (as opposed to the literal empty string).
function fmtEditValue(value) {
  return isAbsent(value) ? "—" : String(value);
}

function renderParallelNow(s) {
  // Two numbers, side by side: what this config ASKS FOR (`parallel`, 1 = the default) and
  // how many slots the engine actually opened. They differ when the sessions do not fit
  // — the engine then runs fewer and says so (its log + `batch_slots`), which
  // `docs/BATCHING.md:47` calls normal behaviour, not a failure.
  const el = document.getElementById("ed-parallelNow");
  if (!el) return;
  const configured = String(state.config?.values?.parallel ?? 1);
  const serving = Number(s?.concurrency?.serving);
  el.textContent = Number.isFinite(serving) && serving > 0
    ? tp("edit.parallelNowValue", { configured, serving: String(serving) })
    : tp("edit.parallelNowUnknown", { configured });
}

// "引擎默认：X" is a DISPLAY, never a value.
//
// It shows only while the field is empty, so an empty field still answers "and
// what is in effect right now?" — and the write layer is untouched: an empty field
// still writes nothing (edit-diff's empty-on-empty rule is what keeps the two
// layers from colliding), so the default is never committed by accident.
function renderDefaultHints() {
  for (const field of document.querySelectorAll("#editForm .field")) {
    const control = field.querySelector("[data-key]");
    const line = field.querySelector(".field-default");
    if (!control || !line) continue;
    line.hidden = !isAbsent(control.value);
  }
}

// 表一 lives in the panel's 「配置文件」区 and is built by the shared module
// (ui/assets/setup-facts.js), the same one the settings page mounts. It carries
// the vision row too: whether this config reads images is this FILE's property,
// like MTP, not something that belongs to a profile or to one page.
let panelSetupFacts = null;

function renderSetupFacts(cfg) {
  if (!els.setupFactsBox) return;
  if (!panelSetupFacts) panelSetupFacts = createSetupFacts(els.setupFactsBox);
  panelSetupFacts.render(cfg?.hasConfig ? { setup: cfg.setup, values: cfg.values, vision: visionInfo } : null);
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
  // The default-value lines follow what the inputs now hold, so they come before
  // the diff is drawn and on every keystroke (renderDiff is the input handler).
  renderDefaultHints();
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
    renderSetupFacts(cfg);
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
  // Turning concurrency ON changes what every request costs, so say it BEFORE the write:
  // four facts, all measured (docs/BATCHING.md): the expert cache gives ~0.6 GiB per
  // slot, each request slows down while the total goes up, the KV of every slot lives in
  // RAM, and an engine that cannot fit them opens fewer slots (never a crash).
  if (Number(edits.parallel) >= 2) {
    const mem = state.status?.resources?.mem || {};
    const freeGiB = Number.isFinite(mem.totalGiB) && Number.isFinite(mem.usedGiB)
      ? Math.max(0, Math.round((mem.totalGiB - mem.usedGiB) * 10) / 10)
      : null;
    showConfirm({
      title: t("edit.parallelWarnTitle"),
      sub: tp("edit.parallelWarnBody", { n: Number(edits.parallel), free: freeGiB === null ? "—" : String(freeGiB) }),
      confirmText: t("edit.parallelWarnGo"),
      cancelText: t("edit.parallelWarnStay"),
      trigger: els.saveBtn,
      onConfirm: () => doSave(edits),
    });
    return;
  }
  return doSave(edits);
}

async function doSave(edits) {
  if (state.working) return;
  state.working = true;
  paint(state.status || { state: "stopped" });
  setMessage(t("edit.saving"), "info");
  try {
    const result = await api("settings", { method: "POST", body: JSON.stringify({ edits }) });
    applySaveResult(result);
  } catch (e) {
    // A refused model directory is answered where it was asked: the panel's own
    // message line, translated from the server's code (the write layer attaches
    // `modelDir*` codes so the copy can name the fix, e.g. the shard count).
    const code = (Array.isArray(e?.validation) ? e.validation : []).find((c) =>
      String(c).startsWith("modelDir"),
    );
    setMessage(code ? t(`edit.${code}`) : String(e?.message || e), "error");
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
// The local config's vision state (read-only: setup.py owns that block).
let visionInfo = null;

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
    dataDir: root.querySelector("#ps-data-dir"),
    pythonPath: root.querySelector("#ps-pythonPath"),
    gpu: root.querySelector("#ps-gpu"),
    imageName: root.querySelector("#ps-imageName"),
    imageTag: root.querySelector("#ps-imageTag"),
    imagePull: root.querySelector("#ps-imagePull"),
    imageStatus: root.querySelector("#ps-imageStatus"),
    containerName: root.querySelector("#ps-containerName"),
    // The local source's model folder / port; a container owns its own pair.
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
  // Required, and empty for a profile saved before the field existed.
  pluginFormEls.dataDir.value = profile?.dataDir || "";
  pluginFormEls.pythonPath.value = profile?.pythonPath || "";
  pluginFormEls.gpu.value = profile?.gpu || "";
  pluginFormEls.imageName.value = profile?.imageName || "";
  pluginFormEls.imageTag.value = profile?.imageTag || "";
  pluginFormEls.containerName.value = profile?.containerName || "";
  pluginFormEls.port.value = profile?.port ? String(profile.port) : "";
  // The local override (masked when set); the source line follows it.
  pluginFormEls.localApiKey.render(profile?.apiKey || "");
  // 视觉 is part of 表一 now (it is this config's property, like MTP), so the
  // 本机 block keeps only its own fields and the key override.
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

// The facts that ride along with a profile: which profile is active, where its key
// comes from, and the config's vision state. Extracted from openDrawer because the
// "Run setup…" dialog needs the SAME facts BEFORE it fills its fields: `visionInfo`
// used to be filled only while opening the drawer, so a dialog opened straight from
// the panel had no current vision value, the select fell back to "setup decides",
// and setup's default answer there is "no images" (setup.py:5106) — the run then
// rebuilt the config with 视觉 off and the user never asked for it.
//
// It was worse than a missing prefill: the payload was read from a `const` declared
// inside the `try`, so this line threw a ReferenceError on EVERY drawer open and
// `visionInfo` was never set at all. Kept as a plain object read from an OUTER
// binding now — test/ui-modules.test.js pins that shape.
async function loadProfileFacts() {
  let profileData = null;
  try {
    profileData = await api("profiles");
  } catch (e) {
    showError(String(e?.message || e));
    return null;
  }
  const list = Array.isArray(profileData?.profiles) ? profileData.profiles : [];
  const activeId = profileData?.activeProfileId || state.status?.activeProfileId || "";
  const profile = list.find((p) => p.id === activeId) || list[0] || state.status?.profile || null;
  const src = profileData?.keySource;
  if (src && typeof src === "object") {
    keySource = { file: String(src.file || ""), hasKey: !!src.hasKey };
  }
  visionInfo = profileData?.vision && typeof profileData.vision === "object" ? profileData.vision : null;
  return { profile, vision: visionInfo };
}

// Open the shared profile drawer for the CURRENT environment. `readOnly` is the
// running-view variant; the editable variant is only reachable while stopped.
async function openDrawer(readOnly) {
  if (state.working || !ensurePluginForm() || !els.profileDrawer.hidden) return;
  const facts = await loadProfileFacts();
  const profile = facts?.profile;
  if (!profile) return;
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
// shared field module; `port` belongs to a local profile only (sending
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
    body.port = Number(pluginFormEls.port.value) || 0;
    body.strataDir = pluginFormEls.strataDir.value.trim();
    body.dataDir = pluginFormEls.dataDir.value.trim();
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
  dataDirRequired: "profile.errDataDirRequired",
  gpuModelRequired: "profile.errGpuModelRequired",
  gpuModelUnknown: "profile.errGpuModelUnknown",
  portInvalid: "profile.errPortInvalid",
};

async function saveProfileEdit() {
  if (state.working || !state.editingProfileId || !pluginFormEls) return;
  // The same required-field check the backend runs (validateProfile), done here
  // first so the message lands without a round trip. A local profile's data
  // directory is required and has no default.
  if (pluginFormEls.type.value !== "container" && !pluginFormEls.dataDir.value.trim()) {
    setPsMessage(t("profile.errDataDirRequired"), "error");
    return;
  }
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
  dataDir: "field.localDataDir",
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
  // The guard and the request live in ui/assets/profile-picker.js, shared with the slim
  // card; the error surface and the refresh stay here (each host owns its own).
  if (!canSelectProfile({ working: state.working, id, activeId: state.status?.activeProfileId })) return;
  state.working = true;
  els.envSelect.disabled = true;
  showError("");
  try {
    await requestProfileSelect(api, id);
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

// Run setup: the backend runs the same job as a first launch (`--setup --yes
// --no-start`), without the trailing start; progress is polled through GET
// /start, the one staged-progress contract, via the shared first-run overlay.
// This is THE "re-run setup to change settings" entry — with the boundary the
// copy states: it rebuilds from setup's recommended answers, so a specific
// setting means running setup.py with its flag.
// Which config file this run will write — said out loud, because it is the one
// thing about "Run setup…" a reader cannot see anywhere else.
//
// setup.py derives it (`tag = fam["tag"] + model` → `ROOT / f"strata-{tag}.json"`,
// setup.py:5034 / :5507) and takes NO name argument (there is no --config/--name),
// so we do not pretend to offer one: we name the expected file instead — the
// current one, since this form cannot change the model — and state the rule for
// the other case (a different family/size = a NEW file).
function renderSetupTarget() {
  const el = document.getElementById("setupTargetFile");
  if (!el) return;
  const file = state.config?.configFile || state.status?.configFile || "";
  el.textContent = file ? tp("configPick.targetNow", { file }) : t("configPick.targetUnknown");
}

// ── the setup parameters (what a "Run setup…" should change) ───────────────
//
// Only setup can set these (the engine does not know `--vision`-as-a-choice,
// `--low-ram` or `--kv-streaming`), and `--context`/`--kv` are here because a
// re-run REBUILDS the config's `args`: measured against setup's own
// `write_setup_config`, a hand-set `--max-context` came back as setup's answer.
// Prefilling the current value is what makes "leave it alone" mean "keep it".
const SETUP_FIELDS = {
  vision: ["no", "yes", "gpu", "cpu"],
  context: ["8192", "32768", "65536", "131072", "262144", "524288"],
  kv: ["int8", "q4_0", "k8v4"],
  kvStreaming: ["auto", "on", "off"],
  lowRam: ["auto", "on", "off", "resident", "mmap"],
};

function setupSelects() {
  return [...document.querySelectorAll("#setupParams [data-setup]")];
}

// The last /config/setup-plan answer (the dialog that is open). The server decides
// what is feasible and which size is the default; this only draws it.
let setupPlan = null;

function familyTitle(key) {
  return (setupPlan?.models || []).find((m) => m.family === key)?.familyTitle || key;
}

// One option per (family, size). Greyed options stay visible WITH the reason: a
// size that silently disappeared would make the list look arbitrary, and the user
// could not learn that this box simply cannot hold it.
function renderSetupModel(plan) {
  const sel = document.getElementById("sp-model");
  if (!sel) return;
  sel.replaceChildren();
  const decide = document.createElement("option");
  decide.value = "";
  decide.textContent = t("configPick.modelLetSetup");
  sel.append(decide);
  const entries = plan?.models || [];
  const keep = plan?.current;
  if (keep && entries.some((m) => m.family === keep.family && m.model === keep.model && m.ok)) {
    const o = document.createElement("option");
    o.value = `${keep.family}|${keep.model}`;
    o.textContent = tp("configPick.modelKeepCurrent", { title: familyTitle(keep.family), model: keep.model });
    sel.append(o);
  }
  const groups = new Map();
  for (const m of entries) {
    if (!groups.has(m.family)) {
      const g = document.createElement("optgroup");
      g.label = m.familyTitle;
      groups.set(m.family, g);
      sel.append(g);
    }
    const o = document.createElement("option");
    o.value = `${m.family}|${m.model}`;
    o.disabled = !m.ok;
    let label = m.recommended ? tp("configPick.modelRecommended", { model: m.model }) : m.model;
    if (!m.ok) label = modelUnavailableText(m);
    else if (m.experimental) label = tp("configPick.modelExperimental", { label });
    o.textContent = label;
    groups.get(m.family).append(o);
  }
  // The default is the recommendation (the tier's size, or the best that still
  // runs). "Let setup decide" is available but never preselected.
  const rec = plan?.recommended;
  sel.value = rec ? `${rec.family}|${rec.model}` : "";
  const ram = document.getElementById("sp-modelRam");
  if (ram) {
    ram.textContent = plan
      ? tp("configPick.modelRamLine", {
        usable: plan.ram.usableGiB,
        nominal: plan.ram.nominalGiB,
        tier: plan.ram.tier === "below" ? "32" : plan.ram.tier,
      })
      : "";
  }
}

function modelUnavailableText(m) {
  if (m.reason === "nvidiaOnly") return tp("configPick.modelNvidiaOnly", { model: m.model });
  return tp("configPick.modelNeedsRam", { model: m.model, needed: m.ramGiB, have: Math.round(setupPlan?.ram?.usableGiB || 0) });
}

// "— setup decides —" (value "") then setup's own values for that flag. A current
// value that is NOT one of them (a context this list does not carry) is injected
// too: a select that cannot show what is in effect would quietly fall back to
// "setup decides" — the value would change without anyone asking for it.
function fillSetupOptions(select) {
  const key = select.dataset.setup;
  const decide = document.createElement("option");
  decide.value = "";
  decide.textContent = t("configPick.setupDecide");
  const options = [decide];
  const current = String(currentSetupValues()[key] ?? "").trim();
  const values = [...(SETUP_FIELDS[key] || [])];
  if (current && !values.includes(current)) values.unshift(current);
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    options.push(opt);
  }
  select.replaceChildren(...options);
}

// The CURRENT value of each parameter, so the form opens on "what is in effect"
// rather than blank. Anything we cannot read stays on "setup decides".
function currentSetupValues() {
  const values = state.config?.values || {};
  const vision = visionInfo || {};
  return {
    vision: vision.available ? (vision.encoder === "gpu" ? "gpu" : vision.encoder === "cpu" ? "cpu" : "") : "",
    context: values.context !== undefined && values.context !== null ? String(values.context) : "",
    kv: values.kv || "",
    // The report rows say what setup chose: streaming on/off, low-RAM mode.
    kvStreaming: isAbsent(values.kvResident) ? "off" : "on",
    lowRam: values.lowRamMode && values.lowRamMode !== "auto" ? values.lowRamMode : "auto",
  };
}

// Only the parameters the user actually asked for; "setup decides" is omitted
// (the backend whitelists the same names).
function collectSetupParams() {
  const params = {};
  for (const select of setupSelects()) {
    const value = String(select.value || "").trim();
    if (value) params[select.dataset.setup] = value;
  }
  // The size is ONE control for TWO flags: `--family` and `--model` are separate
  // setup arguments (setup.py:4574-4575) and a lone `--family` names a release
  // without a size, so they always travel together — the pair is checked by
  // lib/firstrun.js and again by setup's own `choices`.
  const pick = String(document.getElementById("sp-model")?.value || "");
  const [family, model] = pick.split("|");
  if (family && model) {
    params.family = family;
    params.model = model;
  }
  return params;
}

// The optional backup name ("当前设置备份为"). Empty = no backup. Kept out of the
// pass-through parameter set: it is not a setup argument, it is a file we copy
// BEFORE the run (setup.py takes no name — see routes/config.js).
const BACKUP_NAME_RE = /^strata-[A-Za-z0-9._-]+\.json$/;

function collectBackupAs() {
  const el = document.getElementById("sp-backupAs");
  return String(el?.value || "").trim();
}

// Shown under the field itself: the dialog's scrim covers the panel, so a message
// in #error would sit where nobody can see it.
function setBackupError(message) {
  const el = document.getElementById("sp-backupError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

// The backup field opens on a REAL value (a name that works today), so pressing
// the button backs the current settings up without typing. Clearing it means "no
// backup" — the behaviour this field has always had.
function fillBackupAs() {
  const el = document.getElementById("sp-backupAs");
  if (!el) return;
  const current = state.config?.configFile || state.status?.configFile || "";
  const existing = (state.status?.configCandidates || []).map((c) => c?.file).filter(Boolean);
  el.value = backupDefaultName(current, { existing });
}

async function startConfigSetup() {
  if (state.working) return;
  // A name that cannot become a config the picker shows is refused here, so the
  // user sees a translated message instead of a failed job.
  const backupAs = collectBackupAs();
  if (backupAs && !BACKUP_NAME_RE.test(backupAs)) {
    setBackupError(t("configPick.backupBadName"));
    return;
  }
  setBackupError("");
  setGgufError("");
  // The folder, when one was named: an absolute path is all the browser can
  // check, and the server checks that it is really there (routes/config.js).
  const ggufDir = collectSetupGgufDir();
  if (ggufDir && !ggufDir.startsWith("/")) {
    setGgufError(t("configPick.setupGgufBadPath"));
    return;
  }
  state.working = true;
  els.configFileSelect.disabled = true;
  els.configSetupBtn.disabled = true;
  showError("");
  const setup = collectSetupParams();
  if (ggufDir) setup.ggufDir = ggufDir;
  try {
    const res = await api("config/setup", { method: "POST", body: JSON.stringify({ setup, backupAs }) });
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
    // A folder the server could not use is answered WHERE IT WAS ASKED: the
    // dialog's own line, not the panel's #error behind the scrim.
    const codes = Array.isArray(e?.validation) ? e.validation : [];
    if (codes.some((c) => c.startsWith("ggufDir"))) {
      setGgufError(t("configPick.setupGgufBadPath"));
      return;
    }
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
els.configSetupBtn.addEventListener("click", async () => {
  if (state.working) return;
  // The button is disabled while the two reads run: one of them is the fix for
  // 视觉 being silently turned off (see loadProfileFacts).
  els.configSetupBtn.disabled = true;
  try {
    // (a) Load the CURRENT values first. 视觉 is not a config value — it comes with
    // the profile payload — so without this the select opened on "setup decides"
    // and setup's default answer is "no images" (setup.py:5106).
    await loadProfileFacts();
    // Which size this run installs, and whether this box can run each one.
    setupPlan = null;
    try {
      setupPlan = await api("config/setup-plan");
    } catch (e) {
      setupPlan = null;
    }
    // Fill the parameter form from what is in effect NOW, then let the user change
    // only what they mean to. "— setup decides —" takes a parameter out of the run.
    for (const select of setupSelects()) fillSetupOptions(select);
    const current = currentSetupValues();
    for (const select of setupSelects()) select.value = current[select.dataset.setup] || "";
    renderSetupModel(setupPlan);
    renderSetupTarget();
    fillBackupAs();
    setBackupError("");
    fillSetupGguf();
    showConfirm({
      title: t("configPick.confirmTitle"),
      // Its own copy, not the first-launch one: this run rebuilds an EXISTING
      // config, so it must say what that means (measured against setup's own
      // writer: hand-added engine options are dropped and the file is kept as
      // .bak; top-level settings like sampling are carried over).
      sub: tp("configPick.setupSub", {
        dir: state.status?.settings?.ggufDir || state.status?.profile?.ggufDir || t("firstRun.noGgufDir"),
      }),
      confirmText: t("configPick.confirmAction"),
      trigger: els.configSetupBtn,
      body: els.setupParams,
      onConfirm: startConfigSetup,
    });
  } finally {
    els.configSetupBtn.disabled = false;
  }
});

function fillSetupGguf() {
  // The GGUF folder for THIS run: empty is the normal case (the general default
  // named under the field is what setup will use). The server checks that a
  // folder the user does name really exists.
  const ggufEl = document.getElementById("sp-ggufDir");
  if (ggufEl) ggufEl.value = "";
  renderSetupGgufDefault();
  setGgufError("");
}

function renderSetupGgufDefault() {
  const el = document.getElementById("sp-ggufDefault");
  if (!el) return;
  const dir = String(state.status?.settings?.ggufDir || state.status?.profile?.ggufDir || "").trim();
  el.textContent = dir ? tp("configPick.setupGgufDefault", { dir }) : t("configPick.setupGgufDownload");
}

function collectSetupGgufDir() {
  const el = document.getElementById("sp-ggufDir");
  return String(el?.value || "").trim();
}

function setGgufError(message) {
  const el = document.getElementById("sp-ggufError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

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
          dir: state.status?.settings?.ggufDir || s.profile?.ggufDir || t("firstRun.noGgufDir"),
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
els.parallelOn?.addEventListener("change", onParallelSwitch);
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
  envOptionsCache.key = "";
  if (state.status) paint(state.status);
  if (!els.profileDrawer.hidden && pluginFormEls) {
    const title = state.editingProfileId ? t("profile.editTitle") : t("profile.viewTitle");
    pluginFormEls.editorTitle.textContent = title;
    els.profileDrawerTitle.textContent = title;
    // The shared container block re-renders its own static copy + option labels.
    pluginFormEls.container.relocalize();
    pluginFormEls.localApiKey.relocalize();
    if (panelSetupFacts) panelSetupFacts.relocalize();
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
