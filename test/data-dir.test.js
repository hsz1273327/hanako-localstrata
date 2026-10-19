// The data directory is a PROFILE property (1.1.1 follow-up).
//
// Why this file exists: setup.py keeps ONE `data_dir` in
// ~/.config/strata/settings.json and reuses it, so two deployments on one
// machine shared a single memory and whichever ran setup last owned it. The App
// never passed `--data-dir` at all, so a run for the second deployment still
// wrote its packs and MTP files into the first one's folder. The field now lives
// on the local profile, is required, has no default, and is passed on EVERY
// setup run.
//
// What is pinned here:
//   * a local profile without it is reported missing (and refused on save);
//   * a container profile is untouched by the field;
//   * the plan takes the value from the ACTIVE PROFILE, not from a top-level
//     setting and not from a per-run setup parameter;
//   * every run passes `--data-dir`, and an empty value is an error rather than
//     `--data-dir ""`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeProfile,
  missingProfileFields,
  validateProfile,
  ensureProfiles,
} from "../lib/profiles.js";
import { initialSetupPlan, setupArgs, validateSetupParams, SETUP_PARAMS } from "../lib/firstrun.js";
import { readAllConfig } from "../lib/strata.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const LOCAL_STATUS = { state: "no-config", launch: { method: "local" } };

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(key) {
        return store[key];
      },
      async set(key, value) {
        store[key] = value;
      },
      async setMany(patch) {
        Object.assign(store, patch);
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

// ── the model ─────────────────────────────────────────────────────────────

test("a local profile without a data directory is reported missing", () => {
  const bare = normalizeProfile({ type: "local", strataDir: "/srv/Strata" });
  assert.equal(bare.dataDir, "");
  assert.deepEqual(missingProfileFields(bare), ["dataDir"]);

  const filled = normalizeProfile({ id: "p", name: "default", type: "local", strataDir: "/srv/Strata", dataDir: "/srv/Strata-data" });
  assert.deepEqual(missingProfileFields(filled), []);
  assert.equal(filled.dataDir, "/srv/Strata-data");

  // Required on SAVE too, not only at start time (the panel blocks it first; the
  // backend is the rule).
  assert.deepEqual(validateProfile(filled, { profiles: [], isNew: true }).errors, []);
  const missing = validateProfile({ type: "local", name: "x", strataDir: "/srv/Strata" }, { profiles: [], isNew: true });
  assert.ok(missing.errors.includes("dataDirRequired"), "a local profile without a data directory must not save");
  assert.equal(missing.profile.dataDir, "");
});

test("a container profile is unaffected: it expresses the same place as a bind + STRATA_DATA", () => {
  const container = normalizeProfile({
    id: "c1",
    name: "dockertest",
    type: "container",
    image: "strata:latest",
    containerName: "strata",
    GpuModel: "nvidia",
    VolumeBinds: ["/srv/strata-config:/data"],
    environment: ["STRATA_DATA=/data"],
  });
  // No local field, no readiness entry, no save-time error.
  assert.equal(container.dataDir, undefined);
  assert.deepEqual(missingProfileFields(container), []);
  assert.deepEqual(validateProfile(container, { profiles: [], isNew: true }).errors, []);
});

test("a profile saved before the field existed stays empty — never a guessed path", () => {
  // The stored form of both real local profiles (1.1.0): no dataDir at all.
  const stored = JSON.stringify([
    { id: "default", name: "default", type: "local", strataDir: "/srv/Strata", pythonPath: "/usr/bin/python3" },
  ]);
  const [profile] = ensureProfiles(stored);
  assert.equal(profile.dataDir, "", "no inference, no default: the panel must ask");
  assert.deepEqual(missingProfileFields(profile), ["dataDir"]);

  // A legacy container `dataDir` is still read as the OLD /data mount migration
  // input — the local field did not hijack the container branch.
  const migrated = normalizeProfile({
    id: "c2",
    name: "legacy",
    type: "container",
    image: "strata",
    containerName: "strata",
    dataDir: "/srv/strata-config",
  });
  assert.equal(migrated.dataDir, undefined);
  assert.deepEqual(migrated.VolumeBinds, ["/srv/strata-config:/data"]);
});

test("readAllConfig carries the profile's data directory on the active profile", async () => {
  const ctx = makeCtx({
    profiles: [
      { id: "p1", name: "default", type: "local", strataDir: "/srv/Strata", dataDir: "/srv/Strata-data" },
      { id: "p2", name: "other", type: "local", strataDir: "/srv/Strata2", dataDir: "/srv/Strata2-data" },
    ],
    activeProfileId: "p2",
  });
  const cfg = await readAllConfig(ctx);
  assert.equal(cfg.activeProfile.dataDir, "/srv/Strata2-data");
  // ...and NOT as a flat key: a top-level value would be a cross-profile
  // fallback, which is the bug this field replaced.
  assert.equal(cfg.dataDir, undefined);
});

// ── the setup run ─────────────────────────────────────────────────────────

test("the plan takes dataDir from the active profile, never from a top-level setting", () => {
  const fromProfile = initialSetupPlan(LOCAL_STATUS, {
    // A top-level value is not a source. There is no such key any more; this
    // pins that a stray one cannot be picked up.
    dataDir: "/srv/somewhere-else",
    activeProfile: { type: "local", strataDir: "/srv/Strata", dataDir: "/srv/Strata-data" },
  });
  assert.equal(fromProfile.dataDir, "/srv/Strata-data");

  // No active profile, no value — an empty one is the honest answer.
  assert.equal(initialSetupPlan(LOCAL_STATUS, { dataDir: "/srv/somewhere-else" }).dataDir, "");

  // A per-run setup parameter may not set it either: it is profile-owned.
  const refused = validateSetupParams({ dataDir: "/srv/somewhere-else" });
  assert.deepEqual(refused.clean, {});
  assert.match(refused.errors.join(), /dataDir/);
});

test("every setup run passes --data-dir, and it is the profile's value", () => {
  const plan = initialSetupPlan(LOCAL_STATUS, {
    activeProfile: { type: "local", dataDir: "/srv/Strata-data" },
  });
  const args = setupArgs(plan, "/srv/Strata/setup.py");
  const at = args.indexOf("--data-dir");
  assert.ok(at > 0, "--data-dir is always passed");
  assert.equal(args[at + 1], "/srv/Strata-data");
  assert.equal(args[0], "/srv/Strata/setup.py");
  assert.ok(args.includes("--setup") && args.includes("--yes") && args.includes("--no-start"));

  // Even a run that asks for parameters keeps it, exactly once, with the same
  // value (nothing can be appended after it to override it).
  const withParams = initialSetupPlan(LOCAL_STATUS, { activeProfile: { type: "local", dataDir: "/srv/Strata-data" } }, {
    setup: { vision: "gpu", context: "131072" },
  });
  const paramArgs = setupArgs(withParams, "/srv/Strata/setup.py");
  assert.equal(paramArgs.filter((a) => a === "--data-dir").length, 1);
  assert.equal(paramArgs[paramArgs.length - 1], "/srv/Strata-data", "--data-dir is last and wins");

  // The flag spelling lives in the one table.
  assert.equal(SETUP_PARAMS.dataDir.flag, "--data-dir");
});

test("an empty data directory is an error, never --data-dir ''", () => {
  for (const plan of [{ dataDir: "" }, { dataDir: "   " }, {}, null]) {
    assert.throws(() => setupArgs(plan, "/srv/Strata/setup.py"), /dataDir/, `${JSON.stringify(plan)} must be refused`);
  }
  // Nothing that reaches setup.py carries an empty value after --data-dir.
  const args = setupArgs({ dataDir: "/srv/Strata-data" }, "/srv/Strata/setup.py");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--data-dir") assert.notEqual(String(args[i + 1]).trim(), "");
  }
});

