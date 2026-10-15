// Per-profile API key: source, precedence, masking and the compose link.
//
// Precedence, identical on both sides (the code comment in
// lib/deployer/common.js `applyActiveProfile` is the source of truth):
//
//   profile.apiKey → global defaultApiKey → (local only) the selected
//   config file's `api_key` → ""
//
// The container side injects the content into the env var `ApiKeyEnv` names
// (compose interpolates `${STRATA_API_KEY}` from `.env`, so the shareable file
// never holds it). The local side does not inject anything: the App itself sends
// it as `Authorization: Bearer` on calls to the local HTTP API.
//
// The hard line: a profile's key must never leave the backend in the clear. The
// host masks only TOP-LEVEL schema fields and `profiles` is a nested array, so
// the masking is done at this App's own boundary (verified against the host's
// own validator — see the notes: it accepts the nested key and does NOT mask it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerSettingsRoutes from "../routes/settings.js";
import { readAllConfig, writeProfiles, normalizeProfile, findProfile, resolveApiKey, readApiKey, effectiveConfigFile, redactSecretsForModel } from "../lib/strata.js";
import { containerSpec, renderComposeFile, writeEnvFile, envFilePath, composeFilePath } from "../lib/compose.js";
import { defaultRunParams } from "../lib/deployer/docker.js";

const API_KEY_MASK = "********";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-apikey-"));
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
    network: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
    log: { info() {}, warn() {}, error() {} },
  };
}

function routesFor(ctx) {
  const handlers = {};
  const app = { get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } };
  registerSettingsRoutes(app, ctx);
  return async (p, body) => {
    const res = await handlers[p]({ req: { json: async () => body }, json: (data) => ({ data }) });
    return res.data;
  };
}

const containerProfile = (over = {}) =>
  normalizeProfile({
    id: "p1",
    name: "box",
    type: "container",
    imageName: "strata",
    imageTag: "latest",
    containerName: "strata",
    GpuModel: "nvidia",
    ApiKeyEnv: "STRATA_KEY",
    ...over,
  });

const localProfile = (over = {}) =>
  normalizeProfile({ id: "p2", name: "src", type: "local", strataDir: "/srv/Strata", ...over });

// ── precedence ────────────────────────────────────────────────────────────

test("the profile's own key wins; the global key is the fallback", async () => {
  // profile key present → it wins.
  let ctx = makeCtx({ defaultApiKey: "GLOBAL", profiles: [containerProfile({ apiKey: "PROFILE" })], activeProfileId: "p1" });
  let cfg = await readAllConfig(ctx);
  assert.equal(cfg.apiKey, "PROFILE");
  assert.equal(resolveApiKey(cfg), "PROFILE");

  // no profile key → the global default.
  ctx = makeCtx({ defaultApiKey: "GLOBAL", profiles: [containerProfile()], activeProfileId: "p1" });
  cfg = await readAllConfig(ctx);
  assert.equal(cfg.apiKey, "GLOBAL");
  assert.equal(resolveApiKey(cfg), "GLOBAL");

  // neither → nothing (a container profile has no config file to fall back to).
  ctx = makeCtx({ profiles: [containerProfile()], activeProfileId: "p1" });
  cfg = await readAllConfig(ctx);
  assert.equal(cfg.apiKey, "");
  assert.equal(resolveApiKey(cfg), "");
});

test("local: the config file's api_key is the last resort, below the global key", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "strata-a.json"), JSON.stringify({ port: 8080, api_key: "FILEKEY" }));
  const base = { strataDir: dir, configFile: "strata-a.json" };

  // neither a profile key nor a global one → the file setup already wrote.
  let ctx = makeCtx({ ...base, profiles: [localProfile({ strataDir: dir })], activeProfileId: "p2" });
  let cfg = await readAllConfig(ctx);
  assert.equal(cfg.apiKey, "", "nothing explicit is set");
  assert.equal(resolveApiKey(cfg), "FILEKEY", "the config file supplies the key");

  // a global fallback beats the file.
  ctx = makeCtx({ ...base, defaultApiKey: "GLOBAL", profiles: [localProfile({ strataDir: dir })], activeProfileId: "p2" });
  cfg = await readAllConfig(ctx);
  assert.equal(resolveApiKey(cfg), "GLOBAL");

  // a profile override beats them both.
  ctx = makeCtx({ ...base, defaultApiKey: "GLOBAL", profiles: [localProfile({ strataDir: dir, apiKey: "PROFILE" })], activeProfileId: "p2" });
  cfg = await readAllConfig(ctx);
  assert.equal(resolveApiKey(cfg), "PROFILE");
});

