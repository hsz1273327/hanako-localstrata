// hanako-localstrata custom settings page (contributes.settings.ui.route).
//
// The host settings Tab loads this page instead of the schema-flat form.
// Everything is managed in place so the user never has to leave the settings
// surface:
//   * the global preferences — start with Hana, refresh interval, the Strata
//     API key, plus the default model directory / port fallbacks (persisted
//     through ctx.config via `/prefs`);
//   * the environment profiles — list, create, view/edit, delete
//     (persisted through ctx.config via `/profiles` and
//     `/profiles/save|delete`). The page deliberately does NOT switch the
//     active profile: running another configuration belongs to the stop page's
//     start flow (stop → pick → start); this page only marks the one in use.
//
// The manifest schema stays the source of truth for validation/defaults/
// sensitive handling. The backend routes never hand the real API key to the
// page, only a mask, so an untouched masked field is discarded on save.
import { hana } from "./sdk.js";
import { LANGS, LANG_NAMES, loadLang, saveLang, setLang, getLang, t, tp, applyI18n } from "./i18n.js";

setLang(loadLang());

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await hana.api.fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// Matches the host's sensitive-value mask. Sending it back means "unchanged".
const API_KEY_MASK = "********";
// Mirror of the backend's RUNNING_STATES: while one of these is active the
// edit / delete actions are disabled (the routes refuse them too).
const RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

const els = {
  langSelect: document.getElementById("langSelect"),
  autoStart: document.getElementById("autoStart"),
  refreshSec: document.getElementById("refreshSec"),
  apiKey: document.getElementById("apiKey"),
  defaultGgufDir: document.getElementById("defaultGgufDir"),
  defaultGgufDirPick: document.getElementById("defaultGgufDir-pick"),
  defaultPort: document.getElementById("defaultPort"),
  saveBtn: document.getElementById("saveBtn"),
  message: document.getElementById("message"),

  profileList: document.getElementById("profileList"),
  profileAddBtn: document.getElementById("profileAddBtn"),
  profileEditor: document.getElementById("profileEditor"),
  profileEditorTitle: document.getElementById("profileEditorTitle"),
  profileName: document.getElementById("pf-name"),
  profileType: document.getElementById("pf-type"),
  profileLocalFields: document.getElementById("pfLocalFields"),
  profileContainerFields: document.getElementById("pfContainerFields"),
  profileStrataDir: document.getElementById("pf-strataDir"),
  profileStrataDirPick: document.getElementById("pf-strataDir-pick"),
  profilePythonPath: document.getElementById("pf-pythonPath"),
  profilePythonPathPick: document.getElementById("pf-pythonPath-pick"),
  profileGpu: document.getElementById("pf-gpu"),
  profileImage: document.getElementById("pf-image"),
  profileImageOptions: document.getElementById("pf-image-options"),
  profileImageStatus: document.getElementById("pf-image-status"),
  profileImagePullRow: document.getElementById("pf-image-pull-row"),
  profileImagePull: document.getElementById("pf-image-pull"),
  profileContainerName: document.getElementById("pf-containerName"),
  profileDataDir: document.getElementById("pf-dataDir"),
  profileDataDirPick: document.getElementById("pf-dataDir-pick"),
  profileGgufDir: document.getElementById("pf-ggufDir"),
  profileGgufDirPick: document.getElementById("pf-ggufDir-pick"),
  profilePort: document.getElementById("pf-port"),
  profileReadOnlyHint: document.getElementById("profileReadOnlyHint"),
  profileSaveBtn: document.getElementById("profileSaveBtn"),
  profileCancelBtn: document.getElementById("profileCancelBtn"),
  profileEditorActions: document.getElementById("profileEditorActions"),
  profileEditorCloseBtn: document.getElementById("profileEditorCloseBtn"),
  profileEditorMessage: document.getElementById("profileEditorMessage"),
  profileRuntimeNote: document.getElementById("profileRuntimeNote"),
  profileDrawerScrim: document.getElementById("profileDrawerScrim"),
  profileConfirm: document.getElementById("profileConfirm"),
  profileConfirmTitle: document.getElementById("profileConfirmTitle"),
  profileConfirmOk: document.getElementById("profileConfirmOk"),
  profileConfirmCancel: document.getElementById("profileConfirmCancel"),
  profileMessage: document.getElementById("profileMessage"),
};

// ── Global preferences ───────────────────────────────────────────────────

let apiKeyInitial = "";
// General fallbacks, mirrored from /prefs so the stopped editor can annotate an
// empty ggufDir / port with the value it would fall back to.
let generalDefaults = { defaultGgufDir: "", defaultPort: 0 };