// ── the surfaces ──────────────────────────────────────────────────────────

test("both profile forms carry the field, required, and the setup dialog does not", () => {
  const settings = read("ui/settings.html");
  assert.match(settings, /id="pf-data-dir"[^>]*required/, "the settings form needs the field, marked required");
  assert.match(settings, /id="pf-data-dir-pick"/, "the settings form needs a folder picker");
  assert.match(settings, /data-i18n="field\.localDataDir"/);
  assert.match(settings, /data-i18n="field\.localDataDirHint"/);

  const panel = read("ui/panel.html");
  assert.match(panel, /id="ps-data-dir"[^>]*required/);
  assert.match(panel, /data-i18n="field\.localDataDirHint"/);

  // The "Run setup…" dialog is about a RUN, so this environment property is not
  // in it: it would read as a temporary override of something permanent.
  const dialog = panel.slice(panel.indexOf('id="setupParams"'), panel.indexOf("confirm-popover-actions"));
  assert.ok(dialog.length > 0, "the setup dialog block must be findable");
  assert.doesNotMatch(dialog, /dataDir|data-dir/);

  // Both pages submit it on the local branch.
  assert.match(read("ui/assets/settings.js"), /body\.dataDir = dataDir/);
  assert.match(read("ui/assets/panel.js"), /body\.dataDir = pluginFormEls\.dataDir\.value\.trim\(\)/);
});

test("the copy exists in all six locales", () => {
  for (const lang of LANGS) {
    for (const key of ["field.localDataDir", "field.localDataDirHint", "profile.errDataDirRequired", "label.dataDirSource"]) {
      const value = STRINGS[lang][key];
      assert.equal(typeof value, "string", `${lang} is missing ${key}`);
      assert.ok(value.trim(), `${lang}.${key} is empty`);
    }
    // The retired flat key must stay retired: this is a LOCAL profile field, and
    // the container side expresses the same place with a bind mount.
    assert.equal(STRINGS[lang]["field.dataDir"], undefined, `${lang} resurrected the orphan field.dataDir`);
  }
});
