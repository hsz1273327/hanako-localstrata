// Nothing from the machine this App was developed on may reach the repository or the
// package: no absolute home/data paths, no publisher name, no key-shaped literal, and no
// real Strata config or log committed by accident.
//
// This is a guard, not a proof. What it can catch:
//   * any `/home/<user>`, `/data/<dir>` style path except the placeholders the tests use;
//   * a literal that looks like a Strata/OpenAI key (`sk-…`) or a long `Bearer …`;
//   * a real config, its `.bak`, a `.shared-settings.json` or a `.log` in the tree.
// What it cannot catch:
//   * a secret with no recognizable prefix, or one split across lines;
//   * a path under a *placeholder-looking* name (someone could name a real folder `/home/u`);
//   * anything inside `.git` history — this scans the working tree only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Directories that are generated, vendored from somewhere else, or deliberately examples.
// `dist-extensions` is the packed app package: its entry file necessarily carries the
// publisher name, and the zip is rebuilt (new hash) on every release.
const SKIP_DIRS = new Set([".git", "node_modules", "v1-reference", "dist-extensions"]);
const TEXT = /\.(md|js|mjs|cjs|json|html|css|txt|sh|yml|yaml)$/i;
// Paths the tests are allowed to use because they are visibly fake.
const FAKE_HOME = /^\/home\/(u|user|tester|you|me|alice|bob)\b/;
// Fixture roots that are visibly generic (a container example, a model dir, a MIME table).
// A real leak looks like `/data/<someone's install>` or `/home/<a person>`; these do not.
const FAKE_DATA = /^\/data\/(strata|data|packs|models|dtd|strata-data|strata-docker[^/]*)(\/|$)|^\/data\/[a-z-]+\.(bin|gguf|json)$/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = walk(ROOT).map((f) => ({ full: f, rel: path.relative(ROOT, f) }));

test("no absolute path to a developer machine anywhere in the tree", () => {
  const offenders = [];
  for (const { full, rel } of FILES) {
    if (!TEXT.test(rel)) continue;
    // `sdk/` is vendored from Hana (a MIME table carries `/data/dtd`); it is shipped as is.
    if (rel.startsWith("sdk/")) continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      // `/home/<name>` and `/data/<name>` are the two shapes a real install leaks in.
      for (const m of line.matchAll(/\/(?:home|Users|data)\/[A-Za-z0-9._-]+/g)) {
        const hit = m[0];
        if (hit.startsWith("/home/") && FAKE_HOME.test(hit)) continue;
        if (hit.startsWith("/data/") && FAKE_DATA.test(hit)) continue;
        offenders.push(`${rel}:${i + 1} ${hit}`);
      }
    });
  }
  assert.deepEqual(offenders.slice(0, 20), [], `absolute paths in the tree:\n${offenders.join("\n")}`);
});

test("no key-shaped literal, and no publisher name", () => {
  const offenders = [];
  for (const { full, rel } of FILES) {
    if (!TEXT.test(rel)) continue;
    // This file names the publisher pattern on purpose; it is the guard, not a leak.
    if (rel === "test/no-local-env.test.js") continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/\bsk-[A-Za-z0-9]{20,}/.test(line)) offenders.push(`${rel}:${i + 1} sk-…`);
      if (/\bBearer\s+[A-Za-z0-9._-]{24,}/.test(line)) offenders.push(`${rel}:${i + 1} Bearer …`);
      if (/hsz1273327/.test(line)) offenders.push(`${rel}:${i + 1} publisher name`);
    });
  }
  assert.deepEqual(offenders, [], `secret-shaped text:\n${offenders.join("\n")}`);
});

test("a real config, its backup, a shared-settings sibling or a log never sits in the tree", () => {
  const forbidden = (rel) =>
    /(^|\/)strata-[^/]+\.json$/.test(rel) ||
    /\.shared-settings\.json$/.test(rel) ||
    /\.bak(-|$)/.test(rel) ||
    /\.log$/.test(rel);
  const offenders = FILES.map((f) => f.rel).filter(forbidden);
  assert.deepEqual(offenders, [], `files that must stay out of the repo:\n${offenders.join("\n")}`);
});

test("the ignore rules that keep them out are still there", () => {
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  for (const pattern of ["strata-*.json", "*.shared-settings.json", "*.bak", "*.bak-*", ".hanako-localstrata/", "node_modules/", ".env"]) {
    assert.ok(ignore.includes(pattern), `.gitignore must keep ${pattern}`);
  }
});

// ── The quieter half: things that identify a machine without being a path ──────
//
// A GPU model, a VRAM figure, a distro path, a timezone, or a real config name each only
// narrows the machine a little; together they pin it. These checks take the shapes that
// are mechanical. Free text ("a card with 399 MiB free") is not detectable by pattern —
// that is a review rule, not a guard.

test("no GPU/CPU model names in our own code, tests or docs", () => {
  const offenders = [];
  for (const { full, rel } of FILES) {
    if (!TEXT.test(rel) || rel.startsWith("sdk/")) continue;
    // `lib/gpu.js` IS the card catalog the profile form offers — that is the product's
    // data, not a description of this machine.
    // The card catalog is product data (the profile form's GPU list), not a description
    // of this machine: `lib/gpu.js` plus its labels and the test that reads them.
    if (rel === "lib/gpu.js" || rel === "ui/assets/i18n.js" || rel === "test/no-local-env.test.js") continue;
    if (/^test\/container-fields/.test(rel)) continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/\b(RTX|GTX|RX)\s?\d{3,4}\b/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 60)}`);
      if (/\b(Ryzen|Threadripper|EPYC|Xeon)\b/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(offenders, [], `hardware model names (say "a 16 GB card" instead):\n${offenders.join("\n")}`);
});

test("no private network address, distro path or timezone from a developer machine", () => {
  const offenders = [];
  for (const { full, rel } of FILES) {
    if (!TEXT.test(rel) || rel.startsWith("sdk/")) continue;
    if (rel === "test/no-local-env.test.js") continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      // 192.168.x.x style EXAMPLES keep the x: this only flags real octets.
      if (/\b(?:10\.\d+\.\d+|192\.168\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+)\.\d+\b/.test(line)) {
        offenders.push(`${rel}:${i + 1} private address`);
      }
      if (/miniconda|anaconda|\/envs\/[a-z0-9_-]+\//i.test(line)) offenders.push(`${rel}:${i + 1} distro path`);
      if (/\+0[89]00\b|\bCST\b|Asia\/Shanghai/.test(line)) offenders.push(`${rel}:${i + 1} timezone`);
    });
  }
  assert.deepEqual(offenders, [], `machine-local network / distro / timezone:\n${offenders.join("\n")}`);
});

test("no real deployment's config name", () => {
  const offenders = [];
  for (const { full, rel } of FILES) {
    if (!TEXT.test(rel) || rel.startsWith("sdk/")) continue;
    if (rel === "test/no-local-env.test.js") continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/strata-iq3_s|strata-iq3_xxs/i.test(line)) offenders.push(`${rel}:${i + 1} real config name`);
    });
  }
  assert.deepEqual(offenders, [], `use strata-<model>.json in copy:\n${offenders.join("\n")}`);
});
