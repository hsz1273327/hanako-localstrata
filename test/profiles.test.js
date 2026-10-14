// Multi-environment profile tests (1.1.0 batch 4).
//
// Covers the pure profile model, the config persistence/CRUD handlers, the
// "at least one profile" / "first profile named default" rules, the running
// lock, profile switching and the container deployer facade.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import {
  parseProfiles,
  normalizeProfile,
  ensureProfiles,
  serializeProfiles,
  validateProfile,
  findProfile,
  profileFromFlat,
  emptyLocalProfile,
  emptyContainerProfile,
  makeDefaultProfile,
  DEFAULT_PROFILE_NAME,
} from "../lib/profiles.js";
import {
  readAllConfig,
  writeProfiles,
  patchActiveProfile,
  getStatus,
  startService,
  selectProfile,
} from "../lib/strata.js";
import { saveProfile, deleteProfile } from "../routes/settings.js";
import { defaultRunParams, buildRunArgs } from "../lib/deployer/docker.js";

const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-profiles-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async setMany(patch) {
        Object.assign(store, patch);
      },
    },
    network: {
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url?.url || String(url);
        if (href.includes("127.0.0.1") || href.includes("localhost")) return fetch(href, init);
        return { ok: false, status: 404, json: async () => ({}) };
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

function localProfile(overrides = {}) {
  return normalizeProfile({
    id: "p-local",
    name: "default",
    type: "local",
    ...overrides,
  });
}

// ── Pure model ────────────────────────────────────────────────────────────

test("normalizeProfile keeps only the fields of the requested type", () => {
  const local = normalizeProfile({ type: "local", strataDir: "/s", image: "x", name: " a " });
  assert.equal(local.type, "local");
  assert.equal(local.strataDir, "/s");
  assert.equal(local.name, "a");
  assert.equal(local.image, undefined);

  const container = normalizeProfile({ type: "container", image: "strata", containerName: "c", strataDir: "/s" });
  assert.equal(container.type, "container");
  assert.equal(container.image, "strata");
  assert.equal(container.containerName, "c");
  assert.equal(container.strataDir, undefined);
});

test("parseProfiles accepts JSON strings/arrays and rejects garbage", () => {
  const list = parseProfiles(JSON.stringify([{ type: "local", name: "a" }]));
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "a");
  assert.equal(parseProfiles([{ type: "container", name: "b" }])[0].type, "container");
  assert.deepEqual(parseProfiles("not json"), []);
  assert.deepEqual(parseProfiles(""), []);
  assert.deepEqual(parseProfiles(null), []);
});

test("ensureProfiles always yields at least one profile, first one is default", () => {
  const fromFlat = ensureProfiles("", { strataDir: "/flat", pythonPath: "/py" });
  assert.equal(fromFlat.length, 1);
  assert.equal(fromFlat[0].id, "default");
  assert.equal(fromFlat[0].name, DEFAULT_PROFILE_NAME);
  assert.equal(fromFlat[0].strataDir, "/flat");
  assert.equal(fromFlat[0].pythonPath, "/py");

  const kept = ensureProfiles(serializeProfiles([{ id: "x", name: "x", type: "container" }]));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "x");
});

test("validateProfile enforces name uniqueness and container fields", () => {
  const list = [localProfile({ id: "a", name: "default" })];
  assert.deepEqual(validateProfile({ type: "local", name: "default" }, { profiles: list, isNew: true }).errors, [
    "nameTaken",
  ]);
  assert.deepEqual(
    validateProfile({ type: "container", name: "c" }, { profiles: list, isNew: true }).errors,
    ["imageRequired", "containerNameRequired"],
  );
  const ok = validateProfile(
    { type: "container", name: "c", image: "strata", containerName: "strata" },
    { profiles: list, isNew: true },
  );
  assert.deepEqual(ok.errors, []);
  // Editing keeps its own name.
  assert.deepEqual(
    validateProfile(localProfile({ id: "a", name: "default" }), { profiles: list, isNew: false }).errors,
    [],
  );
});

