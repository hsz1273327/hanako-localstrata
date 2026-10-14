import {
  getConfigView,
  applyConfigEdits,
  restartService,
  getStatus,
  readAllConfig,
  listConfigFiles,
  savePluginConfig,
  switchDeployMode,
  normalizeImageNames,
  DEFAULTS,
} from "../lib/strata.js";

// NOTE: the route name is "/settings", not "/config" — the Hana host reserves
// GET/PUT /api/plugins/:id/config for its own configuration schema API, which
// would shadow a plugin route named "/config".

// Deployment fields shared by the config form and the mode-switch route.
// Only keys the client actually sent are written, so a partial form never
// wipes the other mode's settings.
function pickDeployFields(values) {
  const patch = {};
  if (typeof values?.strataDir === "string") patch.strataDir = values.strataDir.trim();
  if (typeof values?.pythonPath === "string") patch.pythonPath = values.pythonPath.trim();
  // Model folder shared by both modes (local --gguf-dir / docker GGUF_DIR).
  if (typeof values?.ggufDir === "string") patch.ggufDir = values.ggufDir.trim();
  if (typeof values?.imageName === "string") {
    patch.imageName = values.imageName.trim() || DEFAULTS.imageName;
    patch.imageNames = normalizeImageNames(undefined, patch.imageName);
  }
  if (typeof values?.containerName === "string") {
    patch.containerName = values.containerName.trim() || DEFAULTS.containerName;
  }
  if (typeof values?.volumeName === "string") {
    patch.volumeName = values.volumeName.trim() || DEFAULTS.volumeName;
  }
  return patch;
}

// Step 1 of the setup flow: save strataDir / pythonPath and re-run detection.
// Only strataDir is required: an empty pythonPath means "use the system
// python3". configFile / port are discovered/derived afterwards.
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

  const patch = { ...settings, ...pickDeployFields(values) };

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

// Save the whole deployment choice (mode + fields) and switch modes safely.
// Switching stops the currently-running deployment first; the UI is expected
// to have already asked the user to confirm that destructive step.
async function saveDeploySettings(ctx, values) {
  const target = values?.deployMode;
  if (target !== "local" && target !== "docker") {
    const err = new Error("deployMode 必须是 local 或 docker");
    err.validation = ["deployMode 必须是 local 或 docker"];
    throw err;
  }

  const errors = [];
  if (target === "local" && !String(values?.strataDir || "").trim()) {
    errors.push("本机模式需要填写 Strata 目录");
  }
  if (target === "docker" && !String(values?.imageName || "").trim()) {
    errors.push("Docker 模式需要填写镜像名");
  }
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.validation = errors;
    throw err;
  }

  const patch = pickDeployFields(values);
  // Preserve an explicit config-file selection when it is one of the files
  // discovered under the (possibly new) Strata directory.
  if (target === "local" && typeof values?.configFile === "string" && values.configFile.trim()) {
    const file = values.configFile.trim();
    if (listConfigFiles(patch.strataDir || "").includes(file)) patch.configFile = file;
  }
  return switchDeployMode(ctx, target, patch);
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

  // Unified deploy-mode form: top-level local/docker choice + the fields of
  // the chosen mode. Switching stops the previous deployment first.
  app.post("/settings/deploy", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }

    try {
      return c.json(await saveDeploySettings(ctx, body || {}));
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
