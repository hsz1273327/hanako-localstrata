// POST /config/select { file } — choose which setup result (strata-*.json) the
//                              local source deployment starts with.
// POST /config/setup          — build a NEW config by running setup.py.
//
// Both are LOCAL-source concerns ("a config = the product of one setup"), and
// both are stopped-only: a running service must never have its configuration
// switched or rebuilt out from under it. A container profile's config is
// derived from the container's own env and is managed by the container, so
// these routes refuse it instead of inventing a parallel container flow.
//
// `/config/setup` reuses lib/firstrun.js's single background job (force + no
// auto-start); progress is polled through GET /start, the exact same contract a
// first launch uses — there is deliberately no second progress API.
import { readAllConfig, savePluginConfig, getStatus, listConfigFiles, describeConfigFile } from "../lib/strata.js";
import { beginFirstRun, validateSetupParams } from "../lib/firstrun.js";

const RUNNING_STATES = new Set(["running", "starting", "stopping", "restarting"]);

function validationError(message, validation) {
  const err = new Error(message);
  err.validation = validation || [message];
  return err;
}

// Shared guard: config selection/creation is local-only and stopped-only.
// Reads the real status so the decision never relies on the front-end hiding a
// control. Returns the status for callers that want it.
export async function assertConfigEditable(ctx, opts = {}) {
  const status = await getStatus(ctx, opts);
  if (status.state === "unsupported") {
    throw validationError("当前平台不支持选择或新建配置", ["unsupported"]);
  }
  if (status.profile?.type === "container" || status.launch?.method === "docker") {
    throw validationError("容器模式的配置由容器自身管理，不支持在此选择或新建", ["containerManaged"]);
  }
  if (RUNNING_STATES.has(status.state)) {
    throw validationError("服务运行中，不能更改配置；请先停止服务", ["running"]);
  }
  return status;
}

// Pick an existing config: validate it against the directory's real candidates,
// then write the top-level selection. Returns the fresh status so the caller
// can repaint in one round trip.
export async function selectConfig(ctx, file, opts = {}) {
  const name = String(file || "").trim();
  if (!name) throw validationError("请选择要使用的配置文件", ["fileRequired"]);
  await assertConfigEditable(ctx, opts);
  const cfg = await readAllConfig(ctx);
  const candidates = listConfigFiles(cfg.strataDir).map((f) => describeConfigFile(cfg.strataDir, f));
  if (!candidates.some((c) => c.file === name)) {
    throw validationError(`配置不存在：${name}`, ["fileNotFound"]);
  }
  await savePluginConfig(ctx, { configFile: name });
  return { saved: true, configFile: name, status: await getStatus(ctx, opts) };
}

// Build a config: same job as a first launch, forced (a config may already
// exist) and without the trailing service start. `opts.setup` (whitelisted by
// lib/firstrun.js's validateSetupParams) carries the parameters the user asked to
// change this run; omitting one leaves it to setup.
export async function startConfigSetup(ctx, opts = {}) {
  await assertConfigEditable(ctx, opts);
  const { clean, errors } = validateSetupParams(opts.setup);
  if (errors.length) throw validationError(errors[0], errors);
  return beginFirstRun(ctx, { ...opts, setup: clean, force: true, startAfter: false });
}

export default function registerConfigRoutes(app, ctx) {
  app.post("/config/select", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }
    try {
      return c.json(await selectConfig(ctx, body?.file));
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });

  app.post("/config/setup", async (c) => {
    let body = null;
    try {
      body = await c.req.json();
    } catch {
      // No body = run setup with everything left to setup. Not an error.
    }
    try {
      const result = await startConfigSetup(ctx, { setup: body?.setup });
      if (result.alreadyRunning) {
        return c.json({ ...result, error: "已有配置任务正在进行中" }, 409);
      }
      if (!result.needed) {
        return c.json({ started: false, error: "当前环境不能新建配置", ...result }, 400);
      }
      return c.json(result);
    } catch (e) {
      return c.json({ started: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });
}