function setMessage(text, kind = "info") {
  els.message.textContent = text || "";
  els.message.className = `message ${kind}`;
}

function renderPrefs(prefs) {
  els.autoStart.checked = prefs?.autoStart === true;
  const refreshSec = Number(prefs?.refreshSec);
  els.refreshSec.value = String(Number.isFinite(refreshSec) && refreshSec >= 1 ? Math.trunc(refreshSec) : 5);
  els.apiKey.value = prefs?.hasApiKey ? API_KEY_MASK : "";
  apiKeyInitial = els.apiKey.value;
  els.defaultGgufDir.value = String(prefs?.defaultGgufDir || "");
  const defaultPort = Number(prefs?.defaultPort);
  els.defaultPort.value =
    Number.isInteger(defaultPort) && defaultPort > 0 ? String(defaultPort) : "";
  generalDefaults = {
    defaultGgufDir: String(prefs?.defaultGgufDir || ""),
    defaultPort: Number.isInteger(defaultPort) && defaultPort > 0 ? defaultPort : 0,
  };
}

async function loadPrefs() {
  setMessage(t("settings.loading"), "info");
  try {
    renderPrefs(await api("prefs"));
    setMessage("");
  } catch (e) {
    setMessage(tp("settings.loadFailed", { error: String(e?.message || e) }), "error");
  }
}

async function savePrefs() {
  if (els.saveBtn.disabled) return;
  const refreshSec = Number(els.refreshSec.value);
  if (!Number.isInteger(refreshSec) || refreshSec < 1) {
    setMessage(t("settings.invalidRefresh"), "error");
    return;
  }

  // General fallback port: empty means "not set" (0); anything else must be a
  // valid TCP port. The backend validates again.
  const defaultPortRaw = els.defaultPort.value.trim();
  const defaultPort = defaultPortRaw === "" ? 0 : Number(defaultPortRaw);
  if (!Number.isInteger(defaultPort) || defaultPort < 0 || defaultPort > 65535) {
    setMessage(t("settings.invalidDefaultPort"), "error");
    return;
  }

  const body = {
    autoStart: els.autoStart.checked,
    refreshSec,
    defaultGgufDir: els.defaultGgufDir.value.trim(),
    defaultPort,
  };
  // Only send the key when the user actually changed it; a masked value must
  // never overwrite the stored secret.
  if (els.apiKey.value !== apiKeyInitial) body.apiKey = els.apiKey.value;

  els.saveBtn.disabled = true;
  setMessage(t("settings.saving"), "info");
  try {
    renderPrefs(await api("prefs", { method: "POST", body: JSON.stringify(body) }));
    setMessage(t("settings.saved"), "ok");
  } catch (e) {
    setMessage(String(e?.message || e), "error");
  } finally {
    els.saveBtn.disabled = false;
  }
}

// ── Environment profiles (managed in place) ──────────────────────────────

let profiles = [];
let activeProfileId = "";
// Pessimistic until the first status probe resolves, so edit/delete can never
// be clicked against a running service.
let serviceRunning = true;
let working = false;
// null = editor closed, "" = creating a new profile, otherwise the edited id.
let editingProfileId = null;
// When true the editor is the read-only "view" variant: every field is
// disabled, the save button is hidden and only a close action remains.
let editorReadOnly = false;
// The role of profile.configFile is still backend-only; carry an existing
// local profile's value through an edit so it is never dropped.
let originalConfigFile = "";
let pendingDeleteId = "";

// ── Runtime values (read-only "view" drawer) ─────────────────────────────

// Which editor input renders which runtime field. `configFile` is absent on
// purpose: the editor never displayed it.
const FIELD_INPUTS = {
  strataDir: () => els.profileStrataDir,
  pythonPath: () => els.profilePythonPath,
  gpu: () => els.profileGpu,
  image: () => els.profileImage,
  containerName: () => els.profileContainerName,
  dataDir: () => els.profileDataDir,
  ggufDir: () => els.profileGgufDir,
  port: () => els.profilePort,
};

// Raw profile values captured when the editor opened, so a runtime fill never
// counts as "the profile already had a value".
let profileFieldValues = {};
let runtimeReport = null;
let runtimeError = "";
// input → value it held before a runtime fill, restored on close.
const runtimeFilled = new Map();

function isPresentValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return String(value).trim() !== "";
}

function captureProfileValues(profile) {
  profileFieldValues = {
    strataDir: profile?.strataDir || "",
    pythonPath: profile?.pythonPath || "",
    gpu: profile?.gpu || "",
    image: profile?.image || "",
    containerName: profile?.containerName || "",
    dataDir: profile?.dataDir || "",
    ggufDir: profile?.ggufDir || "",
    port: profile?.port ? String(profile.port) : "",
  };
}