// ── the migration (apiKey → defaultApiKey) ────────────────────────────────

test("the legacy global apiKey moves to defaultApiKey once, without losing the value", async () => {
  const ctx = makeCtx({ apiKey: "LEGACY-KEY" });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.defaultApiKey, "LEGACY-KEY", "the value is preserved under the new name");
  assert.equal(cfg.apiKey, "LEGACY-KEY", "and is the effective key");
  assert.equal(ctx._store.defaultApiKey, "LEGACY-KEY");
  assert.equal(ctx._store.apiKey, "", "the legacy slot is cleared, so no plaintext copy is left");

  // One-shot: a later read writes nothing.
  const snapshot = JSON.stringify(ctx._store);
  await readAllConfig(ctx);
  assert.equal(JSON.stringify(ctx._store), snapshot, "the migration does not fire twice");
});

// ── the masking boundary ──────────────────────────────────────────────────

test("GET /profiles masks every profile key; the real one never reaches the page", async () => {
  const ctx = makeCtx({});
  await writeProfiles(ctx, [containerProfile({ apiKey: "SEKRIT-VALUE" }), localProfile({ apiKey: "LOCAL-SEKRIT" })], "p1");
  const call = routesFor(ctx);

  const got = await call("/profiles");
  assert.equal(got.profiles.find((p) => p.id === "p1").apiKey, API_KEY_MASK);
  assert.equal(got.profiles.find((p) => p.id === "p2").apiKey, API_KEY_MASK);
  assert.doesNotMatch(JSON.stringify(got), /SEKRIT/, "no plaintext key anywhere in the payload");
});

test("saving with the mask keeps the stored key; empty clears; a real value replaces", async () => {
  const ctx = makeCtx({});
  await writeProfiles(ctx, [containerProfile({ apiKey: "ORIGINAL" })], "p1");
  const call = routesFor(ctx);
  const base = { id: "p1", name: "box", type: "container", imageName: "strata", imageTag: "latest", containerName: "strata", GpuModel: "nvidia", ApiKeyEnv: "STRATA_KEY" };

  // The mask means "untouched".
  const kept = await call("/profiles/save", { ...base, apiKey: API_KEY_MASK });
  assert.equal(findProfile((await readAllConfig(ctx)).profiles, "p1").apiKey, "ORIGINAL");
  assert.equal(kept.profile.apiKey, API_KEY_MASK);
  assert.equal(kept.profiles.find((p) => p.id === "p1").apiKey, API_KEY_MASK);
  // The PROFILE surfaces never echo the value (the status block is a separate,
  // deliberate surface — see the last test in this file).
  assert.doesNotMatch(JSON.stringify(kept.profile) + JSON.stringify(kept.profiles), /ORIGINAL/);

  // A real value replaces it — and still does not come back in the profile view.
  const replaced = await call("/profiles/save", { ...base, apiKey: "REPLACEMENT" });
  assert.equal(findProfile((await readAllConfig(ctx)).profiles, "p1").apiKey, "REPLACEMENT");
  assert.equal(replaced.profile.apiKey, API_KEY_MASK);
  assert.doesNotMatch(JSON.stringify(replaced.profile) + JSON.stringify(replaced.profiles), /REPLACEMENT/);

  // Empty is an explicit clear.
  const cleared = await call("/profiles/save", { ...base, apiKey: "" });
  assert.equal(findProfile((await readAllConfig(ctx)).profiles, "p1").apiKey, "");
  assert.equal(cleared.profile.apiKey, "");
});

test("a masked key on a NEW profile stores nothing", async () => {
  const ctx = makeCtx({});
  const call = routesFor(ctx);
  await call("/profiles/save", { name: "fresh", type: "container", imageName: "strata", imageTag: "latest", containerName: "freshbox", GpuModel: "nvidia", apiKey: API_KEY_MASK });
  const stored = (await readAllConfig(ctx)).profiles.find((p) => p.name === "fresh");
  assert.equal(stored.apiKey, "", "there is no previous key to keep");
});

