// The model-directory field: one editable field, three paths.
//
// The panel's 「模型目录」 is the one key that is not a single value. A config names
// its model shards in three places — `--native` (shard 1), `--ple-gguf` (the shard
// holding the PLE table) and `vision.model` (shard 1 again, for the image encoder) —
// and all three move together, or none does. `--pack` / `tokenizer` / `--mtp` /
// `--expert-profile` / `exe` are NOT shard paths (they live under the data
// directory) and must stay untouched: moving the model is not moving the install.
//
// The resolution is by NAME, not by prefix concatenation, so a renamed or re-split
// upload is found — and anything ambiguous, incomplete or of a different shard count
// is REFUSED instead of a broken path being written. That check is exactly what
// setup.py:1420's `gguf_dir_shards` lacks (it takes the folder's only `-00001-of-`
// file whatever quantization it is), which is how an IQ3_S file set ended up inside
// a config tagged IQ3_XXS with a `packs/q2_0` rebuilt from those very files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EDIT_KEYS,
  flatConfig,
  parseJsonText,
  renderConfigEdits,
  resolveModelDirOps,
  validateEdits,
} from "../lib/deployer/common.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// A config with the shape setup.py writes. `base` is where it currently reads its
// shards (created by the test, so resolution has a real directory to look at); the
// args are the real ones from an IQ3_S deployment, shortened where the value does
// not matter here.
function fixture(base, { stem = "Qwen-GSQ-RCO-IQ3_S", mutate = (o) => o } = {}) {
  const name = (i) => `${stem}-${String(i).padStart(5, "0")}-of-00002.gguf`;
  return JSON.stringify(
    mutate({
      exe: "/opt/strata/engine/strata",
      args: [
        "--pack",
        "/data/strata-data/packs/iq2_xs",
        "--native",
        path.join(base, name(1)),
        "--ple-gguf",
        path.join(base, name(2)),
        "--expert-profile",
        "/data/strata/data/expert-profile.bin",
        "--expert-cache",
        "auto",
        "--spec",
        "4",
        "--mtp",
        "/data/strata-data/mtp/rt",
        "--max-context",
        "262144",
        "--kv",
        "int8",
      ],
      cwd: "/data/strata",
      tokenizer: "/data/strata-data/packs/iq2_xs/tokenizer",
      model_name: "qwen3.8-flash-next-iq2_xs",
      vision: { model: path.join(base, name(1)), encoder: "cpu" },
      port: 8080,
    }),
    null,
    1,
  );
}

// A throwaway directory tree (nothing here touches a real install).
let tmpRoot = null;
function scratch() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-dir-test-"));
  return tmpRoot;
}
function makeDir(rel, names) {
  const dir = path.join(scratch(), rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), "stub");
  return dir;
}
const setNames = (stem, total = 2) =>
  Array.from({ length: total }, (_, i) => `${stem}-${String(i + 1).padStart(5, "0")}-of-${String(total).padStart(5, "0")}.gguf`);
// The fixture's own directory: two shards of an IQ3_S set.
const homeDir = () => makeDir("home/IQ3_S", setNames("Qwen-GSQ-RCO-IQ3_S"));

test("flatConfig reports the CURRENT model directory, derived from --native", () => {
  const base = homeDir();
  const flat = flatConfig(parseJsonText(fixture(base)), null);
  assert.equal(flat.modelDir, base);
  assert.equal(flat.modelFile, path.join(base, "Qwen-GSQ-RCO-IQ3_S-00001-of-00002.gguf"));
  // No --native (an unreadable/foreign config) is "nothing", not a guess.
  const empty = flatConfig({ args: [] }, null);
  assert.equal(empty.modelDir, undefined);
  assert.equal(empty.modelFile, undefined);
});

