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
  profileReady,
  missingProfileFields,
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

// Readiness is the rule the stop page and the profile list rely on. Pin it with
// a fully filled container profile (the "dockertest" report): a complete profile
// must never be judged as unable to start.
test("readiness: a filled container profile is ready; an empty one names its fields", () => {
  const filled = normalizeProfile({
    id: "c1",
    name: "dockertest",
    type: "container",
    image: "strata:latest",
    containerName: "strata",
    dataDir: "/data/strata-docker-config",
  });
  assert.deepEqual(missingProfileFields(filled), []);
  assert.equal(profileReady(filled), true);

  assert.deepEqual(
    missingProfileFields(normalizeProfile({ type: "container", image: "", containerName: "strata" })),
    ["image"],
  );
  assert.deepEqual(
    missingProfileFields(normalizeProfile({ type: "container", image: "strata:latest", containerName: "" })),
    ["containerName"],
  );
  // Local readiness keys off the Strata directory only.
  assert.deepEqual(missingProfileFields(normalizeProfile({ type: "local", strataDir: "/srv/Strata" })), []);
  assert.deepEqual(missingProfileFields(normalizeProfile({ type: "local", strataDir: "" })), ["strataDir"]);
});

// The status payload must carry the readiness verdict (and the missing keys) per
// profile. The panel only receives {id,name,type} plus these; without them it
// re-derived the fields it never got and marked every profile "not ready".
test("the status payload carries each profile's readiness", async () => {
  const dir = tmpDir();
  const local = localProfile({ id: "l1", name: "default", strataDir: dir });
  const container = normalizeProfile({
    id: "c1",
    name: "dockertest",
    type: "container",
    image: "strata:latest",
    containerName: "strata",
    dataDir: "/data/strata-docker-config",
  });
  const ctx = makeCtx({});
  await writeProfiles(ctx, [local, container], "l1");
  const status = await getStatus(ctx, { platform: "linux" });
  const byId = Object.fromEntries(status.profiles.map((p) => [p.id, p]));
  assert.equal(byId.c1.ready, true, "a complete container profile is ready");
  assert.deepEqual(byId.c1.missing, []);
  assert.equal(byId.l1.ready, true);
  assert.deepEqual(byId.l1.missing, []);
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

// ── General defaults fallback (priority: profile value → general default) ──

test("general defaults fill empty profile fields; the profile's own values win", async () => {
  const ctx = makeCtx({ defaultGgufDir: "/general/models", defaultPort: 9000 });
  await writeProfiles(
    ctx,
    [
      localProfile({ id: "p1", name: "default", strataDir: "/one", ggufDir: "", port: 0, configFile: "strata-a.json" }),
      localProfile({ id: "p2", name: "own", strataDir: "/two", ggufDir: "/own/models", port: 1234, configFile: "strata-b.json" }),
    ],
    "p1",
  );

  // Active p1 leaves both fields empty → the general defaults apply.
  let cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.ggufDir, "/general/models");
  assert.equal(cfg.activeProfile.port, 9000);
  assert.equal(cfg.ggufDir, "/general/models");
  assert.equal(cfg.port, 9000);
  // The configFile fallback/auto path is untouched.
  assert.equal(cfg.activeProfile.configFile, "strata-a.json");
  assert.equal(cfg.configFile, "strata-a.json");

  // Switch to p2: its own values win over the general defaults.
  await selectProfile(ctx, "p2");
  cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.ggufDir, "/own/models");
  assert.equal(cfg.activeProfile.port, 1234);
  assert.equal(cfg.ggufDir, "/own/models");
  assert.equal(cfg.port, 1234);
});

test("a synthesized default profile also honours the general defaults", async () => {
  const ctx = makeCtx({ strataDir: "/legacy", defaultGgufDir: "/general", defaultPort: 9001 });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.ggufDir, "/general");
  assert.equal(cfg.activeProfile.port, 9001);
  assert.equal(cfg.ggufDir, "/general");
  assert.equal(cfg.port, 9001);
});

test("general defaults are applied to the effective profile, not the persisted list", async () => {
  const ctx = makeCtx({ defaultGgufDir: "/general/models", defaultPort: 9000 });
  await writeProfiles(
    ctx,
    [localProfile({ id: "p1", name: "default", strataDir: "/one", ggufDir: "", port: 0 })],
    "p1",
  );
  const cfg = await readAllConfig(ctx);
  // The effective copy the deployers receive carries the resolved values…
  assert.equal(cfg.activeProfile.ggufDir, "/general/models");
  assert.equal(cfg.activeProfile.port, 9000);
  // …but the stored profile keeps its original empty/0 values.
  assert.ok(Array.isArray(ctx._store.profiles), "profiles are stored as an array");
  const stored = ctx._store.profiles;
  assert.equal(stored[0].ggufDir, "");
  assert.equal(stored[0].port, 0);
});