test("emptyLocalProfile / emptyContainerProfile / makeDefaultProfile shapes", () => {
  assert.equal(makeDefaultProfile().name, DEFAULT_PROFILE_NAME);
  assert.equal(emptyLocalProfile().type, "local");
  assert.equal(emptyContainerProfile().type, "container");
  assert.ok(findProfile([localProfile()], "p-local"));
  assert.equal(findProfile([localProfile()], "nope"), null);
});

test("profileFromFlat carries the legacy flat settings", () => {
  const p = profileFromFlat({ strataDir: "/s", pythonPath: "/p", gpu: "0", ggufDir: "/g", configFile: "c.json", port: 9090 });
  assert.equal(p.type, "local");
  assert.equal(p.strataDir, "/s");
  assert.equal(p.pythonPath, "/p");
  assert.equal(p.gpu, "0");
  assert.equal(p.ggufDir, "/g");
  assert.equal(p.configFile, "c.json");
  assert.equal(p.port, 9090);
});

// ── Persistence via readAllConfig / writeProfiles ────────────────────────

test("readAllConfig synthesizes a default local profile from flat fields", async () => {
  const ctx = makeCtx({ strataDir: "/legacy", pythonPath: "/python", port: 1234 });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.activeProfileId, "default");
  assert.equal(cfg.activeProfile.name, "default");
  assert.equal(cfg.strataDir, "/legacy");
  assert.equal(cfg.port, 1234);
});

test("writeProfiles persists and readAllConfig restores the active profile", async () => {
  const ctx = makeCtx({});
  const list = [
    localProfile({ id: "p1", name: "default", strataDir: "/one" }),
    normalizeProfile({ id: "p2", name: "card", type: "container", image: "strata", containerName: "strata" }),
  ];
  await writeProfiles(ctx, list, "p2");
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.activeProfileId, "p2");
  assert.equal(cfg.activeProfile.name, "card");
  assert.equal(cfg.activeProfile.type, "container");
  // Container active clears the local-only flat mirror.
  assert.equal(cfg.configFile, "");
});

test("patchActiveProfile updates one field on the active profile", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [
      localProfile({ id: "p1", name: "default", strataDir: "/one", configFile: "" }),
      localProfile({ id: "p2", name: "two", strataDir: "/two" }),
    ],
    "p1",
  );
  await patchActiveProfile(ctx, { configFile: "strata-x.json" });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.configFile, "strata-x.json");
  assert.equal(findProfile(cfg.profiles, "p2").configFile, "");
});

// ── CRUD handlers ─────────────────────────────────────────────────────────

test("saveProfile creates a profile, then updates it in place", async () => {
  const ctx = makeCtx({});
  const created = await saveProfile(ctx, { name: "second", type: "container", image: "strata", containerName: "strata" });
  assert.equal(created.saved, true);
  assert.equal(created.profile.type, "container");
  const cfg = await readAllConfig(ctx);
  // Synthesized `default` + the new one.
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.profiles[0].name, "default");

  const updated = await saveProfile(ctx, { ...created.profile, name: "renamed" });
  const after = await readAllConfig(ctx);
  assert.equal(after.profiles.length, 2);
  assert.equal(findProfile(after.profiles, created.profile.id).name, "renamed");
});

test("saveProfile rejects a duplicate name and missing container fields", async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => saveProfile(ctx, { name: "bad", type: "container" }),
    /imageRequired/,
  );
  await saveProfile(ctx, { name: "first", type: "local", strataDir: "/a" });
  await assert.rejects(
    () => saveProfile(ctx, { name: "first", type: "local", strataDir: "/b" }),
    /nameTaken/,
  );
});

test("deleteProfile keeps at least one profile and clears a deleted active id", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [localProfile({ id: "p1", name: "default" }), localProfile({ id: "p2", name: "two" })],
    "p2",
  );
  const result = await deleteProfile(ctx, "p2");
  assert.equal(result.deleted, "p2");
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.activeProfileId, "p1");

  await assert.rejects(() => deleteProfile(ctx, "p1"), /至少保留一套配置/);
});

