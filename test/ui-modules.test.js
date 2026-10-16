// Structural guards for the UI modules — the layer that the name-list guards of
// test/ui-references.test.js cannot reach.
//
// Why this file exists: a botched edit in ui/assets/panel.js left an unbalanced
// parenthesis (`showConfirm({ … })` lost its wrapper). Every *source-text* test
// passed (they only grep), `validate_app` passed, and — the trap — `node --check`
// passed too: for a file that begins with `import`, Node's check reports nothing
// (a minimal reproduction is the G1 canary below). Only a real ESM parse, or the
// page itself, fails. So the guards here are structural, and each checker is
// self-tested with synthetic input so the guard cannot silently rot:
//
//   G1  every ui/assets/*.js parses as an ES MODULE (child process, no execution)
//   G2  every relative import and every HTML asset reference exists on disk
//   G3  every id the JS looks up exists in the HTML (and vice versa, by allowlist)
//   G4  no ui module CALLS a name it neither declares nor imports
//
// Coverage, honestly:
//   G1 catches syntax/paren/token errors that `node --check` misses. It does not
//      catch a runtime error, only that the file is parseable.
//   G2 catches a 404 (a renamed or deleted module/asset).
//   G3 catches a lookup that would return null and throw later. It cannot know
//      whether the element is the *right* one.
//   G4 catches a CALL to a removed/renamed function (the other half of the same
//      bug class). A bare READ of an undeclared name (`x;`) is NOT covered: the
//      broad rule is unusable here (190 false positives: object-literal method
//      keys, minified SDK internals). Reads are covered only for the names listed
//      in test/ui-references.test.js.
//   None of them replaces a real page load. `--smoke` needs Electron; it cannot
//   run in this environment, so the closest evidence is G1 + the module-load probe
//   described at the bottom of this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const UI_JS = fs.readdirSync(path.join(ROOT, "ui/assets")).filter((f) => f.endsWith(".js")).map((f) => `ui/assets/${f}`);
const PAGES = ["ui/panel.html", "ui/settings.html"];
// Which modules each page actually loads (its entry plus the shared ones; the
// shared ones look ids up only inside subtrees they build themselves).
const PAGE_JS = {
  "ui/panel.html": ["ui/assets/panel.js", "ui/assets/profile-fields.js", "ui/assets/setup-facts.js", "ui/assets/backup-name.js", "ui/assets/clipboard.js", "ui/assets/edit-diff.js"],
  "ui/settings.html": ["ui/assets/settings.js", "ui/assets/profile-fields.js", "ui/assets/setup-facts.js", "ui/assets/clipboard.js"],
};
// Vendored by the host: not ours to lint (G4).
const VENDORED = new Set(["ui/assets/sdk.js", "ui/assets/app-ui.js"]);

// ── the checkers (pure, so they can be self-tested) ───────────────────────