// ── Stored shape: array now, legacy JSON string still readable ────────────

test("writeProfiles persists a real array, never a JSON string", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [
      localProfile({ id: "p1", name: "default", strataDir: "/one" }),
      normalizeProfile({ id: "p2", name: "card", type: "container", image: "strata", containerName: "strata" }),
    ],
    "p2",
  );
  // The stored value is the array itself — a string would break `.length`,
  // `.map`, `.filter` on any consumer that reads ctx.config directly.
  assert.ok(Array.isArray(ctx._store.profiles));
  assert.equal(typeof ctx._store.profiles, "object");
  assert.equal(ctx._store.profiles.length, 2);
  assert.equal(ctx._store.profiles[0].id, "p1");
  assert.equal(ctx._store.profiles[1].type, "container");
  assert.equal(ctx._store.activeProfileId, "p2");
});

test("a legacy JSON-string profile list is still read, and migrated once", async () => {
  const legacy = serializeProfiles([
    { id: "default", name: "default", type: "local", strataDir: "/legacy", pythonPath: "/py" },
    { id: "p-6f1cb941", name: "dockertest", type: "container", image: "strata", containerName: "strata" },
  ]);
  const ctx = makeCtx({ profiles: legacy, activeProfileId: "p-6f1cb941" });
  // Count writes so we can prove the migration fires exactly once.
  const originalSetMany = ctx.config.setMany.bind(ctx.config);
  let writes = 0;
  ctx.config.setMany = async (patch) => {
    writes += 1;
    return originalSetMany(patch);
  };

  const cfg = await readAllConfig(ctx);
  // Old shape reads correctly…
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.activeProfileId, "p-6f1cb941");
  assert.equal(cfg.activeProfile.name, "dockertest");
  // …and the stored value is rewritten as an array (migrated).
  assert.ok(Array.isArray(ctx._store.profiles));
  assert.equal(ctx._store.profiles.length, 2);
  assert.equal(writes, 1);

  // Later reads see an array and stay read-only: no further migration writes.
  await readAllConfig(ctx);
  await readAllConfig(ctx);
  assert.equal(writes, 1);
});

test("a fresh install has nothing to migrate and stays write-free on read", async () => {
  const ctx = makeCtx({});
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.activeProfile.name, DEFAULT_PROFILE_NAME);
  // Nothing was ever stored, so the read path never wrote a legacy string.
  assert.equal(ctx._store.profiles, undefined);
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

// The narrowed rule (1.1.0 batch 9): while the service runs, only the profile
// it is running from is frozen. Any other profile is plain stored
// configuration — editing or deleting it writes ctx.config and nothing else,
// so the running deployment cannot be disturbed.
test("running service locks the in-use profile only", async () => {
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
    const spare = localProfile({ id: "spare", name: "spare", strataDir: "/elsewhere" });
    fs.writeFileSync(path.join(dir, "strata-demo.json"), JSON.stringify({ port }));

    const ctx = makeCtx({});
    await writeProfiles(ctx, [profile, spare], "run");
    const status = await getStatus(ctx);
    assert.equal(status.state, "running");

    // The profile in use is locked while the service runs.
    await assert.rejects(
      () => saveProfile(ctx, { ...profile, name: "changed" }),
      /运行中.*不能修改正在使用的配置/,
    );
    await assert.rejects(() => deleteProfile(ctx, "run"), /运行中.*不能删除正在使用的配置/);

    // Another profile is not: the write only touches ctx.config, and the
    // active selection plus the running service stay exactly as they were.
    const saved = await saveProfile(ctx, { ...spare, name: "renamed", ggufDir: "/models/x" });
    assert.equal(saved.saved, true);
    let cfg = await readAllConfig(ctx);
    assert.equal(findProfile(cfg.profiles, "spare").name, "renamed");
    assert.equal(findProfile(cfg.profiles, "spare").ggufDir, "/models/x");
    assert.equal(cfg.activeProfileId, "run");
    assert.equal((await getStatus(ctx)).state, "running");

    // Deleting it is the same kind of action, so it is allowed too.
    const deleted = await deleteProfile(ctx, "spare");
    assert.equal(deleted.deleted, "spare");
    cfg = await readAllConfig(ctx);
    assert.equal(cfg.profiles.length, 1);
    assert.equal(cfg.activeProfileId, "run");
    assert.equal((await getStatus(ctx)).state, "running");

    // The structural rules still hold: the last profile cannot be removed.
    await assert.rejects(() => deleteProfile(ctx, "run"), /至少保留一套配置|正在使用的配置/);
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