function sourceLabel(source) {
  if (source === "runtime") return t("profile.sourceRuntime");
  if (source === "runtime-volume") return t("profile.sourceRuntimeVolume");
  if (source === "default") return t("profile.sourceDefault");
  return "";
}

function addSourceSpan(input, text) {
  if (!input || !text) return;
  const span = document.createElement("span");
  span.className = "field-source";
  span.textContent = text;
  input.insertAdjacentElement("afterend", span);
}

function removeSourceSpans() {
  if (!els.profileEditor) return;
  for (const span of els.profileEditor.querySelectorAll(".field-source")) span.remove();
}

// Restore runtime-filled values and drop every provenance tag. Called on
// open and on close so nothing leaks between profiles.
function clearFieldSources() {
  removeSourceSpans();
  for (const [input, original] of runtimeFilled) {
    if (input) input.value = original;
  }
  runtimeFilled.clear();
  runtimeReport = null;
  runtimeError = "";
}

function renderSourceAnnotations(report) {
  removeSourceSpans();
  const values = report?.values || {};
  const sources = report?.sources || {};
  for (const [key, inputOf] of Object.entries(FIELD_INPUTS)) {
    const input = inputOf();
    if (!input) continue;
    if (String(profileFieldValues[key] ?? "").trim()) continue;
    if (!isPresentValue(values[key])) continue;
    if (!runtimeFilled.has(input)) runtimeFilled.set(input, input.value);
    input.value = String(values[key]);
    addSourceSpan(input, sourceLabel(sources[key]));
  }
}

// Stopped / editable view: only annotate empty ggufDir / port with the general
// default they would fall back to, without writing the default into the field.
function applyDefaultAnnotations() {
  removeSourceSpans();
  const ggufDefault = String(generalDefaults.defaultGgufDir || "").trim();
  const portDefault = Number(generalDefaults.defaultPort) > 0 ? String(generalDefaults.defaultPort) : "";
  if (!String(profileFieldValues.ggufDir || "").trim() && ggufDefault) {
    addSourceSpan(els.profileGgufDir, tp("profile.sourceDefaultValue", { value: ggufDefault }));
  }
  if (!String(profileFieldValues.port || "").trim() && portDefault) {
    addSourceSpan(els.profilePort, tp("profile.sourceDefaultValue", { value: portDefault }));
  }
}

function showRuntimeNote() {
  if (!els.profileRuntimeNote) return;
  els.profileRuntimeNote.classList.remove("error");
  els.profileRuntimeNote.textContent = t("profile.runtimeNote");
  els.profileRuntimeNote.hidden = false;
}

function setRuntimeNoteError(message) {
  if (!els.profileRuntimeNote) return;
  els.profileRuntimeNote.classList.add("error");
  els.profileRuntimeNote.textContent = message;
  els.profileRuntimeNote.hidden = false;
}

async function loadRunningReport() {
  const token = editingProfileId;
  showRuntimeNote();
  try {
    const report = await api("profiles/running");
    if (els.profileEditor.hidden || editingProfileId !== token || !editorReadOnly) return;
    runtimeError = "";
    runtimeReport = report;
    if (report?.running) renderSourceAnnotations(report);
  } catch (e) {
    if (els.profileEditor.hidden || editingProfileId !== token) return;
    runtimeError = String(e?.message || e);
    setRuntimeNoteError(tp("profile.runtimeUnavailable", { error: runtimeError }));
  }
}

// Re-apply annotations after a language switch (the spans are generated, not
// data-i18n nodes, so applyI18n cannot see them).
function refreshSourceAnnotations() {
  if (!els.profileEditor || els.profileEditor.hidden) return;
  if (editorReadOnly) {
    if (runtimeError) setRuntimeNoteError(tp("profile.runtimeUnavailable", { error: runtimeError }));
    else if (runtimeReport) renderSourceAnnotations(runtimeReport);
    else showRuntimeNote();
  } else {
    applyDefaultAnnotations();
  }
}

// ── Container image candidates / pull ────────────────────────────────────

let imageList = [];
let imageAvailable = false;
let imageError = "";
// False until GET /images has answered once: before that we know nothing about
// the local store, so nothing may be claimed about availability.
let imageListLoaded = false;
let imagePollTimer = null;
let imagePullBusy = false;

function stopImagePoll() {
  if (imagePollTimer) {
    clearInterval(imagePollTimer);
    imagePollTimer = null;
  }
}

