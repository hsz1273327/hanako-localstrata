import {
  getConfigView,
  applyConfigEdits,
  restartService,
  getStatus,
  readAllConfig,
  listConfigFiles,
  savePluginConfig,
} from "../lib/strata.js";

// NOTE: the route name is "/settings", not "/config" — the Hana host reserves
// GET/PUT /api/plugins/:id/config for its own configuration schema API, which
// would shadow a plugin route named "/config".

// Step 1 of the setup flow: save strataDir / pythonPath and re-run detection.
// Only strataDir is required: an empty pythonPath means "use the system
// python3". configFile / port are never hand-typed: the selected config is
// discovered afterwards (step 2) and the port comes from the selected config
// (or an explicit override set in Hana settings).
async function savePluginSettings(ctx, values) {
  const settings = {
    strataDir: typeof values?.strataDir === "string" ? values.strataDir.trim() : "",
    pythonPath: typeof values?.pythonPath === "string" ? values.pythonPath.trim() : "",
  };

  const errors = [];
  if (!settings.strataDir) errors.push("Strata 目录不能为空");
  // pythonPath may be empty — the system python3 is used (validated by getStatus).
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.validation = errors;
    throw err;
  }

  const patch = { ...settings };

  // Optional: accept an explicit config selection, but only when it really is
  // one of the discovered files (used by the selection UI / advanced callers).
  if (typeof values?.configFile === "string" && values.configFile.trim()) {
    const file = values.configFile.trim();
    if (listConfigFiles(settings.strataDir).includes(file)) patch.configFile = file;
  }

  // Port override: 0 / empty means "use the selected config file's port".
  if (values?.port !== undefined) {
    const p = Number(values.port);
    patch.port = Number.isInteger(p) && p > 0 ? p : 0;
  }

  await savePluginConfig(ctx, patch);
  const status = await getStatus(ctx);
  return { saved: true, status };
}

// Step 2: persist the chosen config file and re-run detection.
async function selectConfigFile(ctx, file) {
  const cfg = await readAllConfig(ctx);
  const files = listConfigFiles(cfg.strataDir);
  if (typeof file !== "string" || !files.includes(file)) {
    const err = new Error("无效的配置文件");
    err.validation = ["无效的配置文件"];
    throw err;
  }
  await savePluginConfig(ctx, { configFile: file });
  const status = await getStatus(ctx);
  return { saved: true, configFile: file, status };
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

  // Save the plugin's own configuration (strataDir / pythonPath), then re-run
  // the status detection so the widget can re-render (step 1 of setup).
  app.post("/settings/plugin", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }

    try {
      return c.json(await savePluginSettings(ctx, body || {}));
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  // Choose one of the discovered config files (step 2 of setup).
  app.post("/settings/config", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }

    try {
      return c.json(await selectConfigFile(ctx, body?.configFile));
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });
}
