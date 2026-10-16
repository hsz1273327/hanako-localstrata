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
import * as fs from "../lib/fsx.js";
import path from "node:path";

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

// ── the optional pre-setup backup ("当前设置备份为") ────────────────────
//
// Why this is a COPY we make, not a name we give setup: setup.py derives its
// target from the model (`tag = fam["tag"] + model` → `ROOT/f"strata-{tag}.json"`,
// setup.py:5034 / :5507) and takes no name argument. Renaming the current file out
// of the way works at the START side — `serve/server.py --config <path>` accepts
// any path (proved by running it against a renamed copy: it read the sampling
// block, the vision block and began loading), and our own list shows anything
// matching `strata-*.json` — so a backup made under that shape stays selectable.
//
// The name shape is therefore not decoration: `^strata-....json$` is exactly what
// the config picker lists (lib/deployer/common.js `listConfigFiles`).
const BACKUP_NAME = /^strata-[A-Za-z0-9._-]+\.json$/;

// Pure: the target file name for a backup, or an error. `current` is the config in
// use (a backup of it under the same name is a no-op).
export function backupTargetName(name, current) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return { name: null, error: null }; // empty = no backup
  if (!BACKUP_NAME.test(wanted)) return { name: null, error: "backupNameShape" };
  if (wanted === String(current ?? "").trim()) return { name: null, error: null };
  return { name: wanted, error: null };
}

// Copy the config in use — AND its shared-settings sibling, whose name the server
// derives from the config's own path (`Path(a.config).with_suffix("") + 
// ".shared-settings.json"`, serve/server.py:5828). Without it the backup would
// silently lose max_tokens / reasoning_effort.
// Refuses to overwrite: a file the user may care about is never replaced silently.
export async function backupCurrentConfig(ctx, opts = {}) {
  const cfg = await readAllConfig(ctx);
  const root = cfg.strataDir;
  const current = String(cfg.configFile || "").trim();
  if (!root || !current) throw validationError("没有可备份的当前配置", ["noCurrentConfig"]);
  const { name, error } = backupTargetName(opts.backupAs, current);
  if (error) throw validationError("备份名必须是 strata-<名字>.json", [error]);
  if (!name) return { copied: [], target: null };
  const from = path.resolve(root, current);
  const to = path.resolve(root, name);
  if (!fs.existsSync(from)) throw validationError(`当前配置不存在：${current}`, ["currentMissing"]);
  if (fs.existsSync(to)) throw validationError(`备份名已存在：${name}`, ["backupExists"]);
  fs.copyFileSync(from, to);
  const copied = [name];
  const shared = current.replace(/\.json$/, ".shared-settings.json");
  const sharedTo = name.replace(/\.json$/, ".shared-settings.json");
  if (fs.existsSync(path.resolve(root, shared)) && !fs.existsSync(path.resolve(root, sharedTo))) {
    fs.copyFileSync(path.resolve(root, shared), path.resolve(root, sharedTo));
    copied.push(sharedTo);
  }
  return { copied, target: name };
}

// A GGUF folder is only useful if it is really there: this is the fs half of the
// check (lib/firstrun.js's validateSetupParams keeps its shape). Returns an error
// code, or null.
export function checkGgufDir(cfg, dir) {
  const wanted = String(dir ?? "").trim();
  if (!wanted) return null; // empty = the general default, then a download
  if (!path.isAbsolute(wanted)) return "ggufDirNotAbsolute";
  try {
    if (!fs.statSync(wanted).isDirectory()) return "ggufDirNotDir";
    fs.readdirSync(wanted); // readable?
  } catch {
    return "ggufDirMissing";
  }
  return null;
}

// Build a config: same job as a first launch, forced (a config may already
// exist) and without the trailing service start. `opts.setup` (whitelisted by
// lib/firstrun.js's validateSetupParams) carries the parameters the user asked to
// change this run; omitting one leaves it to setup.
export async function startConfigSetup(ctx, opts = {}) {
  await assertConfigEditable(ctx, opts);
  const { clean, errors } = validateSetupParams(opts.setup);
  if (errors.length) throw validationError(errors[0], errors);
  const badDir = checkGgufDir(await readAllConfig(ctx), clean.ggufDir);
  if (badDir) throw validationError("GGUF 目录不可用", [badDir]);
  // The backup happens BEFORE the job starts, so the job's own "what did this run
  // produce" snapshot (lib/firstrun.js:293) already contains it and can never
  // mistake the backup for its product.
  const backup = await backupCurrentConfig(ctx, opts);
  const result = await beginFirstRun(ctx, { ...opts, setup: clean, force: true, startAfter: false });
  return { ...result, backup };
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
      const result = await startConfigSetup(ctx, { setup: body?.setup, backupAs: body?.backupAs });
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