function imageMatchCandidates(img) {
  const repo = String(img?.repository || "").toLowerCase();
  const tag = String(img?.tag || "").toLowerCase();
  const ref = String(img?.ref || "").toLowerCase();
  const set = new Set();
  if (ref) set.add(ref);
  if (repo) {
    set.add(repo);
    if (tag && tag !== "<none>") set.add(`${repo}:${tag}`);
    // An omitted `:latest` should still match the stored reference.
    if (!tag || tag === "<none>" || tag === "latest") set.add(repo);
  }
  return set;
}

function imageMatches(value) {
  const wanted = String(value || "").trim().toLowerCase();
  if (!wanted) return false;
  for (const img of imageList) {
    if (imageMatchCandidates(img).has(wanted)) return true;
    const tag = String(img?.tag || "").toLowerCase();
    if (!wanted.includes(":") && (!tag || tag === "<none>" || tag === "latest")) {
      if (String(img?.repository || "").toLowerCase() === wanted) return true;
    }
  }
  return false;
}

function renderImageOptions() {
  if (!els.profileImageOptions) return;
  els.profileImageOptions.replaceChildren();
  for (const img of imageList) {
    const opt = document.createElement("option");
    opt.value = String(img?.ref || "");
    els.profileImageOptions.append(opt);
  }
}

function renderImageStatus() {
  if (!els.profileImageStatus) return;
  const value = els.profileImage.value.trim() || "";
  const listKnown = imageListLoaded && imageAvailable && !imageError;
  if (imageListLoaded && !listKnown) {
    // Docker missing or `docker images` failing: surface the reason.
    els.profileImageStatus.textContent = tp("field.imageListFailed", { error: imageError || "" });
  } else if (!value || !listKnown) {
    // Empty field, or the list has not answered yet: nothing to claim.
    els.profileImageStatus.textContent = "";
  } else {
    els.profileImageStatus.textContent = imageMatches(value)
      ? t("field.imageAvailable")
      : t("field.imageMissing");
  }
  renderImageAction();
}

// The pull entry, with wording that never contradicts the status line above:
//   * no image typed            → hidden (nothing to pull);
//   * not present locally        → "pull" — acquire it;
//   * present locally            → "pull again" — same tag, the registry may
//     have moved on (`latest` keeps its name while the layers change), so this
//     entry must stay. A locally built tag may fail to pull; that failure is
//     reported like any other, not hidden by removing the button;
//   * local list unreadable      → "pull" (availability unknown, so the neutral
//     acquire wording is the honest one), with the status line explaining why.
// Both wordings run the same pull flow and the same polling feedback.
function renderImageAction() {
  const row = els.profileImagePullRow;
  const value = els.profileImage.value.trim() || "";
  if (row) row.hidden = !value;
  if (!els.profileImagePull) return;
  const local = imageListLoaded && imageAvailable && !imageError && imageMatches(value);
  els.profileImagePull.textContent = t(local ? "field.imageRepull" : "field.imagePull");
}

async function loadImages() {
  try {
    const data = await api("images");
    imageAvailable = data?.available !== false;
    imageList = Array.isArray(data?.images) ? data.images : [];
    imageError = data?.error || "";
  } catch (e) {
    imageAvailable = false;
    imageList = [];
    imageError = String(e?.message || e);
  }
  imageListLoaded = true;
  renderImageOptions();
  renderImageStatus();
}

function pullBusyText(state) {
  const tail = Array.isArray(state?.tail) && state.tail.length ? state.tail[state.tail.length - 1] : "";
  return tp("field.imagePullBusy", {
    image: state?.image || els.profileImage?.value.trim() || "",
    tail,
  });
}

async function pollImagePull() {
  let state;
  try {
    state = await api("images/pull");
  } catch {
    stopImagePoll();
    imagePullBusy = false;
    return;
  }
  if (state?.running) {
    setProfileMessage(pullBusyText(state), "info");
    return;
  }
  stopImagePoll();
  imagePullBusy = false;
  if (els.profileImagePull) els.profileImagePull.disabled = editorReadOnly;
  if (state?.ok) {
    setProfileMessage(tp("field.imagePulled", { image: state.image || "" }), "ok");
    await loadImages();
  } else {
    setProfileMessage(tp("field.imagePullFailed", { error: state?.error || "" }), "error");
    renderImageStatus();
  }
}