test("modelDir is an editable key whose change needs a restart", () => {
  assert.deepEqual(EDIT_KEYS.modelDir, { kind: "modelDir", restart: true });
  const ok = validateEdits({ modelDir: "/data/models/IQ3_S" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean.modelDir, "/data/models/IQ3_S");
  // An emptied field is refused with a code the panel can translate (edit-diff
  // normally keeps it from reaching here, so this is the safety net).
  assert.deepEqual(validateEdits({ modelDir: "  " }).errors, ["modelDirEmpty"]);
  assert.deepEqual(validateEdits({ modelDir: "/x", bogus: "1" }).errors, ["未知字段: bogus"]);
});

test("resolving onto the SAME directory is an identity rewrite, byte for byte", () => {
  const base = homeDir();
  const text = fixture(base);
  const r = resolveModelDirOps(text, base);
  assert.deepEqual(r.files, ["Qwen-GSQ-RCO-IQ3_S-00001-of-00002.gguf", "Qwen-GSQ-RCO-IQ3_S-00002-of-00002.gguf"]);
  assert.equal(r.ops.length, 3, "native + ple-gguf + vision.model");
  const { newMainText } = renderConfigEdits({
    clean: { modelDir: base },
    before: { modelDir: base },
    mainText: text,
    sharedText: "{}",
  });
  // Not an edit: the diff is empty and the text comes back untouched.
  assert.equal(newMainText, text);
});

test("a moved set rewrites exactly the three paths and nothing else", () => {
  const base = homeDir();
  const text = fixture(base);
  const dst = makeDir("moved/IQ3_S", setNames("Qwen-GSQ-RCO-IQ3_S"));
  const { newMainText, diff, restartRequired } = renderConfigEdits({
    clean: { modelDir: dst },
    before: { modelDir: base },
    mainText: text,
    sharedText: "{}",
  });
  const after = parseJsonText(newMainText);
  const arg = (f) => after.args[after.args.indexOf(f) + 1];
  assert.equal(arg("--native"), path.join(dst, "Qwen-GSQ-RCO-IQ3_S-00001-of-00002.gguf"));
  assert.equal(arg("--ple-gguf"), path.join(dst, "Qwen-GSQ-RCO-IQ3_S-00002-of-00002.gguf"));
  assert.equal(after.vision.model, path.join(dst, "Qwen-GSQ-RCO-IQ3_S-00001-of-00002.gguf"));
  // Everything that is NOT a shard path stays put.
  assert.equal(arg("--pack"), "/data/strata-data/packs/iq2_xs");
  assert.equal(arg("--expert-profile"), "/data/strata/data/expert-profile.bin");
  assert.equal(arg("--mtp"), "/data/strata-data/mtp/rt");
  assert.equal(after.tokenizer, "/data/strata-data/packs/iq2_xs/tokenizer");
  assert.equal(after.exe, "/opt/strata/engine/strata");
  assert.equal(after.cwd, "/data/strata");
  // The only difference between the two texts is those two shard values (each name
  // appears in --native/vision.model and in --ple-gguf respectively).
  const n1 = "Qwen-GSQ-RCO-IQ3_S-00001-of-00002.gguf";
  const n2 = "Qwen-GSQ-RCO-IQ3_S-00002-of-00002.gguf";
  const normalize = (t) =>
    t.split(path.join(dst, n1)).join("<N1>").split(path.join(dst, n2)).join("<N2>")
      .split(path.join(base, n1)).join("<N1>").split(path.join(base, n2)).join("<N2>");
  assert.equal(normalize(newMainText), normalize(text));
  assert.deepEqual(diff, [{ key: "modelDir", old: base, new: dst }]);
  assert.equal(restartRequired, true, "the engine reads the paths at startup");
});

test("a renamed or re-split set of the same quantization is found (not prefix-glued)", () => {
  const text = fixture(homeDir());
  const dst = makeDir("renamed", setNames("Elsewhere-Qwen-IQ3_S"));
  const r = resolveModelDirOps(text, dst);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.files, setNames("Elsewhere-Qwen-IQ3_S"));
});

test("a different quantization in the folder is refused, never adopted", () => {
  // The IQ3_S-in-an-IQ3_XXS-config incident, as a guard: a folder holding only
  // another quantization must not silently take the shards' place.
  const base = homeDir();
  const text = fixture(base);
  const dst = makeDir("xxs-only", setNames("Qwen-GSQ-RCO-IQ3_XXS"));
  const r = resolveModelDirOps(text, dst);
  assert.equal(r.error, "modelDirBadShards");
  assert.deepEqual(r.hint, setNames("Qwen-GSQ-RCO-IQ3_XXS"), "the hint names what IS there");
  assert.throws(
    () => renderConfigEdits({ clean: { modelDir: dst }, before: { modelDir: base }, mainText: text, sharedText: "{}" }),
    (e) => e.validation[0] === "modelDirBadShards",
    "the route answers 400 with a translatable code",
  );
});