// G1: parse as an ES module in a child process. Never executes the file.
export function esmParseErrors(relPaths, root = ROOT) {
  const script = `
    const fs = require("fs"), vm = require("vm");
    const out = [];
    for (const p of JSON.parse(process.argv[1])) {
      try { new vm.SourceTextModule(fs.readFileSync(p, "utf8"), { identifier: p }); }
      catch (e) { out.push(p + ": " + e.message); }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const abs = relPaths.map((p) => path.join(root, p));
  const stdout = execFileSync(process.execPath, ["--experimental-vm-modules", "-e", script, JSON.stringify(abs)], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

// G2: every relative import target, resolved from the importing file.
export function missingImports(src, fromRel) {
  const dir = path.posix.dirname(fromRel);
  const out = [];
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = path.posix.normalize(path.posix.join(dir, m[1]));
    if (!exists(target)) out.push(`${fromRel} → ${m[1]}`);
  }
  return out;
}

// G2: every ./asset a page references (script src / stylesheet href).
export function missingPageAssets(html, fromRel) {
  const dir = path.posix.dirname(fromRel);
  const out = [];
  for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
    const target = path.posix.normalize(path.posix.join(dir, m[1]));
    if (!exists(target)) out.push(`${fromRel} → ${m[1]}`);
  }
  return out;
}

// G3: ids the JS looks up that the page does not have.
export function idsJsWantsButHtmlLacks(html, js) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([
    ...[...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/querySelector\("#([\w-]+)"\)/g)].map((m) => m[1]),
  ]);
  return [...wanted].filter((id) => !ids.has(id));
}

// G3: ids the page has that no JS in the list ever looks up (candidate leftovers).
export function htmlIdsNobodyLooksUp(html, jsList) {
  const js = jsList.join("\n");
  const referenced = new Set([
    ...[...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/querySelector\("#([\w-]+)"\)/g)].map((m) => m[1]),
  ]);
  return [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))].filter((id) => !referenced.has(id));
}

// G4: calls to a name the file neither declares nor imports.
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "new", "await", "function", "else", "do", "async", "in", "of", "delete", "void", "yield", "super"]);
const GLOBALS = new Set(["document", "window", "navigator", "console", "Math", "JSON", "Date", "Number", "String", "Array", "Object", "Boolean", "Promise", "Set", "Map", "WeakMap", "WeakRef", "Proxy", "Reflect", "Symbol", "Error", "TypeError", "SyntaxError", "RangeError", "RegExp", "Intl", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone", "undefined", "NaN", "Infinity", "globalThis", "fetch", "AbortController", "Headers", "Response", "Request", "Blob", "File", "FileReader", "FormData", "Image", "MutationObserver", "ResizeObserver", "IntersectionObserver", "CustomEvent", "Event", "Node", "Element", "HTMLElement", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia"]);

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
  for (const m of src.matchAll(/\bclass\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfunction[^(]*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([^;)]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) add(m[1]);
  return names;
}

export function undeclaredCalls(src) {
  const code = stripLiterals(src);
  const names = declaredNames(code);
  const bad = new Set();
  for (const m of code.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (names.has(name) || GLOBALS.has(name) || KEYWORDS.has(name)) continue;
    // A method DEFINITION (`name(...) {`) is a member, not a call to a free name.
    const after = code.slice(m.index + m[0].length);
    if (/^\s*\)?\s*\{/.test(after)) continue;
    bad.add(`${name}()`);
  }
  return [...bad];
}

// ── G1..G4 applied to the tree ─────────────────────────────────────────────

test("G1: every UI module parses as an ES module (node --check cannot do this)", () => {
  assert.deepEqual(esmParseErrors(UI_JS), [], "an unparseable module breaks the whole panel");
});

test("G1 canary: the checker catches what node --check silently passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-parse-"));
  try {
    const broken = path.join(dir, "broken.js");
    // Begins with an import + a missing `)`, exactly the shape that slipped through.
    fs.writeFileSync(broken, 'import x from "./nowhere.js";\nconst a = f(1,\nconst b = 2;\n');
    const errors = esmParseErrors([path.relative(ROOT, broken)], ROOT);
    assert.equal(errors.length, 1, "the checker must flag it");
    assert.match(errors[0], /broken\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G2: every relative import and page asset exists", () => {
  const missing = [];
  for (const rel of UI_JS) missing.push(...missingImports(read(rel), rel));
  for (const page of PAGES) missing.push(...missingPageAssets(read(page), page));
  assert.deepEqual(missing, [], "a 404 in the module graph breaks the page");
});

test("G2 self-test: a renamed module is reported", () => {
  assert.deepEqual(missingImports('import { a } from "./gone.js";', "ui/assets/x.js"), ["ui/assets/x.js → ./gone.js"]);
  assert.deepEqual(missingImports('import { a } from "./i18n.js";', "ui/assets/x.js"), []);
  assert.deepEqual(missingPageAssets('<script src="./assets/nope.js"></script>', "ui/panel.html"), ["ui/panel.html → ./assets/nope.js"]);
  assert.deepEqual(missingPageAssets('<script src="./assets/panel.js"></script>', "ui/panel.html"), []);
});

test("G3: the JS only looks up ids the page has", () => {
  const problems = [];
  for (const page of PAGES) {
    const js = PAGE_JS[page].map((rel) => read(rel)).join("\n");
    for (const id of idsJsWantsButHtmlLacks(read(page), js)) problems.push(`${page}: #${id}`);
  }
  assert.deepEqual(problems, [], "a missing id returns null and throws later");
});

