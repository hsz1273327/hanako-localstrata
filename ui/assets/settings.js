// hanako-localstrata custom settings page (contributes.settings.ui.route).
//
// The host settings Tab loads this page instead of the schema-flat form. Only
// three global preferences are rendered here — start with Hana, refresh
// interval and the Strata API key. Everything that belongs to an environment
// profile (Strata directory, Python, GPU, GGUF, config file, port) is managed
// from the panel via the entry at the bottom.
//
// Reads/writes go through this App's own authenticated routes (`/prefs`),
// which persist to the manifest schema through `ctx.config`. The schema is
// still the source of truth for validation/defaults/sensitive handling.
import { hana } from "./sdk.js";
import { LANGS, LANG_NAMES, loadLang, saveLang, setLang, getLang, t, tp, applyI18n } from "./i18n.js";

setLang(loadLang());

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await hana.api.fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// Matches the host's sensitive-value mask. Sending it back means "unchanged".
const API_KEY_MASK = "********";

const els = {
  langSelect: document.getElementById("langSelect"),
  autoStart: document.getElementById("autoStart"),
  refreshSec: document.getElementById("refreshSec"),
  apiKey: document.getElementById("apiKey"),
  saveBtn: document.getElementById("saveBtn"),
  openPanelBtn: document.getElementById("openPanelBtn"),
  message: document.getElementById("message"),
};

let apiKeyInitial = "";

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
}

async function load() {
  setMessage(t("settings.loading"), "info");
  try {
    renderPrefs(await api("prefs"));
    setMessage("");
  } catch (e) {
    setMessage(tp("settings.loadFailed", { error: String(e?.message || e) }), "error");
  }
}

async function save() {
  if (els.saveBtn.disabled) return;
  const refreshSec = Number(els.refreshSec.value);
  if (!Number.isInteger(refreshSec) || refreshSec < 1) {
    setMessage(t("settings.invalidRefresh"), "error");
    return;
  }

  const body = { autoStart: els.autoStart.checked, refreshSec };
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

// Opens this App's whole-page "panel" card through the official host API.
//
// Known host behaviour (verified against Hana 1.1.0-beta): `hana.cards.open`
// activates/locates the page card, but it does NOT dismiss the settings
// surface that this page is running in. There is no SDK call to close that
// surface from inside the App, so the modal can only be closed by the user.
// The success message below tells the user where the panel went. See
// docs/dev/v1.1-settings-page-notes.md for the alternatives (in-place
// profile management / shared settings+panel HTML).
let openPanelPending = false;

async function openPanel() {
  if (openPanelPending) return;
  openPanelPending = true;
  els.openPanelBtn.disabled = true;
  setMessage("");
  try {
    if (typeof hana.cards?.open !== "function") {
      throw new Error("hana.cards.open unavailable");
    }
    await hana.cards.open("panel");
    setMessage(t("settings.openPanelOpened"), "info");
  } catch (e) {
    setMessage(tp("settings.openPanelFailed", { error: String(e?.message || e) }), "error");
  } finally {
    openPanelPending = false;
    els.openPanelBtn.disabled = false;
  }
}

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
  });
}

els.saveBtn.addEventListener("click", save);
els.openPanelBtn.addEventListener("click", openPanel);
els.refreshSec.addEventListener("input", () => setMessage(""));

applyI18n();
initLangSelect();

// Handshake, then load the current values.
hana.ready();
load();
