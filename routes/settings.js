import {
  getConfigView,
  applyConfigEdits,
  restartService,
  getStatus,
  readAllConfig,
  readConfig,
  savePluginConfig,
  writeProfiles,
  selectProfile,
  findProfile,
  validateProfile,
  makeDefaultProfile,
} from "../lib/strata.js";

// NOTE: the route name is "/settings", not "/config" — the Hana host reserves
// GET/PUT /api/plugins/:id/config for its own configuration schema API, which
// would shadow a plugin route named "/config".
//
// Profiles are the 1.1.0 configuration unit: each one is either a local source
// checkout or a container. The configuration page lists/creates/edits/deletes
// them; while a service is running, existing profiles may not be edited or
// deleted, and at least one profile must always remain.

const RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

// The three global settings the custom settings page renders. `apiKey` stays
// in the host schema as a sensitive field; the route never hands the real key
// to the browser, only a mask, so an unchanged masked field is discarded.
const API_KEY_MASK = "********";
const PREFS_REFRESH_DEFAULT = 5;

function validationError(message, validation) {
  const err = new Error(message);
  err.validation = validation || [message];
  return err;
}

function normalizeRefreshSec(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// ── Global preferences (ctx.config) ──────────────────────────────────────
//
// The host used to render these three fields from the manifest schema; the
// custom settings page reads and writes them through these endpoints instead.
// profiles / activeProfileId deliberately stay backend-only.

export async function readPrefs(ctx) {
  const autoStart = (await readConfig(ctx, "autoStart")) === true;
  const refreshSec = normalizeRefreshSec(await readConfig(ctx, "refreshSec")) ?? PREFS_REFRESH_DEFAULT;
  const apiKey = await readConfig(ctx, "apiKey");
  const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;
  return {
    autoStart,
    refreshSec,
    // Never leak the real secret to the page; a masked value means "unchanged".
    apiKey: hasApiKey ? API_KEY_MASK : "",
    hasApiKey,
  };
}

export async function writePrefs(ctx, raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, "autoStart")) {
    if (typeof body.autoStart !== "boolean") {
      throw validationError("autoStart must be a boolean", ["autoStart:boolean"]);
    }
    patch.autoStart = body.autoStart;
  }

  if (Object.prototype.hasOwnProperty.call(body, "refreshSec")) {
    const refreshSec = normalizeRefreshSec(body.refreshSec);
    if (refreshSec === null) {
      throw validationError("refreshSec must be an integer >= 1", ["refreshSec:integer"]);
    }
    patch.refreshSec = refreshSec;
  }

  if (Object.prototype.hasOwnProperty.call(body, "apiKey")) {
    if (typeof body.apiKey !== "string") {
      throw validationError("apiKey must be a string", ["apiKey:string"]);
    }
    // The mask means the user did not touch the field; keep the stored key.
    if (body.apiKey !== API_KEY_MASK) patch.apiKey = body.apiKey;
  }

  if (Object.keys(patch).length) await savePluginConfig(ctx, patch);
  return readPrefs(ctx);
}

async function assertNotRunning(ctx, action) {
  const status = await getStatus(ctx);
  if (RUNNING_STATES.has(status.state)) {
    throw validationError(`服务运行中，不能${action}配置；请先停止服务`, [`运行中不能${action}配置`]);
  }
  return status;
}

// Create or update one profile. Returns the persisted list.
export async function saveProfile(ctx, raw) {
  const cfg = await readAllConfig(ctx);
  const id = String(raw?.id || "").trim();
  const existing = id ? findProfile(cfg.profiles, id) : null;
  if (existing) await assertNotRunning(ctx, "修改");

  const isNew = !existing;
  let proposed = raw || {};
  // The first profile is always named "default".
  if (isNew && !String(proposed.name || "").trim()) {
    proposed = { ...proposed, name: cfg.profiles.length === 0 ? makeDefaultProfile().name : proposed.name };
  }
  const { profile, errors } = validateProfile(proposed, { profiles: cfg.profiles, isNew });
  if (errors.length) throw validationError(errors.join("; "), errors);

  const list = existing
    ? cfg.profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...cfg.profiles, profile];
  const saved = await writeProfiles(ctx, list, cfg.activeProfileId);
  return {
    saved: true,
    profile,
    profiles: saved.profiles,
    activeProfileId: saved.activeProfileId,
    status: await getStatus(ctx),
  };
}

export async function deleteProfile(ctx, id) {
  const cfg = await readAllConfig(ctx);
  await assertNotRunning(ctx, "删除");
  const target = findProfile(cfg.profiles, id);
  if (!target) throw validationError("配置不存在", ["配置不存在"]);
  if (cfg.profiles.length <= 1) {
    throw validationError("至少保留一套配置", ["至少保留一套配置"]);
  }
  const list = cfg.profiles.filter((p) => p.id !== id);
  const nextActive = cfg.activeProfileId === id ? list[0].id : cfg.activeProfileId;
  const saved = await writeProfiles(ctx, list, nextActive);
  return {
    saved: true,
    deleted: id,
    profiles: saved.profiles,
    activeProfileId: saved.activeProfileId,
    status: await getStatus(ctx),
  };
}

export default function registerSettingsRoutes(app, ctx) {
  app.get("/settings", async (c) => {
    try {
      return c.json(await getConfigView(ctx));
    } catch (e) {
      return c.json({ error: String(e?.message || e) }, 500);
    }
  });

  app.post("/settings", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }

    try {
      const edits = body?.edits || {};
      const result = await applyConfigEdits(ctx, edits);
      if (body?.restart && result.saved) {
        result.restart = await restartService(ctx);
      }
      return c.json(result);
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  // ── Custom settings page: global preferences ─────────────────────────

  app.get("/prefs", async (c) => {
    try {
      return c.json(await readPrefs(ctx));
    } catch (e) {
      return c.json({ error: String(e?.message || e) }, 500);
    }
  });

  app.post("/prefs", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    try {
      return c.json(await writePrefs(ctx, body || {}));
    } catch (e) {
      return c.json({ error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  // ── Profile management ─────────────────────────────────────────────────

  app.get("/profiles", async (c) => {
    try {
      const cfg = await readAllConfig(ctx);
      return c.json({
        profiles: cfg.profiles,
        activeProfileId: cfg.activeProfileId,
      });
    } catch (e) {
      return c.json({ error: String(e?.message || e) }, 500);
    }
  });

  app.post("/profiles/save", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }
    try {
      return c.json(await saveProfile(ctx, body || {}));
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  app.post("/profiles/delete", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }
    try {
      return c.json(await deleteProfile(ctx, body?.id));
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  app.post("/profiles/select", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }
    try {
      return c.json({ saved: true, ...(await selectProfile(ctx, body?.id)), status: await getStatus(ctx) });
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });
}