async function pullImage() {
  if (editorReadOnly || imagePullBusy) return;
  const image = els.profileImage?.value.trim() || "";
  if (!image) return;
  imagePullBusy = true;
  if (els.profileImagePull) els.profileImagePull.disabled = true;
  setProfileMessage(tp("field.imagePullBusy", { image, tail: "" }), "info");
  try {
    const result = await api("images/pull", { method: "POST", body: JSON.stringify({ image }) });
    const state = result?.state || result;
    if (state?.running) {
      stopImagePoll();
      imagePollTimer = setInterval(pollImagePull, 1500);
    } else {
      imagePullBusy = false;
      if (els.profileImagePull) els.profileImagePull.disabled = editorReadOnly;
      if (state?.ok) {
        setProfileMessage(tp("field.imagePulled", { image: state.image || image }), "ok");
        await loadImages();
      } else if (state?.error) {
        setProfileMessage(tp("field.imagePullFailed", { error: state.error }), "error");
      }
    }
  } catch (e) {
    // 409: a pull is already in flight (maybe started in another drawer).
    if (e?.data?.already && e.data.state?.running) {
      setProfileMessage(pullBusyText(e.data.state), "info");
      stopImagePoll();
      imagePollTimer = setInterval(pollImagePull, 1500);
      return;
    }
    imagePullBusy = false;
    if (els.profileImagePull) els.profileImagePull.disabled = editorReadOnly;
    setProfileMessage(tp("field.imagePullFailed", { error: String(e?.message || e) }), "error");
  }
}

// One implementation of the host path picker for every path field: the General
// box's defaultGgufDir, and the drawer's strataDir / pythonPath / dataDir /
// ggufDir. Only `mode` ("directory" | "file") and the message sink of the box
// differ; the degradation is identical everywhere — a host without
// `hana.resources.pick`, a cancelled picker (empty resources) and a thrown
// error all fall back to hand-typing, and the inputs are never disabled by a
// failed pick. A bare command name (`python3`) stays a legal value for the
// interpreter field: the picker only ever writes what the user chose.
async function pickPath(input, mode, notify = setProfileMessage) {
  if (!input) return;
  if (typeof hana?.resources?.pick !== "function") {
    notify(t("field.pickUnsupported"), "error");
    return;
  }
  try {
    const res = await hana.resources.pick({ mode });
    const item = res?.resources?.[0];
    if (!item) return;
    const raw = item.kind === "local-file" || item.path !== undefined || item.filePath !== undefined
      ? item.path ?? item.filePath ?? ""
      : "";
    const picked = String(raw).trim();
    if (!picked) return;
    input.value = picked;
    notify("");
  } catch (e) {
    notify(tp("field.pickFailed", { error: String(e?.message || e) }), "error");
  }
}

// Directory-mode picker: strataDir / dataDir / ggufDir / defaultGgufDir.
function pickDirectory(input, notify = setProfileMessage) {
  return pickPath(input, "directory", notify);
}

// File-mode picker: the Python interpreter is a file, never a directory.
function pickFile(input, notify = setProfileMessage) {
  return pickPath(input, "file", notify);
}

function setProfileMessage(text, kind = "info") {
  // The page message stays visible for list actions (select / delete); the
  // editor message is what the user reads while the drawer covers the page.
  for (const el of [els.profileMessage, els.profileEditorMessage]) {
    if (!el) continue;
    el.textContent = text || "";
    el.className = `message ${kind}`;
  }
}

function profileTypeLabel(type) {
  return type === "container" ? t("profile.typeContainer") : t("profile.typeLocal");
}

// The backend reports machine-readable codes (nameRequired, nameTaken, …) plus
// a few legacy Chinese phrases. Localize them for display.
function profileErrorText(error) {
  const raw = String(error || "");
  if (raw.includes("nameRequired")) return t("profile.errNameRequired");
  if (raw.includes("nameTaken")) return t("profile.errNameTaken");
  if (raw.includes("imageRequired")) return t("profile.errImageRequired");
  if (raw.includes("containerNameRequired")) return t("profile.errContainerNameRequired");
  if (raw.includes("portInvalid")) return t("profile.errPortInvalid");
  if (raw.includes("至少保留一套配置")) return t("profile.errLast");
  if (raw.includes("配置不存在")) return t("profile.errMissing");
  if (raw.includes("运行中")) return t("profile.errRunning");
  return raw;
}

// Monochrome inline SVGs shared with the panel's icon language: stroke uses
// currentColor so the icon inherits the button's text color (the delete
// button's red included), and aria-hidden keeps it purely decorative.
const ICONS = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/><path d="M10 11v6M14 11v6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="M14.5 6.5l3 3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

