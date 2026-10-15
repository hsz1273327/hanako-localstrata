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
import { gpuTemplate, parseGpuIds, GPU_MODELS, GPU_MODEL_KEYS, GPU_VENDORS, gpuModelCatalog, gpuModelInfo } from "../lib/gpu.js";
import { containerSpec, renderComposeFile, mergeEnv } from "../lib/compose.js";

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
    ["gpuModelRequired", "imageRequired", "containerNameRequired"],
  );
  assert.deepEqual(
    validateProfile(
      { type: "container", name: "c", image: "strata", containerName: "strata", GpuModel: "bogus" },
      { profiles: list, isNew: true },
    ).errors,
    ["gpuModelUnknown"],
  );
  const ok = validateProfile(
    { type: "container", name: "c", image: "strata", containerName: "strata", GpuModel: "nvidia" },
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

test("profileFromFlat carries the legacy flat settings (but not the config file)", () => {
  const p = profileFromFlat({ strataDir: "/s", pythonPath: "/p", gpu: "0", ggufDir: "/g", configFile: "c.json", port: 9090 });
  assert.equal(p.type, "local");
  assert.equal(p.strataDir, "/s");
  assert.equal(p.pythonPath, "/p");
  assert.equal(p.gpu, "0");
  assert.equal(p.ggufDir, "/g");
  assert.equal(p.port, 9090);
  // The chosen config is the top-level key, never a profile field: the profile
  // only says where Strata runs.
  assert.equal(p.configFile, undefined);
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
      localProfile({ id: "p1", name: "default", strataDir: "/one", ggufDir: "", port: 0 }),
      localProfile({ id: "p2", name: "own", strataDir: "/two", ggufDir: "/own/models", port: 1234 }),
    ],
    "p1",
  );

  // Active p1 leaves both fields empty → the general defaults apply.
  let cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.ggufDir, "/general/models");
  assert.equal(cfg.activeProfile.port, 9000);
  assert.equal(cfg.ggufDir, "/general/models");
  assert.equal(cfg.port, 9000);
  // The config file is not a profile field: an untouched top-level key stays
  // empty and no profile carries a configFile to fall back on.
  assert.equal(cfg.activeProfile.configFile, undefined);
  assert.equal(cfg.configFile, "");

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

// Legacy installs kept the chosen config ON the profile. normalizeProfile no
// longer emits that field, so readAllConfig must lift it off the raw stored list
// into the top-level key — otherwise an empty top-level key auto-picks the
// newest file and silently changes which config runs.
test("a legacy per-profile configFile is lifted into the top-level selection once", async () => {
  const ctx = makeCtx({
    profiles: [
      { id: "p1", name: "default", type: "local", strataDir: "/one", configFile: "strata-chosen.json" },
      { id: "p2", name: "two", type: "local", strataDir: "/two", configFile: "strata-other.json" },
    ],
    activeProfileId: "p1",
  });
  const originalSetMany = ctx.config.setMany.bind(ctx.config);
  let writes = 0;
  ctx.config.setMany = async (patch) => {
    writes += 1;
    return originalSetMany(patch);
  };

  const cfg = await readAllConfig(ctx);
  // The ACTIVE profile's value wins, and lands on the top-level key.
  assert.equal(cfg.configFile, "strata-chosen.json");
  assert.equal(ctx._store.configFile, "strata-chosen.json");
  // …and the field is stripped from every persisted profile.
  assert.ok(Array.isArray(ctx._store.profiles));
  assert.equal(ctx._store.profiles[0].configFile, undefined);
  assert.equal(ctx._store.profiles[1].configFile, undefined);
  assert.equal(writes, 1);

  // Later reads find nothing left to migrate and stay write-free.
  await readAllConfig(ctx);
  assert.equal(writes, 1);
});

test("an existing top-level selection wins over a legacy profile configFile", async () => {
  const ctx = makeCtx({
    configFile: "strata-toplevel.json",
    profiles: [
      { id: "p1", name: "default", type: "local", strataDir: "/one", configFile: "strata-legacy.json" },
    ],
    activeProfileId: "p1",
  });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.configFile, "strata-toplevel.json");
});

test("patchActiveProfile updates one field on the active profile only", async () => {
  const ctx = makeCtx({});
  await writeProfiles(
    ctx,
    [
      localProfile({ id: "p1", name: "default", strataDir: "/one" }),
      localProfile({ id: "p2", name: "two", strataDir: "/two" }),
    ],
    "p1",
  );
  await patchActiveProfile(ctx, { ggufDir: "/models/x" });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.ggufDir, "/models/x");
  assert.equal(findProfile(cfg.profiles, "p2").ggufDir, "");
});

