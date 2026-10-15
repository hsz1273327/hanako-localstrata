// The copy buttons: which paths exist, and an HONEST result.
//
// The reported bug was "the copy button does nothing". Two things were wrong:
// the failure was only *relabelled* (never explained), and one call site swallowed
// the error outright (`Promise.resolve(...).catch(() => {})`). A copy that quietly
// fails is the worst outcome — these tests pin that a failure carries its reason,
// and that the reason distinguishes "never granted" from "granted but refused".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyToClipboard, CLIPBOARD_HOST, CLIPBOARD_BROWSER, CLIPBOARD_NONE } from "../ui/assets/clipboard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the host capability is preferred and the browser path is left alone", async () => {
  const calls = [];
  const res = await copyToClipboard("payload", {
    hostWrite: async (t) => calls.push(`host:${t}`),
    browserWrite: async (t) => calls.push(`browser:${t}`),
  });
  assert.deepEqual(res, { ok: true, via: CLIPBOARD_HOST, error: null });
  assert.deepEqual(calls, ["host:payload"]);
});

test("a rejected host call falls back to the browser clipboard", async () => {
  const res = await copyToClipboard("payload", {
    hostWrite: async () => {
      throw new Error("capability not granted");
    },
    browserWrite: async () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.via, CLIPBOARD_BROWSER);
});

test("when every path fails the result says why", async () => {
  const res = await copyToClipboard("payload", {
    hostWrite: async () => {
      throw new Error("clipboard-write denied");
    },
    browserWrite: async () => {
      throw new Error("NotAllowedError");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.via, CLIPBOARD_NONE);
  assert.match(res.error, /clipboard-write denied/);
  assert.match(res.error, /NotAllowedError/);
});

test("no available path, and empty text, are failures — never silent successes", async () => {
  const none = await copyToClipboard("payload", {});
  assert.equal(none.ok, false);
  assert.match(none.error, /no clipboard path/);
  assert.equal((await copyToClipboard("")).ok, false);
});

// ── the pages ────────────────────────────────────────────────────────────

test("both surfaces copy through the shared helper and report a failure", () => {
  for (const rel of ["ui/assets/panel.js", "ui/assets/settings.js"]) {
    const src = read(rel);
    assert.match(src, /from "\.\/clipboard\.js"/, `${rel} must use the shared copy helper`);
    // Exactly one host call site per page, and it lives inside the guarded path.
    assert.equal(
      (src.match(/hana\.clipboard\.writeText/g) || []).length,
      1,
      `${rel}: the host clipboard must be reached through one place`,
    );
    assert.match(src, /copy\.failedUngranted/, `${rel} must say why a copy failed`);
    assert.match(src, /api\("capabilities"\)/, `${rel} must ask the ledger which case this is`);
  }
  // The panel also keeps the manual-selection fallback, with the raw reason on the
  // tooltip so a failure can be diagnosed instead of guessed at.
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /selectForManualCopy\(text\)/);
  assert.match(panel, /btn\.title = res\.error \|\| ""/);
});

test("the capabilities route answers from this App's own ledger entry", () => {
  const routes = read("routes/settings.js");
  assert.match(routes, /app\.get\(\s*"\/capabilities"/);
  assert.match(routes, /ctx\.bus\.request\("app:capabilities", \{\}\)/);
  assert.match(routes, /capabilities\[row\.capability\] = \{ status: row\.status, enforcement: row\.enforcement \}/);
});

test("the two failure wordings exist in all six locales and name the fix", async () => {
  const { STRINGS, LANGS } = await import("../ui/assets/i18n.js");
  const fixHint = /安全|Security|Sécurité|Безопасность|セキュリティ|보안/;
  for (const lang of LANGS) {
    for (const key of ["copy.failedUngranted", "copy.failedGranted"]) {
      const value = String(STRINGS[lang][key] || "");
      assert.ok(value.length > 0, `${lang} is missing ${key}`);
      assert.match(value, /\{status\}/, `${lang}.${key} must carry the ledger status`);
    }
    // The un-granted case must tell the user where to fix it…
    assert.match(STRINGS[lang]["copy.failedUngranted"], fixHint, `${lang} must name the settings path`);
    // …and the granted case must not blame permissions.
    assert.doesNotMatch(STRINGS[lang]["copy.failedGranted"], /\{status\}.*安全/, `${lang} must not mis-blame the grant`);
  }
});
