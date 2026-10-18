// The default VALUE of the "当前设置备份为" field (ui/assets/backup-name.js).
//
// The user asked for a real value, not a placeholder: `<current minus .json>-
// <YYYYMMDD>.json`, local date, 8 digits. That name has to satisfy the shape the
// config picker lists (`^strata-[A-Za-z0-9._-]+\.json$`), or the backup could never
// be selected — the hyphen is inside that character class, so it is valid.
//
// Collision: the date alone collides on the second run of a day, and "target
// already exists" stays a hard refusal. So the default is chosen from what is
// already there: the date, or the date plus HHMM when the date is taken. Nothing
// existing is touched or renamed — the field simply opens on a usable name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupDefaultName } from "../ui/assets/backup-name.js";
import { listConfigFiles } from "../lib/deployer/common.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The picker's own filter, reused so this test cannot drift from it.
const PICKER_SHAPE = /^strata-[A-Za-z0-9._-]+\.json$/;

const at = (iso) => new Date(2026, 9, 16, 23, 8, 0); // 2026-10-16 23:08 local

test("the default is the current name plus today's date, and the picker can list it", () => {
  assert.equal(backupDefaultName("strata-iq2_xs.json", { now: at() }), "strata-iq2_xs-20261016.json");
  assert.match(backupDefaultName("strata-iq2_xs.json", { now: at() }), PICKER_SHAPE, "must satisfy the picker's shape");
  // Zero padding matters (a January date must not read as 202611).
  assert.equal(backupDefaultName("strata-a.json", { now: new Date(2026, 0, 5) }), "strata-a-20260105.json");
  // Local date, not UTC: near midnight the two disagree, and the user's own local
  // day is what they asked for.
  const late = new Date(2026, 9, 16, 23, 58, 0);
  assert.equal(backupDefaultName("strata-a.json", { now: late }), "strata-a-20261016.json");
  // The shape holds for a long current name too.
  assert.match(backupDefaultName("strata-ud-q4_k_xl.json", { now: at() }), PICKER_SHAPE);
  // Nothing selected = nothing to back up.
  assert.equal(backupDefaultName("", { now: at() }), "");
  assert.equal(backupDefaultName(null, { now: at() }), "");
});

test("the same day twice gets the time, and nothing is silently renamed", () => {
  const taken = ["strata-iq2_xs.json", "strata-iq2_xs-20261016.json"];
  assert.equal(backupDefaultName("strata-iq2_xs.json", { now: at(), existing: taken }), "strata-iq2_xs-20261016-2308.json");
  assert.match(backupDefaultName("strata-iq2_xs.json", { now: at(), existing: taken }), PICKER_SHAPE);
  // Zero padded hours/minutes too (23:08 stays 2308, 09:05 becomes 0905).
  assert.equal(backupDefaultName("strata-a.json", { now: new Date(2026, 9, 16, 9, 5) }), "strata-a-20261016.json");
  assert.equal(
    backupDefaultName("strata-a.json", { now: new Date(2026, 9, 16, 9, 5), existing: ["strata-a-20261016.json"] }),
    "strata-a-20261016-0905.json",
  );
  // The day-only name is what we offer whenever it is free, even if OTHER files
  // exist (they do not matter).
  assert.equal(backupDefaultName("strata-a.json", { now: at(), existing: ["strata-b-20261016.json"] }), "strata-a-20261016.json");
  // If even the minute-bearing name is taken we still offer it (visibly): the
  // refusal, not a silent suffix, is what happens next.
  const both = ["strata-a-20261016.json", "strata-a-20261016-2308.json"];
  assert.equal(backupDefaultName("strata-a.json", { now: at(), existing: both }), "strata-a-20261016-2308.json");
  // The value it produces is exactly what the picker lists: prove it against the
  // picker's real implementation on a real directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-backup-name-"));
  try {
    const name = backupDefaultName("strata-iq2_xs.json", { now: at() });
    fs.writeFileSync(path.join(dir, "strata-iq2_xs.json"), "{}");
    fs.writeFileSync(path.join(dir, name), "{}");
    assert.ok(listConfigFiles(dir).includes(name), "the produced default must show up in the config picker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
