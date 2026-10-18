// The tuning knobs (B1 of the field audit): `--vram-reserve-mib`, `--prefill`,
// `--pool-workers`, `--spec-min-p`, `--suffix-draft`,
// `--conversation-cache-slots`, and the bare flag `--vram-elastic`.
//
// All seven are ENGINE args (the server hands `args` to the engine; it consumes
// none of them itself), so a restart applies them and setup is not involved. What
// each one is for, with the defaults the hints have to show:
//
//   --vram-reserve-mib          engine default 700; deducted before the expert
//                               cache is sized (docs/DETAILS.md:600-631: at 0 MiB
//                               free the same box measured 13.7 instead of 102 tok/s)
//   --prefill                   auto (up to 8192); a bigger chunk borrows slots
//   --pool-workers              0 = one per physical core
//   --spec-min-p                setup writes 0.5; --calibrate measures it
//   --suffix-draft              3; 0 = MTP only
//   --conversation-cache-slots  4
//   --vram-elastic              off; a FLAG with no value
//
// The last one is why the writer grew a bare-flag form: it inserts the flag and
// nothing after it. Removing a flag again is still not supported (an absent flag
// IS off), which is recorded as technical debt in
// docs/dev/v1.1-layering-notes.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEdits, renderConfigEdits, flatConfig, applyTextEdit, EDIT_KEYS } from "../lib/deployer/common.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const configText = (args) => JSON.stringify({ exe: "strata", args, port: 8080 }, null, 2);

const NEW_KEYS = ["vramReserve", "prefill", "poolWorkers", "specMinP", "suffixDraft", "conversationSlots", "vramElastic"];

// The args a deployed install carries, in the same SHAPE as setup.py writes them (the
// roots are neutral on purpose: a fixture must not mirror one machine's layout). Used to
// prove our reading and writing are a fixed point on a realistic config.
const REAL_ARGS = [
  "--pack", "/srv/strata-data/packs/iq3_s",
  "--native", "/srv/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf",
  "--ple-gguf", "/srv/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf",
  "--expert-profile", "/srv/strata/data/expert-profile.bin",
  "--expert-cache", "auto",
  "--prefill", "auto",
  "--spec", "4",
  "--spec-min-p", "0.5",
  "--mtp", "/srv/strata-data/mtp/rt",
  "--conversation-cache-mib", "8192",
  "--conversation-cache-slots", "4",
  "--max-context", "262144",
  "--kv", "int8",
  "--kv-resident", "32768",
  "--vision",
  "--vram-reserve-mib", "700",
];

// ── ① defaults are read out of the config ─────────────────────────────────

test("each knob is read out of the config's args", () => {
  const main = { args: ["--vram-reserve-mib", "1200", "--prefill", "8192", "--pool-workers", "4", "--spec-min-p", "0.6", "--suffix-draft", "0", "--conversation-cache-slots", "8", "--vram-elastic"] };
  const flat = flatConfig(main, {});
  assert.equal(flat.vramReserve, 1200);
  assert.equal(flat.prefill, "8192");
  assert.equal(flat.poolWorkers, 4);
  assert.equal(flat.specMinP, 0.6);
  assert.equal(flat.suffixDraft, 0);
  assert.equal(flat.conversationSlots, 8);
  assert.equal(flat.vramElastic, "on", "the flag's presence is the value");
});

test("an absent knob reads back empty (that is the engine's default)", () => {
  const flat = flatConfig({ args: ["--pack", "/p"] }, {});
  for (const key of NEW_KEYS.filter((k) => k !== "vramElastic")) assert.equal(flat[key], undefined, `${key} must be absent`);
  // The bare flag has its own absent state: "off", not undefined.
  assert.equal(flatConfig({ args: [] }, {}).vramElastic, "");
  assert.equal(flat.vramElastic, "");
});

test("the real config's own values read back as they are", () => {
  const flat = flatConfig({ args: REAL_ARGS }, {});
  assert.equal(flat.vramReserve, 700);
  assert.equal(flat.prefill, "auto");
  assert.equal(flat.specMinP, 0.5);
  assert.equal(flat.conversationSlots, 4);
  assert.equal(flat.vramElastic, "", "this install does not set it");
  assert.equal(flat.poolWorkers, undefined);
  assert.equal(flat.suffixDraft, undefined);
});

// ── ② validation: the ranges the hints promise ────────────────────────────

