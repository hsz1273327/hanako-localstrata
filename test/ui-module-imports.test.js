// Every local import in ui/assets must resolve to a file that exists, and to a
// name that file actually exports. A missing import is not a subtle bug: the
// browser refuses the module, the page's first paint throws, and the user sees
// an empty panel instead of an error. Tests here never load panel.js (it needs
// a DOM), so this walk is the only place that catches it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "ui", "assets");

function modules() {
  return fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(assets, f), "utf8") }));
}

// `import { a, b as c } from "./x.js"` and `import x from "./x.js"`. Comments are
// stripped first: a doc line that mentions an import shape must not count as one.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function localImports(rawText) {
  const text = stripComments(rawText);
  const out = [];
  const re = /import\s+(?:([\w*]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))\s+from\s+"(\.\/[^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const named = m[2]
      ? m[2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.split(/\s+as\s+/)[0].trim())
      : [];
    out.push({ spec: m[5], names: named });
  }
  return out;
}

// Names a module exports, covering the three shapes ui/assets actually uses.
function exportsOf(rawText) {
  const text = stripComments(rawText);
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const s = part.trim();
      if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

test("every local import points at a file that exists", () => {
  const missing = [];
  for (const { name, text } of modules()) {
    for (const { spec } of localImports(text)) {
      const target = path.join(assets, spec.replace(/^\.\//, ""));
      if (!fs.existsSync(target)) missing.push(`${name} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, [], `imports with no file:\n${missing.join("\n")}`);
});

test("every named import is actually exported by its module", () => {
  const broken = [];
  for (const { name, text } of modules()) {
    for (const { spec, names } of localImports(text)) {
      if (!names.length) continue;
      const target = path.join(assets, spec.replace(/^\.\//, ""));
      if (!fs.existsSync(target)) continue; // the other test reports this
      const exported = exportsOf(fs.readFileSync(target, "utf8"));
      for (const n of names) {
        if (!exported.has(n)) broken.push(`${name} imports ${n} from ${spec}, which does not export it`);
      }
    }
  }
  assert.deepEqual(broken, [], `imports of names that are not exported:\n${broken.join("\n")}`);
});

test("the check itself notices a missing name (guards against a silent no-op)", () => {
  const exported = exportsOf(`export function real() {}\nexport { a as b };`);
  assert.ok(exported.has("real"));
  assert.ok(exported.has("b"));
  assert.ok(!exported.has("absent"));
});