test("shard count, completeness and ambiguity are all refused", () => {
  const text = fixture(homeDir());
  const count = resolveModelDirOps(text, makeDir("four", setNames("Qwen-IQ3_S", 4)));
  assert.equal(count.error, "modelDirCountMismatch");

  const partial = makeDir("partial", setNames("Qwen-IQ3_S").slice(0, 1));
  assert.equal(resolveModelDirOps(text, partial).error, "modelDirBadShards");

  const two = makeDir("two-stems", [...setNames("A-IQ3_S"), ...setNames("B-IQ3_S")]);
  assert.equal(resolveModelDirOps(text, two).error, "modelDirAmbiguous");
  assert.deepEqual(resolveModelDirOps(text, two).hint, ["A-IQ3_S", "B-IQ3_S"]);

  const none = makeDir("empty", ["mmproj-Qwen-BF16.gguf", "readme.txt"]);
  assert.equal(resolveModelDirOps(text, none).error, "modelDirBadShards");

  const other = resolveModelDirOps(text, makeDir("other-quant", setNames("Qwen-UD-Q4_K_XL")));
  assert.equal(other.error, "modelDirBadShards");
});

test("a missing folder, a file, a relative path and a --native-less config are refused", () => {
  const text = fixture(homeDir());
  assert.equal(resolveModelDirOps(text, path.join(scratch(), "nope")).error, "modelDirBadDir");
  const file = path.join(scratch(), "a-file");
  fs.writeFileSync(file, "x");
  assert.equal(resolveModelDirOps(text, file).error, "modelDirBadDir");
  assert.equal(resolveModelDirOps(text, "relative/dir").error, "modelDirNotAbsolute");
  const noNative = fixture(homeDir(), { mutate: (o) => ({ ...o, args: ["--pack", "/p"] }) });
  assert.equal(resolveModelDirOps(noNative, "/data/models/IQ3_S").error, "modelDirNoNative");
  // A --native that is itself relative: the directory's meaning would be ambiguous.
  const rel = fixture(homeDir(), {
    mutate: (o) => ({
      ...o,
      args: o.args.map((a) => (a.endsWith("-00001-of-00002.gguf") ? "models/x-00001-of-00002.gguf" : a)),
    }),
  });
  assert.equal(resolveModelDirOps(rel, "/data/models/IQ3_S").error, "modelDirNotAbsolute");
});

test("a single-file model (no shard suffix) resolves by name, and refuses another quant", () => {
  const text = fixture(homeDir(), {
    mutate: (o) => {
      o.args = o.args.filter((a) => a !== "--ple-gguf" && !a.endsWith("-00002-of-00002.gguf"));
      o.args[o.args.indexOf("--native") + 1] = "/data/models/ISTA/Qwen-IQ3_S.gguf";
      o.vision.model = "/data/models/ISTA/Qwen-IQ3_S.gguf";
      return o;
    },
  });
  const dst = makeDir("single", ["Qwen-IQ3_S.gguf"]);
  const r = resolveModelDirOps(text, dst);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ops, [
    { type: "arg", key: "--native", value: path.join(dst, "Qwen-IQ3_S.gguf") },
    { type: "str", key: "model", value: path.join(dst, "Qwen-IQ3_S.gguf") },
  ]);
  assert.equal(resolveModelDirOps(text, makeDir("single-other", ["Qwen-IQ2_XS.gguf"])).error, "modelDirBadShards");
});

