// The "current environment" control, shared by both documents.
//
// Two hosts ask the same three questions and run the same one action:
//   * which profile is current, and what type it is (local source or container),
//   * which ones can be chosen while the service is down,
//   * persist a choice (POST /profiles/select) and repaint.
// Their DOM differs on purpose — the full page (ui/assets/panel.js) has a header
// badge that opens a read-only drawer, the slim card (ui/assets/card.js) has one
// quiet line of text — so this module stops at "what the control should be" plus
// the primitives that would otherwise drift apart: the option list, the guard, and
// the request itself (route + body shape live here once).
//
// Panel.js keeps its own RUNNING_STATES: it uses the set far beyond this control
// (editors, update action, logs). The copy below is the same four states, named for
// what this control needs to know — a service exists from "starting" until it has
// fully stopped, and switching environments underneath one is what the backend
// refuses, so it must not be offered.
import { t } from "./i18n.js";

const SERVICE_RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

export function isServiceRunning(state) {
  return SERVICE_RUNNING_STATES.has(String(state || ""));
}

export function profileTypeLabel(type) {
  return type === "container" ? t("profile.typeContainer") : t("profile.typeLocal");
}

/** The name a human recognises. The id is the last resort, never the label. */
export function profileDisplayName(profile) {
  return String(profile?.name || profile?.id || "");
}

/** `name · type` — the pair the running badge and the picker's options both show. */
export function profileOptionText(profile) {
  return `${profileDisplayName(profile)} · ${profileTypeLabel(profile?.type)}`;
}

/**
 * What the control should be for one /status payload:
 *   none     — nothing to show (no profile view, or an unsupported platform)
 *   picker   — the service is down, so the environment is a choice
 *   readonly — the service is up, so the environment is a fact
 * Pure, so both hosts' paint functions stay thin and the three cases are testable
 * without a DOM.
 */
export function profileControlPlan({ state, profile, activeProfileId, working } = {}) {
  const show = !!profile && state !== "unsupported";
  if (!show) {
    return { show: false, mode: "none", name: "", typeLabel: "", selectedId: "", disabled: true };
  }
  const base = {
    show: true,
    name: profileDisplayName(profile),
    typeLabel: profileTypeLabel(profile?.type),
  };
  if (isServiceRunning(state)) {
    return { ...base, mode: "readonly", selectedId: "", disabled: true };
  }
  return {
    ...base,
    mode: "picker",
    selectedId: String(activeProfileId || ""),
    disabled: working === true,
  };
}

/** The set of profiles as a cache key: any add/remove/rename changes it. */
export function profileOptionsKey(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.map((p) => `${p?.id}:${p?.name}:${p?.type}`).join("|");
}

/**
 * Fill a <select> with one option per profile. Rebuild ONLY when the set changes, so
 * a 5 s poll never resets a dropdown someone is using (a rebuild would also close a
 * native popup mid-choice). `cache` is the caller's own `{ key }` object — the panel
 * and the card are separate documents and must not share one.
 * Returns true when it rebuilt (callers do not need the value; tests do).
 */
export function renderProfileOptions(select, profiles, cache) {
  if (!select) return false;
  const key = profileOptionsKey(profiles);
  if (cache && key === cache.key) return false;
  if (cache) cache.key = key;
  const list = Array.isArray(profiles) ? profiles : [];
  select.replaceChildren();
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p.id;
    // Name + type, the same pair the running badge shows.
    opt.textContent = profileOptionText(p);
    select.append(opt);
  }
  select.value = "";
  return true;
}

/**
 * Switching is only offered when it would mean something: not while another request
 * is in flight, not with an empty id, and not to the environment already current.
 * (The backend refuses a switch while running; that guard is the backend's, this one
 * only avoids a pointless round trip.)
 */
export function canSelectProfile({ working, id, activeId } = {}) {
  return !working && !!id && id !== activeId;
}

/**
 * The one place the route and the body shape live. Each host passes its own `api`
 * wrapper, so the host's ticket/header handling (ui/assets/card.js, ui/assets/panel.js)
 * is preserved — nothing here talks to `fetch` directly.
 */
export function requestProfileSelect(api, id) {
  return api("profiles/select", { method: "POST", body: JSON.stringify({ id }) });
}