function renderProfiles() {
  els.profileList.replaceChildren();
  for (const p of profiles) {
    // The persisted selection — highlighted whether or not the service runs.
    const isActive = p.id === activeProfileId;
    // The service is actually running from this profile right now.
    const inUse = serviceRunning && isActive;
    const row = document.createElement("div");
    row.className = "profile-row";
    if (isActive) row.classList.add("active");

    const main = document.createElement("div");
    main.className = "profile-row-main";
    // No leading dot: the running state is the "使用中" badge and the type is
    // the badge after the name, so a colored dot carried no information.
    const name = document.createElement("span");
    name.className = "profile-row-name";
    name.textContent = p.name || p.id;
    name.title = p.name || p.id;
    const badge = document.createElement("span");
    badge.className = `profile-type-badge ${p.type === "container" ? "container" : "local"}`;
    badge.textContent = profileTypeLabel(p.type);
    main.append(name, badge);

    const actions = document.createElement("div");
    actions.className = "profile-row-actions";
    // The badge marks the profile the service is actually RUNNING from
    // ("使用中"); the green row highlight above already shows which one is
    // merely selected, and a selection survives a stop. Switching the profile
    // is deliberately NOT here: that belongs to the stop page's start flow
    // (stop → pick → start), so a running service can never be swapped out from
    // behind the settings page.
    if (inUse) {
      const active = document.createElement("span");
      active.className = "profile-active-badge";
      active.textContent = t("profile.active");
      actions.append(active);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn small";
    // What locks a row is not "the service is running" but "this profile is the
    // one it is running from". The other profiles are just stored
    // configurations: editing them is a config write that never touches the
    // running deployment, so they stay editable. The in-use profile opens as a
    // read-only "view" instead, because it must not be changed under a running
    // service.
    edit.textContent = inUse ? t("profile.view") : t("profile.edit");
    edit.insertAdjacentHTML("afterbegin", inUse ? ICONS.eye : ICONS.pencil);
    edit.disabled = working;
    edit.title = inUse ? t("profile.viewTitle") : "";
    edit.addEventListener("click", () => openProfileEditor(p, inUse));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small danger";
    del.textContent = t("profile.delete");
    del.insertAdjacentHTML("afterbegin", ICONS.trash);
    // At least one profile must always remain; the route enforces this too.
    // Deleting another profile while the service runs is allowed (same
    // reasoning as editing it); only the in-use one is protected.
    del.disabled = working || inUse || profiles.length <= 1;
    del.title = inUse ? t("profile.errRunning") : "";
    del.addEventListener("click", () => askDeleteProfile(p));
    actions.append(edit, del);

    row.append(main, actions);
    els.profileList.append(row);
  }
  els.profileAddBtn.disabled = working;
}

async function loadProfiles() {
  const data = await api("profiles");
  profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  activeProfileId = data?.activeProfileId || profiles[0]?.id || "";
  // Paint the list before the (potentially slow) status probe so the user is
  // not waiting on docker/python checks. Edit/delete keep the last known
  // running state until the probe resolves.
  renderProfiles();
  try {
    const status = await api("status");
    serviceRunning = RUNNING_STATES.has(status?.state);
  } catch {
    // A failed status call must not break profile management.
    serviceRunning = false;
  }
  renderProfiles();
}

function setProfileEditorType(type) {
  const isContainer = type === "container";
  els.profileLocalFields.hidden = isContainer;
  els.profileContainerFields.hidden = !isContainer;
}

function updateEditorTitle() {
  if (els.profileEditor.hidden || editingProfileId === null) return;
  if (editorReadOnly) {
    els.profileEditorTitle.textContent = t("profile.viewTitle");
    return;
  }
  els.profileEditorTitle.textContent = editingProfileId ? t("profile.editTitle") : t("profile.newTitle");
}

// Every input the editor owns. Listing them once keeps read-only mode from
// missing a field (or forgetting to unlock one when the editor reopens).
function editorFields() {
  return [
    els.profileName,
    els.profileType,
    els.profileStrataDir,
    els.profilePythonPath,
    els.profileGpu,
    els.profileImage,
    els.profileContainerName,
    els.profileDataDir,
    els.profileGgufDir,
    els.profilePort,
  ];
}

// Toggle the whole editor between editable and read-only. Safe to call on a
// closed editor: it just resets the chrome for the next open.
function setEditorReadOnly(readOnly) {
  editorReadOnly = readOnly;
  for (const field of editorFields()) field.disabled = readOnly;
  // The image pull is a write-side action: never available in read-only view.
  if (els.profileImagePull) els.profileImagePull.disabled = readOnly || imagePullBusy;
  // Pickers write into the fields, so they follow the same rule.
  if (els.profileDataDirPick) els.profileDataDirPick.disabled = readOnly;
  if (els.profileGgufDirPick) els.profileGgufDirPick.disabled = readOnly;
  if (els.profileStrataDirPick) els.profileStrataDirPick.disabled = readOnly;
  if (els.profilePythonPathPick) els.profilePythonPathPick.disabled = readOnly;
  els.profileReadOnlyHint.hidden = !readOnly;
  // No write path in the read-only view. The whole bottom action row is
  // hidden there because it would only repeat the top close button.
  els.profileEditorActions.hidden = readOnly;
  els.profileSaveBtn.hidden = readOnly;
  els.profileSaveBtn.disabled = readOnly;
  els.profileCancelBtn.textContent = readOnly ? t("profile.close") : t("common.cancel");
  updateEditorTitle();
}

// Open / close the right-side drawer. Kept separate from the editor state so
// the scrim and the panel always stay in sync.
function setDrawerOpen(open) {
  els.profileEditor.hidden = !open;
  els.profileDrawerScrim.hidden = !open;
}

function openProfileEditor(profile, readOnly = false) {
  editingProfileId = profile ? profile.id : "";
  originalConfigFile = profile?.type === "local" ? profile?.configFile || "" : "";
  // Drop any provenance tag / runtime-filled value from the previous profile.
  clearFieldSources();
  captureProfileValues(profile);
  stopImagePoll();
  imagePullBusy = false;
  els.profileName.value = profile?.name || "";
  els.profileType.value = profile?.type === "container" ? "container" : "local";
  els.profileStrataDir.value = profile?.strataDir || "";
  els.profilePythonPath.value = profile?.pythonPath || "";
  els.profileGpu.value = profile?.gpu || "";
  els.profileImage.value = profile?.image || "";
  els.profileContainerName.value = profile?.containerName || "";
  els.profileDataDir.value = profile?.dataDir || "";
  els.profileGgufDir.value = profile?.ggufDir || "";
  els.profilePort.value = profile?.port ? String(profile.port) : "";
  setProfileEditorType(els.profileType.value);
  setDrawerOpen(true);
  setProfileMessage("");
  // Show first, then apply read-only, so the title reflects the real mode.
  setEditorReadOnly(readOnly);
  if (readOnly) {
    // Live values of the running instance (runtime / default provenance tags).
    showRuntimeNote();
    loadRunningReport();
  } else {
    if (els.profileRuntimeNote) els.profileRuntimeNote.hidden = true;
    // Stopped: annotate empty ggufDir / port with the general default.
    applyDefaultAnnotations();
  }
  // Paint the image state (status line + whether the pull entry applies) from
  // the current value and the last known local list, then refresh that list
  // when this profile can even have an image.
  renderImageStatus();
  if (els.profileType.value === "container") loadImages();
  if (!readOnly) els.profileName.focus();
}

function closeProfileEditor() {
  editingProfileId = null;
  // The poll belongs to the drawer; never let it outlive the close.
  stopImagePoll();
  imagePullBusy = false;
  clearFieldSources();
  if (els.profileRuntimeNote) els.profileRuntimeNote.hidden = true;
  // Reset read-only state so the next open starts editable.
  setEditorReadOnly(false);
  setDrawerOpen(false);
  setProfileMessage("");
}

async function saveProfile() {
  if (working || editorReadOnly) return;

  const name = els.profileName.value.trim();
  if (!name) {
    setProfileMessage(t("profile.errNameRequired"), "error");
    return;
  }
  const type = els.profileType.value === "container" ? "container" : "local";
  const portRaw = els.profilePort.value.trim();
  const port = portRaw === "" ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    setProfileMessage(t("profile.errPortInvalid"), "error");
    return;
  }

  const body = { name, type, port, ggufDir: els.profileGgufDir.value.trim() };
  if (editingProfileId) body.id = editingProfileId;
  if (type === "container") {
    const image = els.profileImage.value.trim();
    const containerName = els.profileContainerName.value.trim();
    if (!image) {
      setProfileMessage(t("profile.errImageRequired"), "error");
      return;
    }
    if (!containerName) {
      setProfileMessage(t("profile.errContainerNameRequired"), "error");
      return;
    }
    body.image = image;
    body.containerName = containerName;
    body.dataDir = els.profileDataDir.value.trim();
  } else {
    body.strataDir = els.profileStrataDir.value.trim();
    body.pythonPath = els.profilePythonPath.value.trim();
    body.gpu = els.profileGpu.value.trim();
    // The editor does not render configFile, but an existing override must
    // survive an edit (zero-regression on the flat/profile config values).
    body.configFile = originalConfigFile;
  }

  working = true;
  els.profileSaveBtn.disabled = true;
  setProfileMessage(t("profile.saving"), "info");
  try {
    await api("profiles/save", { method: "POST", body: JSON.stringify(body) });
    editingProfileId = null;
    setDrawerOpen(false);
    setProfileMessage(t("profile.saved"), "ok");
    await loadProfiles();
  } catch (e) {
    setProfileMessage(profileErrorText(e?.message || e), "error");
  } finally {
    working = false;
    els.profileSaveBtn.disabled = false;
    renderProfiles();
  }
}

