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
    port: 0,
    ...overrides,
  };
}

export function emptyContainerProfile(overrides = {}) {
  return {
    id: newProfileId(),
    name: "",
    type: "container",
    imageName: "",
    imageTag: "",
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

// "name:tag" → { name, tag }. The colon is only a tag separator when it comes
// after the last slash, so a registry port ("host:5000/img") is not mistaken
// for one.
function splitImageRef(ref) {
  const s = str(ref);
  const colon = s.lastIndexOf(":");
  if (colon > s.lastIndexOf("/")) return { name: s.slice(0, colon), tag: s.slice(colon + 1) };
  return { name: s, tag: "" };
}

// Compose the "name:tag" reference the docker CLI consumes.
export function imageRef(profile) {
  const name = str(profile?.imageName);
  const tag = str(profile?.imageTag);
  if (!name) return "";
  return tag ? `${name}:${tag}` : name;
}

export function normalizeProfile(raw, { name } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const type = PROFILE_TYPES.includes(src.type) ? src.type : "local";
  const id = str(src.id) || newProfileId();
  const resolvedName = str(src.name) || str(name) || "";
  if (type === "container") {
    // Two independent fields. Legacy profiles stored a single `image` with the
    // tag baked in ("strata:latest"); split it instead of reading the whole
    // string as a name.
    const legacy = splitImageRef(src.image);
    const imageName = str(src.imageName) || legacy.name;
    const imageTag = str(src.imageTag) || legacy.tag;
    return {
      id,
      name: resolvedName,
      type: "container",
      imageName,
      imageTag,
      // Derived: the "name:tag" reference every existing consumer uses (docker
      // run / inspect / pull). Never stored — recomposed on read.
      image: imageName ? (imageTag ? `${imageName}:${imageTag}` : imageName) : "",
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
//
// The selected config file deliberately does NOT live on a profile: it is the
// top-level `configFile` ("which setup result is in effect"), shared by every
// source profile. A profile only says WHERE Strata runs.
export function profileFromFlat(flat = {}) {
  return normalizeProfile({
    id: "default",
    name: DEFAULT_PROFILE_NAME,
    type: "local",
    strataDir: flat.strataDir,
    pythonPath: flat.pythonPath,
    gpu: flat.gpu,
    ggufDir: flat.ggufDir,
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

// The legacy persisted form: earlier releases stored the list as a JSON string
// to satisfy a schema that declared `profiles` as a string. New writes persist
// the array directly; this encoder is kept so old data can still be produced
// (tests) and recognized.
export function serializeProfiles(list) {
  // The stored shape keeps only the two source fields for a container; `image`
  // is derived on read so it can never drift from name/tag.
  return JSON.stringify((Array.isArray(list) ? list : []).map(({ image, ...rest }) => rest));
}

// True only for the legacy string form of a *stored* profiles value. The read
// path uses this to rewrite that form as the array the schema now declares,
// exactly once. Empty string / array / null are not the old shape.
export function needsProfileMigration(raw) {
  return typeof raw === "string" && raw.trim() !== "";
}

// Legacy: a profile used to carry its own `configFile`. normalizeProfile no
// longer emits that field, so this reads it off the *raw* stored list (array or
// legacy JSON string) — before normalization drops it — so readAllConfig can
// promote the active profile's value into the top-level selection exactly once.
// `id` picks one profile; an unknown/empty id falls back to the first.
export function rawProfileConfigFile(raw, id) {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    try {
      value = JSON.parse(text);
    } catch {
      return "";
    }
  }
  if (!Array.isArray(value)) return "";
  const key = str(id);
  const chosen = (key && value.find((p) => p && p.id === key)) || value[0];
  return str(chosen?.configFile);
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

// Which stored fields must hold a value before this profile can START, as
// stable field keys (the UI maps them to labels). This is the readiness rule
// shared by the deployers; they layer environment checks on top (docker
// present, server.py, Python).
export function missingProfileFields(profile) {
  if (!profile) return [];
  if (profile.type === "container") {
    const missing = [];
    if (!profile.image) missing.push("image");
    if (!profile.containerName) missing.push("containerName");
    return missing;
  }
  return profile.strataDir ? [] : ["strataDir"];
}

export function profileReady(profile) {
  return missingProfileFields(profile).length === 0;
}

export function profileSummary(profile) {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, type: profile.type };
}
