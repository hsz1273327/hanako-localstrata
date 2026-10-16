// The KV group: what the quantization levels actually are, and why the streaming
// switch is shown rather than offered.
//
// `--kv` has exactly three values in this engine, and all three are reachable from
// our form:
//   1. `setup.py:4584` argparse `choices=["int8", "q4_0", "k8v4"]`
//   2. the engine binary carries `int8`, `q4_0`, `k8v4` (`strings engine/strata`)
//   3. `docs/INSTALL.md:105` `-e KV=int8|q4_0|k8v4`, `docs/MCP_SERVER.md:114`
//   (The `setup.py:3807` line that only accepts int8/q4_0 is
//   `choices_from_config()` — the reader that fills setup's own MENU defaults from
//   an existing config. A `--kv k8v4` config therefore reads back as "unset" there;
//   we read the raw args, so our form is the accurate side.)
//
// The streaming switch is a different kind of thing:
//   * the engine has NO `--kv-streaming` (0 hits in the binary, while `--kv` /
//     `--kv-resident` / `--kv-grow` are there) — it is a setup input only
//     (`docker-entrypoint.sh:75` turns the KV_STREAMING env into it);
//   * streaming lives in the config as the PRESENCE of `--kv-resident`, which
//     setup.py:5382-5411 writes as the literal 32768 on exactly
//     `kv_streaming_wanted(model, ctx, kv, ram)`, and which the launcher's preset
//     diff compares against a preset's "auto" through that same function
//     (setup.py:3318-3325). A re-run rebuilds it; WSL strips it
//     (setup.py:3995-3999).
// So it is reported, and the actionable lever named, rather than boxed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KV_VALUES, EDIT_KEYS, flatConfig, validateEdits, renderConfigEdits, applyTextEdit } from "../lib/deployer/common.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const configText = (args) => JSON.stringify({ exe: "strata", args, port: 8080 }, null, 2);

// ── ① the quantization levels ────────────────────────────────────────────

test("all three KV levels the engine knows are accepted and offered", () => {
  assert.deepEqual(KV_VALUES, ["int8", "q4_0", "k8v4"], "the engine's three, no more, no fewer");
  for (const kv of KV_VALUES) {
    assert.deepEqual(validateEdits({ kv }).errors, [], `${kv} must validate`);
  }
  assert.match(validateEdits({ kv: "q8_0" }).errors.join(), /KV 量化/);
  // The form must offer every one of them (a level the engine has but the form
  // hides is the same gap as a missing value in the list).
  const html = read("ui/panel.html");
  const select = html.slice(html.indexOf('id="ed-kv"'), html.indexOf("</select>", html.indexOf('id="ed-kv"')));
  for (const kv of KV_VALUES) assert.match(select, new RegExp(`value="${kv}"`), `the select must offer ${kv}`);
  const options = [...select.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, KV_VALUES, "and offer nothing else");
});

test("changing the level writes the existing --kv arg", () => {
  const text = configText(["--kv", "int8", "--max-context", "262144"]);
  const result = renderConfigEdits({
    clean: { kv: "k8v4" },
    before: { kv: "int8" },
    mainText: text,
    sharedText: "{}",
  });
  assert.deepEqual(JSON.parse(result.newMainText).args, ["--kv", "k8v4", "--max-context", "262144"]);
  assert.equal(result.restartRequired, true);
});

// ── ② the streaming switch: reported, not editable ───────────────────────

test("kvResident comes back as the config's streaming state", () => {
  const on = flatConfig(JSON.parse(configText(["--kv", "int8", "--kv-resident", "32768"])), {});
  assert.equal(on.kvResident, 32768, "presence is the switch, 32768 is setup's window");
  const off = flatConfig(JSON.parse(configText(["--kv", "int8"])), {});
  assert.equal(off.kvResident, undefined, "absent = not streaming");
});

test("neither the switch nor the window is an edit key", () => {
  // Adding either as a field is the mistake this guards: the engine would not
  // accept `--kv-streaming`, and a hand-set window is rebuilt by the next setup
  // run (setup.py Step 7 writes the literal 32768).
  assert.equal(EDIT_KEYS.kvStreaming, undefined, "the engine has no --kv-streaming");
  assert.equal(EDIT_KEYS.kvResident, undefined, "setup owns the resident window");
  // The shared setup-facts table (表一) reports it instead, from the flat values.
  const facts = read("ui/assets/setup-facts.js");
  assert.match(facts, /export function kvStreamingText\(values\)/, "the table maps the state");
  assert.match(facts, /edit\.kvStreamOn/, "with copy for the on state");
  assert.match(facts, /edit\.kvStreamOff/, "and for the off state");
  // No form field was created for either of them.
  const html = read("ui/panel.html");
  assert.doesNotMatch(html, /data-key="kvResident"/, "no window field");
  assert.doesNotMatch(html, /data-key="kvStreaming"/, "no streaming field");
  // The state line and the reason live in the setup-facts table (表一), built from
  // SETUP_FACT_ROWS at runtime — the params groups hold editable fields only.
  assert.match(html, /id="setupFactsBox"/);
  assert.match(facts, /\{ key: "kvStreaming", label: "edit\.kvStream", value: "edit-kvResident", hint: "edit\.kvStreamHint" \}/);
});

test("a config that streams keeps its window through an unrelated edit", () => {
  // The reported state must not be disturbed by editing a neighbouring parameter.
  const text = configText(["--kv", "int8", "--kv-resident", "32768", "--max-context", "262144"]);
  const next = applyTextEdit(text, { type: "arg", key: "--max-context", value: "131072" });
  const args = JSON.parse(next).args;
  assert.deepEqual(args.slice(2, 4), ["--kv-resident", "32768"], "the switch stays where setup put it");
  assert.equal(flatConfig(JSON.parse(next), {}).kvResident, 32768);
});

// ── the copy ─────────────────────────────────────────────────────────────

test("the four new strings exist in all six locales", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const keys = ["edit.kvHint", "edit.kvStreamOn", "edit.kvStreamOff", "edit.kvStreamHint"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(String(STRINGS[lang][key] || "").length > 0, `${lang} is missing ${key}`);
    }
    // The level hint must name every level (it is the only place they are explained).
    for (const kv of KV_VALUES) {
      assert.ok(STRINGS[lang]["edit.kvHint"].includes(kv), `${lang}.edit.kvHint must explain ${kv}`);
    }
    // The on-state must show the window number, and the hint must name the lever.
    assert.match(STRINGS[lang]["edit.kvStreamOn"], /\{n\}/, `${lang}.edit.kvStreamOn must interpolate {n}`);
    assert.match(STRINGS[lang]["edit.kvStreamHint"], /kv-streaming/, `${lang} must name the setup flag`);
  }
});

test("the container side keeps pointing at its env instead of a field", () => {
  // `-e KV=int8|q4_0|k8v4` and `-e KV_STREAMING=on|off|auto` are setup inputs in
  // the image (docs/INSTALL.md:105-106, :133-134), so the env hint names them.
  for (const lang of ["zh", "en", "fr", "ru", "ja", "ko"]) {
    const hint = read("ui/assets/i18n.js").match(new RegExp(`"${lang}"`));
    assert.ok(hint, `${lang} block present`);
  }
  const hint = read("ui/assets/i18n.js");
  assert.match(hint, /KV_STREAMING/, "the env hint must name KV_STREAMING");
  const profiles = read("lib/profiles.js");
  assert.doesNotMatch(profiles, /kvStreaming|kvResident/, "no container field for it");
});