test("every knob validates its range", () => {
  const ok = validateEdits({ vramReserve: 0, prefill: "auto", poolWorkers: 0, specMinP: 1, suffixDraft: 8, conversationSlots: 16, vramElastic: "on" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean.vramElastic, "on");
  assert.deepEqual(validateEdits({ prefill: "auto:16384" }).errors, []);
  assert.deepEqual(validateEdits({ prefill: "4096" }).errors, []);

  for (const [edits, hint] of [
    [{ vramReserve: 8193 }, /显存保留/],
    [{ vramReserve: -1 }, /显存保留/],
    [{ poolWorkers: 257 }, /CPU 专家线程/],
    [{ specMinP: 1.1 }, /草稿确信度/],
    [{ suffixDraft: 9 }, /SUFFIX/],
    [{ conversationSlots: 0 }, /停放槽位/],
    [{ conversationSlots: 17 }, /停放槽位/],
    [{ prefill: "auto:0" }, /prompt 分块/],
    [{ prefill: "0" }, /prompt 分块/],
    [{ prefill: "big" }, /prompt 分块/],
    [{ vramElastic: "off" }, /显存弹性/],
    [{ vramElastic: "1" }, /显存弹性/],
  ]) {
    assert.match(validateEdits(edits).errors.join(), hint, `${JSON.stringify(edits)} must be refused`);
  }
});

test("the save path validates before it writes (the 400 comes from here)", () => {
  // The routes hand the payload to the deployer's writeConfig, which validates with
  // this same function and throws on errors — so a bad value never reaches the
  // file and never starts a job. Checked at the source, plus behaviourally above.
  const source = read("lib/deployer/source.js");
  assert.match(source, /validateEdits\(/);
  assert.match(source, /errors\.length|throw/, "errors must stop the write");
  // And an invalid value cannot be smuggled through renderConfigEdits: it would
  // write whatever it is given, which is why validation has to come first.
  const { clean, errors } = validateEdits({ vramReserve: 99999 });
  assert.equal(errors.length, 1);
  assert.equal("vramReserve" in clean, false, "a refused value never joins the payload");
});

// ── ③ the written form, including the bare flag ───────────────────────────

test("all seven are written into args, and read back out", () => {
  const mainText = configText(["--pack", "/p", "--vram-reserve-mib", "700", "--prefill", "auto"]);
  const result = renderConfigEdits({
    clean: { vramReserve: 1200, prefill: "8192", poolWorkers: 0, specMinP: 0.6, suffixDraft: 0, conversationSlots: 8, vramElastic: "on" },
    before: { vramReserve: 700 },
    mainText,
    sharedText: "{}",
  });
  const args = JSON.parse(result.newMainText).args;
  assert.deepEqual(args.slice(2), [
    "--vram-reserve-mib", "1200",
    "--prefill", "8192",
    "--pool-workers", "0",
    "--spec-min-p", "0.6",
    "--suffix-draft", "0",
    "--conversation-cache-slots", "8",
    "--vram-elastic",
  ]);
  assert.equal(result.restartRequired, true, "they are engine args: a restart applies them");
  // Round trip: what we wrote is what we read.
  const flat = flatConfig(JSON.parse(result.newMainText), {});
  assert.equal(flat.vramReserve, 1200);
  assert.equal(flat.prefill, "8192");
  assert.equal(flat.poolWorkers, 0);
  assert.equal(flat.specMinP, 0.6);
  assert.equal(flat.suffixDraft, 0);
  assert.equal(flat.conversationSlots, 8);
  assert.equal(flat.vramElastic, "on");
});

test("--vram-elastic is a bare flag: written once, never with a value", () => {
  const text = configText(["--pack", "/p"]);
  const once = applyTextEdit(text, { type: "arg-add", key: "--vram-elastic", value: undefined });
  const args = JSON.parse(once).args;
  assert.deepEqual(args, ["--pack", "/p", "--vram-elastic"], "the flag is appended alone");
  // Setting it again must not append a second copy or invent a value.
  const twice = applyTextEdit(once, { type: "arg-add", key: "--vram-elastic", value: undefined });
  assert.deepEqual(JSON.parse(twice).args, ["--pack", "/p", "--vram-elastic"]);
  // …and an "off" choice is simply not written (removing a flag is not supported yet).
  const result = renderConfigEdits({ clean: {}, before: {}, mainText: text, sharedText: "{}" });
  assert.deepEqual(JSON.parse(result.newMainText).args, ["--pack", "/p"]);
});

test("a knob that is already there is rewritten, not duplicated", () => {
  const mainText = configText(["--vram-reserve-mib", "700", "--pack", "/p"]);
  const next = renderConfigEdits({ clean: { vramReserve: 1000 }, before: { vramReserve: 700 }, mainText, sharedText: "{}" });
  const args = JSON.parse(next.newMainText).args;
  assert.equal(args.filter((a) => a === "--vram-reserve-mib").length, 1);
  assert.equal(args[args.indexOf("--vram-reserve-mib") + 1], "1000");
});

// ── the deployed shape: no drift ──────────────────────────────────────────

test("reading and re-writing the real args is a fixed point", () => {
  // Feed the deployed args through: read every knob, then write those same values
  // back. Nothing may move — no key reordered, no flag duplicated, no value
  // reformatted. This is the closest available evidence to "it works on the real
  // file" without touching the deployment.
  const mainText = configText(REAL_ARGS);
  const flat = flatConfig(JSON.parse(mainText), {});
  const clean = {};
  for (const key of ["vramReserve", "prefill", "specMinP", "conversationSlots"]) clean[key] = flat[key];
  const result = renderConfigEdits({
    clean,
    before: { vramReserve: flat.vramReserve, prefill: flat.prefill, specMinP: flat.specMinP, conversationSlots: flat.conversationSlots },
    mainText,
    sharedText: "{}",
  });
  assert.deepEqual(result.diff, [], "the same values are not a change");
  assert.deepEqual(JSON.parse(result.newMainText).args, REAL_ARGS, "the args must be untouched");
});

// ── ④ the default-value lines, and the panel fields ───────────────────────

test("every knob is on the form with its engine default visible", () => {
  const html = read("ui/panel.html");
  const groupOf = (key) => {
    const form = html.match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
    const fieldsets = form.split("<fieldset class=\"group\">");
    for (const block of fieldsets) {
      if (block.includes(`data-key="${key}"`)) {
        return (block.match(/data-i18n="(edit\.[a-zA-Z]*Legend)"/) || [])[1] || "?";
      }
    }
    return null;
  };
  // The groups they belong to (no new group was added).
  assert.equal(groupOf("vramReserve"), "edit.expertsLegend");
  assert.equal(groupOf("prefill"), "edit.expertsLegend");
  assert.equal(groupOf("poolWorkers"), "edit.expertsLegend");
  assert.equal(groupOf("vramElastic"), "edit.expertsLegend");
  assert.equal(groupOf("conversationSlots"), "edit.kvLegend");
  assert.equal(groupOf("specMinP"), "edit.draftLegend");
  assert.equal(groupOf("suffixDraft"), "edit.draftLegend");
  // Each carries a default line inside its own field block (the established rule:
  // the system's real default must be visible, and only while the field is empty).
  for (const key of NEW_KEYS) {
    const label = html.match(new RegExp(`<label class="field">(?:(?!</label>)[\\s\\S])*data-key="${key}"(?:(?!</label>)[\\s\\S])*</label>`));
    assert.ok(label, `#${key} must be inside a label.field`);
    assert.match(label[0], new RegExp(`class="field-default" data-i18n="edit\\.${key}Default" hidden`), `${key} needs its default line`);
  }
  // The two-state flag offers "not written" and "on" only.
  const select = html.slice(html.indexOf('id="ed-vramElastic"'), html.indexOf("</select>", html.indexOf('id="ed-vramElastic"')));
  assert.match(select, /value=""/);
  assert.match(select, /value="on"/);
  assert.equal((select.match(/<option/g) || []).length, 2);
  // And the panel labels them in the change list.
  const js = read("ui/assets/panel.js");
  for (const key of NEW_KEYS) assert.match(js, new RegExp(`${key}: "edit\\.`), `panel.js must label ${key}`);
});

test("the copy exists in six locales, with the default named", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  for (const lang of LANGS) {
    for (const key of NEW_KEYS) {
      assert.ok(String(STRINGS[lang][`edit.${key}`] || "").length > 0, `${lang} is missing edit.${key}`);
      assert.ok(String(STRINGS[lang][`edit.${key}Default`] || "").length > 0, `${lang} is missing edit.${key}Default`);
    }
    // The two most consequential hints must carry the real default number.
    assert.match(STRINGS[lang]["edit.vramReserveDefault"], /700/, `${lang}: the 700 default`);
    assert.match(STRINGS[lang]["edit.specMinPDefault"], /0\.5/, `${lang}: setup's 0.5`);
    assert.match(STRINGS[lang]["edit.suffixDraftDefault"], /3/, `${lang}: the suffix default`);
    assert.match(STRINGS[lang]["edit.conversationSlotsDefault"], /4/, `${lang}: the slots default`);
    // The bare-flag select needs its "not written" option label.
    assert.ok(String(STRINGS[lang]["edit.vramElasticUnset"] || "").length > 0, `${lang} is missing edit.vramElasticUnset`);
  }
});

test("no knob is read-only, and none is a setup input", () => {
  for (const key of NEW_KEYS) {
    assert.ok(EDIT_KEYS[key], `${key} must be an edit key`);
    assert.equal(EDIT_KEYS[key].restart, true, `${key} takes effect on the next start`);
  }
  // They are engine args, not setup flags: setup must not be given any of them.
  const firstrun = read("lib/firstrun.js");
  for (const flag of ["--vram-reserve-mib", "--pool-workers", "--suffix-draft", "--vram-elastic", "--conversation-cache-slots"]) {
    assert.doesNotMatch(firstrun, new RegExp(`"${flag}"`), `${flag} must not be passed to setup`);
  }
});