test("selectProfile persists the pick and rejects unknown ids", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [localProfile({ id: "p1", name: "default" }), localProfile({ id: "p2", name: "two" })],
    "p1",
  );
  const res = await selectProfile(ctx, "p2");
  assert.equal(res.activeProfileId, "p2");
  assert.equal((await readAllConfig(ctx)).activeProfileId, "p2");
  await assert.rejects(() => selectProfile(ctx, "missing"), /配置不存在/);
});

test("running service locks profile edits and deletes", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "serve"), { recursive: true });
  fs.writeFileSync(path.join(dir, "serve", "server.py"), "# fake\n");

  const server = http.createServer((req, res) => {
    if (req.url === "/v1/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "strata", engine: "9.9.9" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const profile = localProfile({ id: "run", name: "default", strataDir: dir, pythonPath: "/usr/bin/python3", configFile: "strata-demo.json", port });
    fs.writeFileSync(path.join(dir, "strata-demo.json"), JSON.stringify({ port }));

    const ctx = makeCtx({});
    await writeProfiles(ctx, [profile], "run");
    const status = await getStatus(ctx);
    assert.equal(status.state, "running");

    await assert.rejects(() => saveProfile(ctx, { ...profile, name: "changed" }), /运行中.*不能修改配置/);
    await assert.rejects(() => deleteProfile(ctx, "run"), /运行中.*不能删除配置/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Start / container deployer via the profile ───────────────────────────

test("startService with profileId persists the active profile", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [
      localProfile({ id: "p1", name: "default", strataDir: "/nope" }),
      localProfile({ id: "p2", name: "two", strataDir: "/nope" }),
    ],
    "p1",
  );
  // Both are unavailable; the important part is the persisted selection.
  const res = await startService(ctx, { profileId: "p2" });
  assert.equal(res.started, false);
  assert.equal((await readAllConfig(ctx)).activeProfileId, "p2");
});

test("container profile uses the generic run recipe and starts via docker", async () => {
  const profile = normalizeProfile({
    id: "c1",
    name: "card",
    type: "container",
    image: "strata",
    containerName: "strata",
    dataDir: "/srv/strata",
    ggufDir: "/models/UD",
    port: 8088,
  });
  const params = defaultRunParams(profile, profile.port);
  assert.equal(params.image, "strata");
  assert.ok(params.env.includes("STRATA_DATA=/data"));
  assert.ok(params.env.includes("GGUF_DIR=/gguf"));
  assert.ok(params.env.includes("PORT=8088"));
  assert.ok(params.binds.includes("/srv/strata:/data"));
  assert.ok(params.binds.includes("/models/UD:/gguf"));
  assert.equal(params.gpus, "all");
  const args = buildRunArgs("strata", params);
  assert.ok(args.includes("--gpus") && args.includes("all"));
  assert.ok(args.includes("8088:8088"));
  assert.ok(args.includes("strata"));

  const calls = [];
  const docker = {
    available: () => true,
    inspect: () => null,
    imageExists: () => true,
    imageInspect: () => ({ RepoTags: ["strata"], Created: "2024-01-01T00:00:00Z" }),
    raw: (argv) => {
      calls.push(["raw", ...argv]);
      return { ok: true, stdout: "", stderr: "" };
    },
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    restart: () => ({ ok: true }),
    logs: () => "",
    exec: () => {
      throw new Error("not running");
    },
    execRaw: () => ({ ok: true }),
    catFile: () => null,
    cp: () => ({ ok: true }),
    pull: () => ({ ok: true }),
  };
  const ctx = makeCtx({});
  await writeProfiles(ctx, [profile], profile.id);
  const started = await startService(ctx, { docker, platform: "linux" });
  assert.equal(started.started, true);
  assert.equal(started.created, true);
  const runCall = calls.find((c) => c[0] === "raw" && c[1] === "run");
  assert.ok(runCall, "expected docker run");
  assert.ok(runCall.includes("--gpus"));
  assert.ok(runCall.includes("/models/UD:/gguf"));
  assert.equal(started.profile.name, "card");
  assert.equal(started.profile.type, "container");
});
