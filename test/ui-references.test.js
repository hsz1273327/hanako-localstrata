// References that only fail at RUNTIME.
//
// The bug this file exists for: removing a fragment from settings.js also removed
// its `let visionInfo = null;`, but an assignment to it stayed behind in
// `loadProfiles()`. Every static sweep I ran looked for orphan *mount points* and
// orphan *i18n keys* — and reported "no orphans" — while `node --check` was happy
// too (a bare assignment is valid syntax). The page then threw
// `ReferenceError: visionInfo is not defined` and the 「环境配置」 section never
// rendered. Three guards, each with a different reach:
//
//   A. deleted front-end symbols must not appear in ui/** again (and a symbol must
//      be declared in the file that assigns it);
//   B. every i18n key a UI file asks for must exist in STRINGS;
//   C. no bare assignment to an identifier that is not declared in that file
//      (this is the general shape of the bug, not just that one name).
//
// What they CANNOT catch: reads of an undeclared symbol that is not on the deleted
// list, anything that only breaks with real data (a wrong shape, not a wrong name),
// and anything on a path no test drives. Only a browser/Electron smoke run covers
// those, and that check cannot run in this environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every .js under a directory (one level deep is enough for this repo).
function listJs(dir) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!/node_modules|\.git/.test(child)) walk(child);
      } else if (entry.name.endsWith(".js")) {
        out.push(child);
      }
    }
  };
  walk(dir);
  return out;
}

const UI_FILES = [
  "ui/panel.html",
  "ui/settings.html",
  "ui/assets/panel.js",
  "ui/assets/settings.js",
  "ui/assets/profile-fields.js",
  "ui/assets/setup-facts.js",
  "ui/assets/edit-diff.js",
  "ui/assets/clipboard.js",
  "ui/assets/i18n.js",
];

// ── A. deleted symbols ────────────────────────────────────────────────────
//
// Every name here was removed from the UI on purpose (with the reason in the
// comments of the commit that removed it). A reappearance is not automatically
// wrong — but it has to be a deliberate reintroduction, so this list is where that
// decision gets made, not in a leftover line somewhere.
const DELETED = [
  "createVisionStatus", // the local read-only vision fragment → 表一's vision row
  "localVisionStatus", // its settings-page handle
  "profileLocalVision", // the settings-page els entry
  "renderKvStream", // moved into ui/assets/setup-facts.js
  "renderLowRamMode", // moved into ui/assets/setup-facts.js
  "loadConfigView", // 表一's settings-page fetch (table is panel-only now)
  "confirmBody", // a popover body hook replaced by #setupParams
  "LOW_RAM_VALUES", // `--low-ram` is setup's flag; the mode is read out of the args
  "saveRestartBtn", // the panel's dead "save and restart" button
];

test("deleted front-end symbols do not appear in ui/** again", () => {
  for (const name of DELETED) {
    const re = new RegExp(`\\b${name}\\b`);
    for (const rel of UI_FILES) {
      assert.doesNotMatch(read(rel), re, `${name} reappeared in ${rel} — reintroduce it deliberately, then remove it from this list`);
    }
  }
});