// ── the compose link (zero regression) ────────────────────────────────────

test("the effective key reaches .env / docker run, never the shareable compose file", async () => {
  const dir = tmpDir();
  const profile = containerProfile({ apiKey: "PROFILE-KEY", DeployDir: dir });
  const ctx = makeCtx({ defaultApiKey: "GLOBAL", profiles: [profile], activeProfileId: "p1" });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.apiKey, "PROFILE-KEY");

  // The compose file interpolates the `.env` variable and carries no value.
  const spec = containerSpec(profile);
  const yml = renderComposeFile(spec, { profileName: "box" });
  assert.match(yml, /\$\{STRATA_API_KEY\}/);
  assert.doesNotMatch(yml, /PROFILE-KEY/);

  // The real value is materialized next to it, in `.env`.
  writeEnvFile(profile, cfg.apiKey, { spec });
  const env = fs.readFileSync(envFilePath(dir), "utf8");
  assert.match(env, /^STRATA_API_KEY=PROFILE-KEY$/m);
  assert.equal(composeFilePath(dir), path.join(dir, "docker-compose.yml"));

  // The legacy `docker run` path gets the same effective key.
  const params = defaultRunParams(profile, { apiKey: cfg.apiKey });
  assert.ok(params.env.includes("STRATA_KEY=PROFILE-KEY"), `expected the injected env, got ${JSON.stringify(params.env)}`);
});

// The local side has the same override field as the container side; saving it
// through the route must persist, mask, and drive the effective key.
test("a local profile's override saves, masks and drives the effective key", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "strata-a.json"), JSON.stringify({ port: 8080, api_key: "FILEKEY" }));
  const ctx = makeCtx({ strataDir: dir, configFile: "strata-a.json", profiles: [localProfile({ strataDir: dir })], activeProfileId: "p2" });
  const call = routesFor(ctx);

  // With no override the config file supplies the key.
  assert.equal(resolveApiKey(await readAllConfig(ctx)), "FILEKEY");

  // The local form now saves an override like the container one.
  const saved = await call("/profiles/save", { id: "p2", name: "src", type: "local", strataDir: dir, apiKey: "LOCAL-OVERRIDE" });
  assert.equal(findProfile((await readAllConfig(ctx)).profiles, "p2").apiKey, "LOCAL-OVERRIDE");
  assert.equal(saved.profile.apiKey, API_KEY_MASK, "masked on the way back");
  assert.equal(resolveApiKey(await readAllConfig(ctx)), "LOCAL-OVERRIDE", "the override beats the config file");

  // The mask keeps it; empty clears it and the config file takes over again.
  await call("/profiles/save", { id: "p2", name: "src", type: "local", strataDir: dir, apiKey: API_KEY_MASK });
  assert.equal(resolveApiKey(await readAllConfig(ctx)), "LOCAL-OVERRIDE");
  await call("/profiles/save", { id: "p2", name: "src", type: "local", strataDir: dir, apiKey: "" });
  assert.equal(findProfile((await readAllConfig(ctx)).profiles, "p2").apiKey, "");
  assert.equal(resolveApiKey(await readAllConfig(ctx)), "FILEKEY", "back to the config file");
});

// ── the local key-source gap fix ──────────────────────────────────────────

test("readApiKey resolves the newest config when no file is explicitly selected", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "strata-old.json"), JSON.stringify({ api_key: "OLD" }));
  fs.writeFileSync(path.join(dir, "strata-new.json"), JSON.stringify({ api_key: "NEW" }));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "strata-old.json"), past, past);

  const cfg = { strataDir: dir, configFile: "" };
  assert.equal(effectiveConfigFile(cfg), "strata-new.json", "the newest existing config wins (the deployer's own rule)");
  assert.equal(readApiKey(cfg), "NEW", "previously this read the directory and lost the key");
  assert.equal(resolveApiKey(cfg), "NEW");

  // An explicit selection still wins over the newest.
  assert.equal(effectiveConfigFile({ ...cfg, configFile: "strata-old.json" }), "strata-old.json");
  assert.equal(readApiKey({ ...cfg, configFile: "strata-old.json" }), "OLD");

  // No config at all → no key, no crash.
  assert.equal(concatKeys(tmpDir()), "");
});