function askDeleteProfile(profile) {
  if (working) return;
  // The in-use profile stays protected while the service runs (the row button
  // is disabled too; this is the defensive copy).
  if (serviceRunning && profile.id === activeProfileId) return;
  pendingDeleteId = profile.id;
  els.profileConfirmTitle.textContent = tp("profile.deleteConfirm", { name: profile.name || profile.id });
  els.profileConfirm.hidden = false;
  els.profileConfirmOk.disabled = false;
}

function cancelDeleteProfile() {
  pendingDeleteId = "";
  els.profileConfirm.hidden = true;
}

async function confirmDeleteProfile() {
  const id = pendingDeleteId;
  if (!id || working) return;
  working = true;
  els.profileConfirmOk.disabled = true;
  setProfileMessage(t("profile.deleting"), "info");
  try {
    await api("profiles/delete", { method: "POST", body: JSON.stringify({ id }) });
    pendingDeleteId = "";
    els.profileConfirm.hidden = true;
    if (editingProfileId === id) {
      editingProfileId = null;
      setDrawerOpen(false);
    }
    setProfileMessage(t("profile.deleted"), "ok");
    await loadProfiles();
  } catch (e) {
    setProfileMessage(profileErrorText(e?.message || e), "error");
  } finally {
    working = false;
    els.profileConfirmOk.disabled = false;
    renderProfiles();
  }
}