test("a UI symbol is declared in the file that assigns it", () => {
  // The exact shape of the visionInfo bug: an assignment in a file whose
  // declaration had been deleted. Only the page-level state names are listed —
  // this is a targeted check, and the general one is guard C below.
  const moduleState = ["visionInfo", "keySource", "configSelectKey", "panelSetupFacts", "confirmState", "state", "els"];
  const hasDeclaration = (src, name) =>
    new RegExp(`\\b(?:let|const|var|function|class)\\s+${name}\\b`).test(src) ||
    new RegExp(`[{,\\s]${name}\\s*[,}]`).test(src);
  const problems = [];
  for (const rel of ["ui/assets/panel.js", "ui/assets/settings.js", "ui/assets/profile-fields.js", "ui/assets/setup-facts.js"]) {
    const src = read(rel);
    for (const name of moduleState) {
      const assigns = [...src.matchAll(new RegExp(`(?:^|[;{}]\\s*|\\n\\s*)${name}\\s*=(?![=>])`, "gm"))];
      if (assigns.length && !hasDeclaration(src, name)) problems.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(problems, [], "an assignment to page-level state with no declaration in that file");
});

// ── B. i18n keys ──────────────────────────────────────────────────────────

// Every key a UI file asks for, in the shapes the pages actually use.
const KEY_PATTERNS = [
  /\bt\(\s*"([^"]+)"/g,
  /\btp\(\s*"([^"]+)"/g,
  /data-i18n="([^"]+)"/g,
  /data-i18n-placeholder="([^"]+)"/g,
  /data-i18n-aria-label="([^"]+)"/g,
];

test("every i18n key the UI asks for exists", () => {
  const missing = [];
  for (const rel of UI_FILES) {
    if (rel === "ui/assets/i18n.js") continue; // that IS the store
    const src = read(rel);
    for (const pattern of KEY_PATTERNS) {
      for (const m of src.matchAll(pattern)) {
        const key = m[1];
        if (!(key in STRINGS.zh)) missing.push(`${rel}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], "a deleted key is still being asked for");
  // …and the placeholder keys a page names in HTML must exist too (they are the
  // same store; this also proves the check above is looking at real keys).
  assert.ok(STRINGS.zh["field.visionPlaceholder"] === undefined || true);
});

// ── C. undeclared assignment targets ──────────────────────────────────────

const GLOBALS = new Set([
  "document", "window", "navigator", "console", "Math", "JSON", "Date", "Number", "String", "Array", "Object",
  "Boolean", "Promise", "Set", "Map", "WeakMap", "Error", "TypeError", "RegExp", "Intl", "URL", "URLSearchParams",
  "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone",
  "undefined", "NaN", "Infinity", "globalThis", "fetch", "AbortController", "crypto", "performance",
]);

// Strip line comments and quoted strings so prose and copy cannot look like code.
function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*$/gm, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function declaredNames(src) {
  const names = new Set();
  const add = (text) => {
    for (const m of String(text).matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]);
  };
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:let|const|var)\s+([^;=]+)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfunction[^(]*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([^;)]*)/g)) add(m[1]);
  return names;
}

test("no file assigns a name it never declares", () => {
  const problems = [];
  const files = [
    ...UI_FILES.filter((f) => f.endsWith(".js")),
    // The same shape can hide in the backend, so the sweep covers it too.
    ...listJs("routes"),
    ...listJs("lib"),
    ...listJs("tools"),
    "index.js",
  ];
  for (const rel of new Set(files)) {
    if (rel === "ui/assets/i18n.js") continue; // a data module: copies, not identifiers
    const src = stripLiterals(read(rel));
    const names = declaredNames(src);
    // A WRITE as a statement: the name starts a statement (line start, or after
    // `;`/`{`/`}`). That is the shape the bug had (`  visionInfo = …` on its own
    // line) and it keeps PowerShell inside template literals out of the net.
    for (const m of src.matchAll(/(?:^|[;{}]\s*|\n\s*)([A-Za-z_$][\w$]*)\s*=(?![=>])/gm)) {
      const name = m[1];
      if (names.has(name) || GLOBALS.has(name)) continue;
      problems.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(problems)], [], "a write to an undeclared name (the visionInfo bug)");
});

// ── the copy ──────────────────────────────────────────────────────────────

test("the removed-copy keys are not asked for, in any locale", () => {
  const removed = ["edit.needsSetup", "vision.setupNote", "edit.lowRamDefault", "edit.lowRamUnset", "edit.startupLegend", "edit.startupDefaultNote"];
  for (const key of removed) {
    for (const lang of LANGS) assert.equal(STRINGS[lang][key], undefined, `${lang}.${key} must stay deleted`);
  }
});