test("the real deployment's config is rewritten identically, byte for byte", (t) => {
  // Real evidence when a deployment exists — but the path is NEVER hardcoded here: point
  // HANA_STRATA_REAL_CONFIG at a strata-*.json to run it, otherwise it skips.
  const real = String(process.env.HANA_STRATA_REAL_CONFIG || "");
  if (!real || !fs.existsSync(real)) {
    return t.skip("set HANA_STRATA_REAL_CONFIG=<path to a strata-*.json> to run this");
  }
  const text = fs.readFileSync(real, "utf8");
  const flat = flatConfig(parseJsonText(text), null);
  const r = resolveModelDirOps(text, flat.modelDir);
  assert.equal(r.error, undefined, `the current directory must resolve: ${r.message || ""}`);
  assert.equal(r.ops.length, 3);
  const { newMainText } = renderConfigEdits({
    clean: { modelDir: flat.modelDir },
    before: { modelDir: flat.modelDir },
    mainText: text,
    sharedText: "{}",
  });
  assert.equal(newMainText, text, "writing the value it already has must not change a byte");
  // The directory it already points at must resolve (that is the identity rewrite above);
  // a second real folder is optional and comes from the environment too.
  const other = String(process.env.HANA_STRATA_REAL_MODELS || "");
  if (other && fs.existsSync(other)) assert.equal(resolveModelDirOps(text, other).error, undefined, other);
});

test("the params group and its i18n copy exist in all six languages", () => {
  const html = read("ui/panel.html");
  const form = html.match(/<form id="editForm"[\s\S]*?<\/form>/)[0];
  const groups = [...form.matchAll(/<fieldset class="group">([\s\S]*?)<\/fieldset>/g)].map((m) => m[1]);
  const model = groups.find((g) => g.includes('data-i18n="edit.modelLegend"'));
  assert.ok(model, "the model group exists");
  // Comments explain the distinction; the MARKUP is what is asserted.
  const markup = model.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(markup, /id="ed-modelDir" data-key="modelDir" type="text"/);
  // The CURRENT value rides on the field as `.field-current` — not a `.field-default`
  // ("what happens if you leave this empty") and not a `.cf-readonly-item` (that
  // style means "this cannot be changed"; a params group holds none of those).
  assert.match(markup, /class="field-current"><span data-i18n="edit\.modelDirCurrent"/);
  assert.match(markup, /id="ed-modelDirNow"/);
  assert.match(markup, /id="ed-modelDirFile"/);
  assert.doesNotMatch(markup, /cf-readonly-item/, "an editable field is not a read-only report");
  assert.doesNotMatch(markup, /field-default/, "the current value is not a default hint");
  assert.match(read("ui/assets/panel.css"), /\.field-current \{/);

  const i18n = read("ui/assets/i18n.js");
  const keys = [
    "edit.modelLegend",
    "edit.modelDirLabel",
    "edit.modelDirHint",
    "edit.modelDirCurrent",
    "edit.modelDirFile",
    "edit.modelDirEmpty",
    "edit.modelDirNoNative",
    "edit.modelDirNotAbsolute",
    "edit.modelDirBadDir",
    "edit.modelDirBadShards",
    "edit.modelDirAmbiguous",
    "edit.modelDirCountMismatch",
  ];
  for (const k of keys) {
    const hits = [...i18n.matchAll(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g"))];
    assert.equal(hits.length, 6, `${k} must be translated in all six languages`);
  }
  // The two "model directories" must not read as the same thing: the setup dialog's
  // field is about the NEXT run, this one about what the config reads NOW.
  assert.match(i18n, /"configPick\.setupGgufLabel":/);
  const labels = [...i18n.matchAll(/"edit\.modelDirLabel": "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.length, 6);
  assert.ok(labels.every((l) => l.length > 2), "a real label in every language");

  // Every refusal code the server can emit must have copy: a code with no
  // translation would surface as a bare identifier in the panel.
  const common = read("lib/deployer/common.js");
  const emitted = new Set([
    ...[...common.matchAll(/error: "(modelDir[A-Za-z]+)"/g)].map((m) => m[1]),
    ...(common.match(/errors\.push\("(modelDir[A-Za-z]+)"\)/g) || []).map((s) => s.match(/"(modelDir[A-Za-z]+)"/)[1]),
  ]);
  assert.ok(emitted.size >= 7, `expected the refusal codes, saw ${[...emitted].join(",")}`);
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /t\(`edit\.\$\{code\}`\)/, "the panel translates the code it is handed");
  for (const code of emitted) {
    const hits = [...i18n.matchAll(new RegExp(`"edit\\.${code}":`, "g"))];
    assert.equal(hits.length, 6, `edit.${code} must be translated six times`);
  }
});
