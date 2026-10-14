// lib/profiles.js — the multi-environment profile model (1.1.0 batch 4).
//
// A "profile" is one way to run Strata: a local source checkout, or a
// container. Docker and local are not two modes with special cases — they are
// just profiles with different fields, chosen on the stop page and managed on
// the configuration page.
//
// This module is pure (no ctx, no fs): normalization, validation, defaults and
// small list helpers. Persistence lives in lib/deployer/common.js.
import crypto from "node:crypto";

export const PROFILE_TYPES = ["local", "container"];
export const DEFAULT_PROFILE_NAME = "default";

export function newProfileId() {
  try {
    return `p-${crypto.randomUUID()}`;
  } catch {
    return `p-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  }
}

// ── Constructors ──────────────────────────────────────────────────────────

export function emptyLocalProfile(overrides = {}) {
  return {
    id: newProfileId(),
    name: "",
    type: "local",
    strataDir: "",
    pythonPath: "",
    // Optional GPU selector, passed to `serve/server.py --gpu` (e.g. "0",
    // "0,2", "all"). Empty means Strata chooses.
    gpu: "",
    ggufDir: "",
    configFile: "",
    port: 0,
    ...overrides,
  };
}

export function emptyContainerProfile(overrides = {}) {
  return {
    id: newProfileId(),
    name: "",
    type: "container",
    image: "",
    containerName: "",
    dataDir: "",
    ggufDir: "",
    port: 0,
    ...overrides,
  };
}

export function makeDefaultProfile(overrides = {}) {
  return emptyLocalProfile({ name: DEFAULT_PROFILE_NAME, ...overrides });
}

// ── Normalization ─────────────────────────────────────────────────────────

function str(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function intPort(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  return i > 0 && i <= 65535 ? i : 0;
}

export function normalizeProfile(raw, { name } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const type = PROFILE_TYPES.includes(src.type) ? src.type : "local";
  const id = str(src.id) || newProfileId();
  const resolvedName = str(src.name) || str(name) || "";
  if (type === "container") {
    return {
      id,
      name: resolvedName,
      type: "container",
      image: str(src.image),
      containerName: str(src.containerName),
      dataDir: str(src.dataDir),
      ggufDir: str(src.ggufDir),
      port: intPort(src.port),
    };
  }
  return {
    id,
    name: resolvedName,
    type: "local",
    strataDir: str(src.strataDir),
    pythonPath: str(src.pythonPath),
    gpu: str(src.gpu),
    ggufDir: str(src.ggufDir),
    configFile: str(src.configFile),
    port: intPort(src.port),
  };
}

// Parse the stored value (JSON string, array, or empty) into a clean list.
export function parseProfiles(raw) {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((p) => p && typeof p === "object").map((p) => normalizeProfile(p));
}

// Build a local profile from the legacy flat settings (pre-profiles installs
// and the flat unit-test fixtures). Always named `default`.
export function profileFromFlat(flat = {}) {
  return normalizeProfile({
    id: "default",
    name: DEFAULT_PROFILE_NAME,
    type: "local",
    strataDir: flat.strataDir,
    pythonPath: flat.pythonPath,
    gpu: flat.gpu,
    ggufDir: flat.ggufDir,
    configFile: flat.configFile,
    port: flat.port,
  });
}

// Always return at least one profile. `flat` supplies the first local profile
// when nothing was ever saved.
export function ensureProfiles(raw, flat = {}) {
  const list = parseProfiles(raw);
  if (list.length) return list;
  return [profileFromFlat(flat)];
}

export function serializeProfiles(list) {
  return JSON.stringify(Array.isArray(list) ? list : []);
}

// ── Lookups / mutations (pure, return new arrays) ────────────────────────

export function findProfile(list, id) {
  const key = str(id);
  if (!key) return null;
  return (list || []).find((p) => p.id === key) || null;
}

export function uniqueName(list, name, exceptId = null) {
  const wanted = str(name).toLowerCase();
  if (!wanted) return false;
  return !(list || []).some((p) => p.id !== exceptId && str(p.name).toLowerCase() === wanted);
}

// ── Validation ────────────────────────────────────────────────────────────

export function validateProfile(profile, { profiles = [], isNew = false } = {}) {
  const p = normalizeProfile(profile);
  const errors = [];

  if (!p.name) errors.push("nameRequired");
  if (p.name && !uniqueName(profiles, p.name, isNew ? null : p.id)) {
    errors.push("nameTaken");
  }
  if (Number(profile?.port) && p.port === 0) errors.push("portInvalid");

  if (p.type === "container") {
    if (!p.image) errors.push("imageRequired");
    if (!p.containerName) errors.push("containerNameRequired");
  }
  return { profile: p, errors };
}

// ── Readiness ─────────────────────────────────────────────────────────────
//
// Cheap, filesystem-free readiness for display. `localReadiness` in
// lib/deployer/index.js layers the server.py/python checks on top.

export function profileReady(profile) {
  if (!profile) return false;
  if (profile.type === "container") return !!profile.image && !!profile.containerName;
  return !!profile.strataDir;
}

export function profileSummary(profile) {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, type: profile.type };
}