async function loadProfilesSafe() {
  setProfileMessage("");
  try {
    await loadProfiles();
  } catch (e) {
    setProfileMessage(tp("settings.loadFailed", { error: String(e?.message || e) }), "error");
  }
}

// ── Language picker / wiring ─────────────────────────────────────────────

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
    applyI18n();
    // Dynamic rows and title keep their own text, so re-render them.
    renderProfiles();
    // Re-apply the editor chrome so the title/hint/close label follow the new
    // language even when a read-only view is open.
    setEditorReadOnly(editorReadOnly);
    refreshSourceAnnotations();
    renderImageStatus();
    if (!els.profileConfirm.hidden && pendingDeleteId) {
      const pending = profiles.find((p) => p.id === pendingDeleteId);
      if (pending) els.profileConfirmTitle.textContent = tp("profile.deleteConfirm", { name: pending.name || pending.id });
    }
  });
}

els.saveBtn.addEventListener("click", savePrefs);
els.refreshSec.addEventListener("input", () => setMessage(""));
els.apiKey.addEventListener("input", () => setMessage(""));
els.defaultGgufDir.addEventListener("input", () => setMessage(""));
// The General box has no read-only mode, so this picker is always live; it
// shares pickDirectory() with the drawer's pickers but reports to #message.
els.defaultGgufDirPick.addEventListener("click", () => pickDirectory(els.defaultGgufDir, setMessage));
els.defaultPort.addEventListener("input", () => setMessage(""));
els.autoStart.addEventListener("change", () => setMessage(""));

els.profileAddBtn.addEventListener("click", () => openProfileEditor(null));
els.profileType.addEventListener("change", () => {
  setProfileEditorType(els.profileType.value);
  if (els.profileType.value === "container") loadImages();
});
els.profileImage.addEventListener("input", () => renderImageStatus());
els.profileImagePull.addEventListener("click", pullImage);
els.profileDataDirPick.addEventListener("click", () => pickDirectory(els.profileDataDir));
els.profileGgufDirPick.addEventListener("click", () => pickDirectory(els.profileGgufDir));
els.profileStrataDirPick.addEventListener("click", () => pickDirectory(els.profileStrataDir));
// The interpreter is a file: file mode, and the field may stay empty (the App
// falls back to the system python3) or hold a bare command name.
els.profilePythonPathPick.addEventListener("click", () => pickFile(els.profilePythonPath));
els.profileSaveBtn.addEventListener("click", saveProfile);
els.profileCancelBtn.addEventListener("click", closeProfileEditor);
els.profileEditorCloseBtn.addEventListener("click", closeProfileEditor);
// Clicking the semi-transparent scrim (outside the drawer) dismisses it.
els.profileDrawerScrim.addEventListener("click", closeProfileEditor);
// Esc is the standard way out of a modal drawer; only act when it is open so
// the shortcut never interferes with the rest of the settings page.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.profileEditor.hidden) {
    e.preventDefault();
    closeProfileEditor();
  }
});
els.profileConfirmOk.addEventListener("click", confirmDeleteProfile);
els.profileConfirmCancel.addEventListener("click", cancelDeleteProfile);
els.profileEditor.addEventListener("input", () => setProfileMessage(""));

applyI18n();
initLangSelect();

// Handshake, then load the current values and profiles.
hana.ready();
loadPrefs();
loadProfilesSafe();