function concatKeys(dir) {
  const cfg = { strataDir: dir, configFile: "" };
  return `${readApiKey(cfg)}${resolveApiKey(cfg)}`;
}

test("GET /profiles names the local key source (file + whether it has a key)", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "strata-a.json"), JSON.stringify({ port: 8080, api_key: "FILEKEY" }));

  // local + a key in the config file
  let ctx = makeCtx({ strataDir: dir, configFile: "strata-a.json", profiles: [localProfile({ strataDir: dir })], activeProfileId: "p2" });
  let got = await routesFor(ctx)("/profiles");
  assert.deepEqual(got.keySource, { file: "strata-a.json", hasKey: true });

  // local without a key in the file
  const dir2 = tmpDir();
  fs.writeFileSync(path.join(dir2, "strata-b.json"), JSON.stringify({ port: 8080 }));
  ctx = makeCtx({ strataDir: dir2, configFile: "strata-b.json", profiles: [localProfile({ strataDir: dir2 })], activeProfileId: "p2" });
  got = await routesFor(ctx)("/profiles");
  assert.deepEqual(got.keySource, { file: "strata-b.json", hasKey: false });

  // a container profile has no config file to read
  ctx = makeCtx({ profiles: [containerProfile()], activeProfileId: "p1" });
  got = await routesFor(ctx)("/profiles");
  assert.deepEqual(got.keySource, { file: "", hasKey: false });
});

// ── the status surface (deliberate, pre-existing) ─────────────────────────

// `status.network.apiKey` carries the EFFECTIVE key on purpose: the panel shows
// a masked value with a copy action so the key can be pasted into another client.
// That predates per-profile keys and is unchanged by them — the only difference
// is that the effective key can now come from a profile override (or, for local,
// from the config file). Pinned so nobody "hardens" it by accident and silently
// kills the copy button.
test("the status payload keeps exposing the effective key for the panel's copy action", async () => {
  const ctx = makeCtx({ defaultApiKey: "GLOBAL-KEY", profiles: [containerProfile()], activeProfileId: "p1" });
  const cfg = await readAllConfig(ctx);
  // The effective key is what every consumer (the panel's network block
  // included) sees — same value, one source.
  assert.equal(cfg.apiKey, "GLOBAL-KEY");
  assert.equal(resolveApiKey(cfg), "GLOBAL-KEY");
});

// ── the model-facing surface (tools) ──────────────────────────────────────

// The status object carries secrets by construction — `network.apiKey` (kept for
// the panel's copy action) and `docker.env` (the running container's whole
// environment). A tool payload lands in the model's context, which may be logged
// or shared, so both are stripped there.
test("a model-facing payload carries no key and no container environment", () => {
  const status = {
    state: "running",
    port: 8080,
    network: { listenAddr: "0.0.0.0", hasApiKey: true, apiKey: "THE-KEY" },
    settings: { containerName: "strata", port: 8080 },
    docker: { name: "strata", state: "running", env: { API_KEY: "THE-KEY", PORT: "8080" } },
    metrics: { tg: 12 },
  };
  const safe = redactSecretsForModel(status);
  assert.equal(JSON.stringify(safe).includes("THE-KEY"), false, "no plaintext key anywhere");
  assert.equal(safe.network.apiKey, undefined);
  assert.equal(safe.network.hasApiKey, true, "the boolean stays, so the model can still report it");
  assert.equal(safe.docker.env, undefined);
  assert.equal(safe.docker.name, "strata");
  assert.equal(safe.metrics.tg, 12, "everything else is untouched");
  assert.equal(status.network.apiKey, "THE-KEY", "the input object is not mutated");
  assert.equal(redactSecretsForModel("x"), "x");
  assert.equal(redactSecretsForModel(null), null);
});

test("both tools redact their payloads before handing them to the model", () => {
  const status = read("tools/strata_status.js");
  const control = read("tools/strata_control.js");
  assert.match(status, /redactSecretsForModel\(status\)/);
  assert.match(control, /redactSecretsForModel\(result\)/);
  assert.doesNotMatch(status, /JSON\.stringify\(status, null, 2\)/);
  assert.doesNotMatch(control, /JSON\.stringify\(result, null, 2\)/);
});
