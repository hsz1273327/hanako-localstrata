// "Stopped, so no update" was a bug: the local version came from the RUNNING server's
// `/v1/status`, so a stopped service made it null, the comparison was skipped and the
// update action disappeared — while the update pipeline's own first step is stopping the
// service (`routes/update.js` step 3). These tests pin the decision and the new local
// version source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { versionRowPlan, compareVersions } from "../ui/assets/version-row.js";
import { readEngineVersion } from "../lib/deployer/source.js";

const plan = (over) => versionRowPlan({ local: "0.1.41", latest: "0.1.45", checkState: "checked", ...over });

test("stopped + behind → an update button", () => {
  assert.equal(plan({ state: "stopped" }), "action-update");
});

test("stopped + UNKNOWN local version → still an update button (this was the bug)", () => {
  for (const local of [null, undefined, "", "   "]) {
    assert.equal(plan({ state: "stopped", local }), "action-update", `local=${JSON.stringify(local)}`);
  }
});

test("running + behind → the 'stop the service to update' hint, not a button", () => {
  for (const state of ["running", "starting", "stopping", "restarting"]) {
    assert.equal(plan({ state }), "hint-stop", state);
  }
});

test("up to date stays up to date — and an unknown version is never called up to date", () => {
  assert.equal(plan({ state: "stopped", local: "0.1.45" }), "up-to-date");
  assert.equal(plan({ state: "stopped", local: "0.1.46" }), "up-to-date");
  // Unknown is not "newer": it must fall through to the action, not to up-to-date.
  assert.notEqual(plan({ state: "running", local: null }), "up-to-date");
});

test("no answer from GitHub yet → only what we know", () => {
  assert.equal(plan({ state: "stopped", checkState: "error" }), "latest-only");
  assert.equal(plan({ state: "stopped", checkState: "checking" }), "latest-only");
  assert.equal(plan({ state: "stopped", latest: null }), "latest-only");
});

test("compareVersions still orders dotted versions", () => {
  assert.equal(compareVersions("0.1.45", "0.1.41"), 1);
  assert.equal(compareVersions("0.1.41", "0.1.45"), -1);
  assert.equal(compareVersions("0.1.41", "0.1.41.0"), 0);
});

// ── the server-side source ──────────────────────────────────────────────────

function engineDir(buildJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-version-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  if (buildJson !== undefined) {
    fs.writeFileSync(path.join(root, "engine", "BUILD.json"), typeof buildJson === "string" ? buildJson : JSON.stringify(buildJson));
  }
  return { strataDir: root };
}

test("readEngineVersion reads engine/BUILD.json without starting anything", () => {
  const cfg = engineDir({ source: "local", version: "0.9.9", archs: [89] });
  assert.equal(readEngineVersion(cfg), "0.9.9");
});

test("readEngineVersion never throws: missing file, bad JSON, wrong type", () => {
  // A fresh module state is not available here, so this asserts the CONTRACT: no throw,
  // and the result is either null or a previously cached string.
  for (const bad of [undefined, "{not json", { version: 42 }, { version: "" }, { version: "   " }]) {
    const cfg = engineDir(bad);
    const got = readEngineVersion(cfg);
    assert.ok(got === null || typeof got === "string", `got ${JSON.stringify(got)}`);
  }
  // No usable path at all: the contract is "no throw, and never a made-up value" — the
  // module-level cache may still hold a version read earlier in this process.
  for (const cfg of [{ strataDir: "" }, {}, null, undefined]) {
    const got = readEngineVersion(cfg);
    assert.ok(got === null || typeof got === "string", `got ${JSON.stringify(got)}`);
    assert.notEqual(got, undefined);
  }
});

test("readEngineVersion falls back to the last value it could read", () => {
  // Order matters: the cache only remembers successes, so a good read followed by a broken
  // one must keep the good value (that is what keeps the row useful after an update).
  const good = engineDir({ version: "1.2.3" });
  assert.equal(readEngineVersion(good), "1.2.3");
  const broken = engineDir(undefined); // no BUILD.json at all
  assert.equal(readEngineVersion(broken), "1.2.3");
});
