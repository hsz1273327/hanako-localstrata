// Cross-module symbols used without being imported.
//
// The 1.1.1 regression was exactly this shape: panel.js called versionRowPlan()
// after it moved to version-row.js, but nobody added the import. The browser
// refused nothing — it simply threw a ReferenceError on the first paint, so the
// panel rendered empty. No test loaded panel.js (it needs a DOM), and the
// import-resolution test only proves an import points somewhere real, which is
// the opposite direction.
//
// This walks every ui/assets module: for each name that some module exports,
// check that a file which calls it either imports it or defines it itself.
// Deliberately conservative — a name it cannot account for locally is reported,
// because a false positive here costs one glance, while the bug costs a blank page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "ui", "assets");

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readModules() {
  return fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(assets, f), "utf8");
      return { name: f, raw, text: stripComments(raw) };
    });
}

function exportedNames(text) {
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

function importedNames(text) {
  const names = new Set();
  const re = /import\s+(?:(\*)\s+as\s+([\w$]+)|(?:\{([^}]*)\}|([\w$]+))(?:\s*,\s*\{([^}]*)\})?)\s+from\s+"[^"]+"/g;
  for (const m of text.matchAll(re)) {
    if (m[2]) names.add(m[2]); // namespace import
    for (const group of [m[3], m[5]]) {
      if (!group) continue;
      for (const part of group.split(",")) {
        const s = part.trim();
        if (!s) continue;
        names.add(s.split(/\s+as\s+/).pop().trim());
      }
    }
    if (m[4]) names.add(m[4]); // default import
  }
  return names;
}

// Names a module defines for itself: declarations, function parameters, and
// destructured bindings. Over-collecting is safe; it only ever silences a report.
function localNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const s = part.trim().split(":")[0].trim();
      if (/^[\w$]+$/.test(s)) names.add(s);
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(",")) {
      const s = part.trim();
      if (/^[\w$]+$/.test(s)) names.add(s);
    }
  }
  // Function and arrow parameters: `(a, b) =>`, `function f(a, b)`.
  for (const m of text.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const s = part.trim().split("=")[0].trim();
      if (/^[\w$]+$/.test(s)) names.add(s);
    }
  }
  for (const m of text.matchAll(/(?:^|[^\w$.])([\w$]+)\s*=>/g)) names.add(m[1]);
  // catch (e)
  for (const m of text.matchAll(/catch\s*\(\s*([\w$]+)/g)) names.add(m[1]);
  // for (const x of ...)
  for (const m of text.matchAll(/for\s*\(\s*(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  return names;
}

test("no module calls another module's export without importing it", () => {
  const mods = readModules();
  const allExports = new Map(); // symbol -> the module that exports it
  for (const { name, text } of mods) {
    for (const sym of exportedNames(text)) {
      if (!allExports.has(sym)) allExports.set(sym, name);
    }
  }

  const offenders = [];
  for (const { name, text } of mods) {
    const known = new Set([...importedNames(text), ...localNames(text), ...exportedNames(text)]);
    for (const [sym, owner] of allExports) {
      if (owner === name) continue;
      if (known.has(sym)) continue;
      // Called as a function or used as a value: `sym(` or `= sym` / `sym.`
      const used = new RegExp(`(^|[^\\w$.'"\`])${sym.replace(/\$/g, "\\$")}\\s*[(.\\[]`).test(text);
      if (used) offenders.push(`${name} uses ${sym} (exported by ${owner}) but never imports or defines it`);
    }
  }
  assert.deepEqual(offenders, [], `cross-module symbols used without an import:\n${offenders.join("\n")}`);
});

test("the detector fires on a known-bad source", () => {
  // A miniature of the real regression: a call with no import behind it.
  const victim = `import { a } from "./other.js";\nfunction paint() { return versionRowPlan({}); }\n`;
  const text = stripComments(victim);
  const known = new Set([...importedNames(text), ...localNames(text), ...exportedNames(text)]);
  assert.equal(known.has("versionRowPlan"), false);
  assert.match(text, /(^|[^\w$.'"`])versionRowPlan\s*[(.[]/);
});