// ── CRUD handlers ─────────────────────────────────────────────────────────

test("saveProfile creates a profile, then updates it in place", async () => {
  const ctx = makeCtx({});
  const created = await saveProfile(ctx, { name: "second", type: "container", image: "strata", containerName: "strata", GpuModel: "nvidia" });
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
    const profile = localProfile({ id: "run", name: "default", strataDir: dir, pythonPath: "/usr/bin/python3", port });
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

test("a legacy container profile migrates its fields onto the new model", () => {
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
  // dataDir → VolumeBinds ("<dir>:/data") …
  assert.deepEqual(profile.VolumeBinds, ["/srv/strata:/data"]);
  // …ggufDir → ModelDir + ModelsBindDir=/gguf (the old mount point)…
  assert.equal(profile.ModelDir, "/models/UD");
  assert.equal(profile.ModelsBindDir, "/gguf");
  // …and port → both engine ports.
  assert.equal(profile.EnginePort, 8088);
  assert.equal(profile.EngineBindPort, 8088);
  // The removed fields are gone, and the legacy env that made the old container
  // work is preserved on the environment list.
  assert.equal(profile.dataDir, undefined);
  assert.equal(profile.ggufDir, undefined);
  assert.equal(profile.port, undefined);
  assert.ok(profile.environment.includes("STRATA_DATA=/data"));
  assert.ok(profile.environment.includes("GGUF_DIR=/gguf"));
  assert.ok(profile.environment.includes("PORT=8088"));
  assert.ok(profile.environment.includes("HOST=0.0.0.0"));
});

test("a container profile without legacy fields gets no implicit env", () => {
  const profile = normalizeProfile({
    id: "c2",
    name: "mi50",
    type: "container",
    imageName: "xxdoman/strata-mi50",
    imageTag: "0.1.43.1",
    containerName: "strata-mi50",
    ModelDir: "/models/UD",
  });
  assert.equal(profile.ModelsBindDir, "/models");
  assert.deepEqual(profile.VolumeBinds, []);
  assert.deepEqual(profile.environment, []);
  assert.equal(profile.EnginePort, 0);
  assert.equal(profile.image, "xxdoman/strata-mi50:0.1.43.1");
});

// The legacy `docker run` recipe is only used when the host has no
// `docker compose`; it is built from the same spec as the compose file.
test("container profile starts via the legacy docker run path when compose is absent", async () => {
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
  const params = defaultRunParams(profile, { apiKey: "" });
  assert.equal(params.image, "strata");
  assert.ok(params.env.includes("STRATA_DATA=/data"));
  assert.ok(params.env.includes("GGUF_DIR=/gguf"));
  assert.ok(params.env.includes("PORT=8088"));
  assert.ok(params.binds.includes("/srv/strata:/data"));
  assert.ok(params.binds.includes("/models/UD:/gguf"));
  const args = buildRunArgs("strata", params);
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
  assert.ok(runCall.includes("/models/UD:/gguf"));
  assert.equal(started.profile.name, "card");
  assert.equal(started.profile.type, "container");
});

// With compose on the host, start goes through `docker compose up -d`, after
// materializing the compose file from the profile fields.
test("container start uses docker compose up and writes the compose file", async () => {
  const dir = tmpDir();
  const profile = normalizeProfile({
    id: "c2",
    name: "mi50",
    type: "container",
    imageName: "xxdoman/strata-mi50",
    imageTag: "0.1.43.1",
    containerName: "strata-mi50",
    ModelDir: "/models/UD",
    ModelsBindDir: "/models",
    VolumeBinds: ["/srv/data:/data"],
    EnginePort: 8085,
    EngineBindPort: 8085,
    GpuModel: "amd-mi50",
    device_cgroup_rules: ["c 227:* rmw"],
    ulimits: ["memlock=-1"],
    security_opt: ["seccomp=unconfined"],
    environment: ["MODELS_DIR=/models"],
    ApiKeyEnv: "API_KEY",
    DeployDir: dir,
  });
  const upCalls = [];
  const docker = {
    available: () => true,
    inspect: () => null,
    imageExists: () => true,
    imageInspect: () => null,
    raw: () => ({ ok: true, stdout: "", stderr: "" }),
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
    compose: {
      available: () => true,
      up: (d) => {
        upCalls.push(d);
        return { ok: true, stdout: "", stderr: "" };
      },
      stop: () => ({ ok: true }),
      restart: () => ({ ok: true }),
      logs: () => ({ ok: true, stdout: "", stderr: "" }),
    },
  };
  const ctx = makeCtx({});
  await writeProfiles(ctx, [profile], profile.id);
  const started = await startService(ctx, { docker, platform: "linux" });
  assert.equal(started.started, true);
  assert.equal(started.via, "compose");
  assert.deepEqual(upCalls, [dir]);

  const text = fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8");
  assert.match(text, /image: "xxdoman\/strata-mi50:0\.1\.43\.1"/);
  assert.match(text, /container_name: "strata-mi50"/);
  assert.match(text, /- "8085:8085"/);
  assert.match(text, /- "\/models\/UD:\/models"/);
  assert.match(text, /- "\/srv\/data:\/data"/);
  // AMD MI50 model template: the ROCm device nodes + its cgroup rule (unioned
  // with the user's own rule) + the two envs the model requires, none typed by
  // the user.
  assert.match(text, /- "\/dev\/kfd:\/dev\/kfd"/);
  assert.match(text, /- "\/dev\/dri:\/dev\/dri"/);
  assert.match(text, /device_cgroup_rules:/);
  assert.match(text, /- "c 226:\* rmw"/);
  assert.match(text, /- "c 227:\* rmw"/);
  assert.match(text, /- "HSA_OVERRIDE_GFX_VERSION=9\.0\.6"/);
  assert.match(text, /- "LD_LIBRARY_PATH=\/opt\/rocm\/lib"/);
  assert.match(text, /- "MODELS_DIR=\/models"/);
  assert.match(text, /memlock: -1/);
  assert.match(text, /- "seccomp=unconfined"/);
  // The API key is interpolated from .env, never baked into the shareable file.
  assert.match(text, /- "API_KEY=\$\{STRATA_API_KEY\}"/);
});

// ── GPU vendor template (lib/gpu.js) ──────────────────────────────────────
//
// The docker vocabulary (device reservations / --gpus / device nodes) is a
// ── GPU card-model catalog (lib/gpu.js) ───────────────────────────────────
//
// The docker vocabulary (device reservations / --gpus / device nodes / model
// env) is a template the user never types: they pick one card model (+ optional
// card ids). Every branch is pinned so the compose writer and the legacy
// `docker run` path cannot drift.

test("the catalog has no `none`, and every model maps to nvidia or amd", () => {
  assert.deepEqual(GPU_VENDORS, ["nvidia", "amd"]);
  assert.ok(GPU_MODEL_KEYS.includes("nvidia") && GPU_MODEL_KEYS.includes("amd-mi50"));
  for (const m of gpuModelCatalog()) {
    assert.ok(GPU_VENDORS.includes(m.vendor), `${m.key} has a bad vendor`);
    assert.equal(typeof m.label, "string");
  }
  assert.equal(gpuModelInfo("nope"), null);
});

test("gpuTemplate: nvidia expands to a device reservation and --gpus", () => {
  const all = gpuTemplate("nvidia", "all");
  assert.deepEqual(all.devices, []);
  assert.deepEqual(all.env, []);
  assert.deepEqual(all.deployDevices, [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }]);
  assert.equal(all.cliGpus, "all");

  // Empty ids behave like "all" (picking the model without picking cards).
  assert.deepEqual(gpuTemplate("nvidia", "").deployDevices, [
    { driver: "nvidia", count: "all", capabilities: ["gpu"] },
  ]);

  const ids = gpuTemplate("nvidia", "0,1");
  assert.deepEqual(ids.deployDevices, [
    { driver: "nvidia", deviceIds: ["0", "1"], capabilities: ["gpu"] },
  ]);
  assert.equal(ids.cliGpus, "device=0,1");
});

test("gpuTemplate: amd-mi50 carries the ROCm nodes + cgroup rule + its two envs", () => {
  const mi50 = gpuTemplate("amd-mi50", "");
  assert.deepEqual(mi50.devices, ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"]);
  assert.deepEqual(mi50.deviceCgroupRules, ["c 226:* rmw"]);
  assert.deepEqual(mi50.env, ["HSA_OVERRIDE_GFX_VERSION=9.0.6", "LD_LIBRARY_PATH=/opt/rocm/lib"]);
  assert.deepEqual(mi50.deployDevices, []);
  assert.equal(mi50.cliGpus, null);
});

test("gpuTemplate: other AMD models expose the device nodes but need no env", () => {
  for (const key of ["amd-7900xtx", "amd-9060xt", "amd-9070xt", "amd"]) {
    const t = gpuTemplate(key, "");
    assert.deepEqual(t.devices, ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"]);
    assert.deepEqual(t.env, []);
    assert.deepEqual(t.deployDevices, []);
    assert.equal(t.cliGpus, null);
  }
});

test("gpuTemplate: unknown / empty model expands to nothing", () => {
  for (const model of ["", undefined, "bogus", "none"]) {
    const t = gpuTemplate(model, "0");
    assert.equal(t.known, false);
    assert.deepEqual(t.devices, []);
    assert.deepEqual(t.deviceCgroupRules, []);
    assert.deepEqual(t.env, []);
    assert.deepEqual(t.deployDevices, []);
    assert.equal(t.cliGpus, null);
  }
});

test("parseGpuIds accepts all / single / list and drops junk", () => {
  assert.deepEqual(parseGpuIds("all"), []);
  assert.deepEqual(parseGpuIds(""), []);
  assert.deepEqual(parseGpuIds("0"), ["0"]);
  assert.deepEqual(parseGpuIds("0,1"), ["0", "1"]);
  assert.deepEqual(parseGpuIds(" 0 , 2 "), ["0", "2"]);
  assert.deepEqual(parseGpuIds("a,1"), ["1"]);
});

test("mergeEnv: the user's environment wins on a key conflict", () => {
  const merged = mergeEnv(["HSA_OVERRIDE_GFX_VERSION=9.0.6", "LD_LIBRARY_PATH=/opt/rocm/lib"], [
    "HSA_OVERRIDE_GFX_VERSION=11.0.0",
    "MODELS_DIR=/models",
  ]);
  // The user's value is kept once; the untouched template key is added after.
  assert.deepEqual(merged, [
    "HSA_OVERRIDE_GFX_VERSION=11.0.0",
    "MODELS_DIR=/models",
    "LD_LIBRARY_PATH=/opt/rocm/lib",
  ]);
});

test("an nvidia container writes deploy.resources…devices (zero-regression for --gpus all)", () => {
  const spec = containerSpec({ containerName: "s", imageName: "img", GpuModel: "nvidia", GpuIds: "all" });
  assert.deepEqual(spec.devices, []);
  assert.deepEqual(spec.deployDevices, [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }]);
  assert.equal(spec.cliGpus, "all");
  const text = renderComposeFile(spec, { profileName: "s" });
  assert.match(text, /deploy:/);
  assert.match(text, /reservations:/);
  assert.match(text, /- driver: "nvidia"/);
  assert.match(text, /count: all/);
  // The generated file must not carry the top-level `gpus:` shorthand.
  assert.doesNotMatch(text, /^\s+gpus:/m);
});

test("an MI50 container writes the ROCm nodes + both model envs without the user typing them", () => {
  const profile = normalizeProfile({
    type: "container",
    imageName: "xxdoman/strata-mi50",
    containerName: "strata-mi50",
    GpuModel: "amd-mi50",
  });
  const text = renderComposeFile(containerSpec(profile), { profileName: "mi50" });
  assert.match(text, /- "\/dev\/kfd:\/dev\/kfd"/);
  assert.match(text, /- "\/dev\/dri:\/dev\/dri"/);
  assert.match(text, /- "c 226:\* rmw"/);
  assert.match(text, /- "HSA_OVERRIDE_GFX_VERSION=9\.0\.6"/);
  assert.match(text, /- "LD_LIBRARY_PATH=\/opt\/rocm\/lib"/);
});

test("a specific-card nvidia profile pins device_ids", () => {
  const spec = containerSpec({ containerName: "s", imageName: "img", GpuModel: "nvidia", GpuIds: "0,2" });
  const text = renderComposeFile(spec, {});
  assert.match(text, /device_ids:/);
  assert.match(text, /- "0"/);
  assert.match(text, /- "2"/);
  assert.doesNotMatch(text, /count:/);
  // The legacy docker run path mirrors it.
  const profile = normalizeProfile({
    type: "container",
    imageName: "img",
    containerName: "s",
    GpuModel: "nvidia",
    GpuIds: "0,2",
  });
  const args = buildRunArgs("s", defaultRunParams(profile));
  assert.ok(args.includes("--gpus") && args.includes("device=0,2"));
});

test("a migrated legacy container keeps the old --gpus all behaviour", () => {
  const profile = normalizeProfile({ type: "container", imageName: "img", containerName: "s", ggufDir: "/m" });
  assert.equal(profile.GpuModel, "nvidia");
  const args = buildRunArgs("s", defaultRunParams(profile));
  assert.ok(args.includes("--gpus") && args.includes("all"));
});

test("a legacy container with an empty dataDir keeps its /data named volume", () => {
  const profile = normalizeProfile({ type: "container", imageName: "img", containerName: "strata", port: 9000 });
  // The old recipe fell back to a `<containerName>-data` named volume.
  assert.deepEqual(profile.VolumeBinds, ["strata-data:/data"]);
  assert.ok(profile.environment.includes("STRATA_DATA=/data"));
  assert.ok(profile.environment.includes("PORT=9000"));
});