test("G3b: ids nobody looks up stay on a known list", () => {
  // Structural or template-only ids: containers named for CSS, ids inside
  // <template> (cloned, then queried on the clone), the popover's own wrappers.
  // A NEW one is either a leftover or a deliberate addition — decide here.
  //
  // The two groups below are the real, reviewed sets:
  //   * panel: the parameter editor (`#ed-*`) and the setup dialog's selects
  //     (`#sp-*`) are addressed through `[data-key]` / `[data-setup]`, never by id;
  //     `#setupNotice` / `#setupParamsHint` are static copy.
  //   * settings: `#profileConfirmSub` carries text only.
  const KNOWN = {
    "ui/panel.html": new Set([
      "setupNotice",
      "setupParamsHint",
      "ed-context", "ed-kv", "ed-sessionCache", "ed-expertCache", "ed-residentBudget", "ed-mtp",
      "ed-temperature", "ed-top_p", "ed-top_k", "ed-min_p", "ed-presence_penalty", "ed-max_tokens",
      "ed-reasoning_effort",
      "ed-vramReserve", "ed-prefill", "ed-poolWorkers", "ed-vramElastic", "ed-specMinP",
      "ed-suffixDraft", "ed-conversationSlots",
      "sp-vision", "sp-context", "sp-kv", "sp-kvStreaming", "sp-lowRam",
    ]),
    "ui/settings.html": new Set(["profileConfirmSub"]),
  };
  const unknown = [];
  for (const page of PAGES) {
    const js = PAGE_JS[page].map((rel) => read(rel)).join("\n");
    for (const id of htmlIdsNobodyLooksUp(read(page), [js])) {
      if (!KNOWN[page].has(id)) unknown.push(`${page}: #${id}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], [], "an id nobody reads is either a leftover or a new decision");
});

test("G3 self-test: the cross-check reports both directions", () => {
  assert.deepEqual(idsJsWantsButHtmlLacks('<div id="a"></div>', 'const x = document.getElementById("b");'), ["b"]);
  assert.deepEqual(idsJsWantsButHtmlLacks('<div id="a"></div>', 'document.getElementById("a");'), []);
  assert.deepEqual(htmlIdsNobodyLooksUp('<div id="a"></div><div id="b"></div>', ['document.getElementById("a");']), ["b"]);
});

test("G4: no UI module calls a name it does not declare or import", () => {
  const problems = [];
  for (const rel of UI_JS) {
    if (VENDORED.has(rel)) continue;
    for (const name of undeclaredCalls(read(rel))) problems.push(`${rel}: ${name}`);
  }
  assert.deepEqual(problems, [], "a call to a removed/renamed function throws at that line");
});

test("G4 self-test: a call to a removed function is reported", () => {
  assert.deepEqual(undeclaredCalls("function a() {}\na();"), []);
  assert.deepEqual(undeclaredCalls("function a() {}\nfillSetupGguf();"), ["fillSetupGguf()"]);
  // A method definition and a member call are not free names.
  assert.deepEqual(undeclaredCalls("const o = { paint() { return 1; } };\no.paint();"), []);
  assert.deepEqual(undeclaredCalls("async function f() {}\nf();"), []);
});

// ── the module-load probe (what "the panel boots" means without Electron) ──
//
// G1 proves the files parse; this proves the *module graph* evaluates: every
// import resolves and the top-level code runs (against a DOM stub, with the host
// SDK replaced by a stub, since the real one requires an iframe). It lives here
// as documentation of the method used when a page fails to start:
//
//   cp -r ui /tmp/probe/ && replace assets/sdk.js with a stub
//   node --experimental-vm-modules -e 'parse each file'     # G1, no execution
//   node /tmp/probe/run.mjs                                 # import panel.js, catch
//
// The last step is what found the unbalanced paren; `node --check` had said the
// file was fine.

test("the entries the pages load are the ones this file guards", () => {
  assert.match(read("ui/panel.html"), /src="\.\/assets\/panel\.js"/, "panel.html must load panel.js");
  assert.match(read("ui/settings.html"), /src="\.\/assets\/settings\.js"/, "settings.html must load settings.js");
  assert.ok(UI_JS.includes("ui/assets/panel.js") && UI_JS.includes("ui/assets/settings.js"));
});
