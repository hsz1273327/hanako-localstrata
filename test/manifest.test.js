// The manifest is the App's whole UI contract: which cards it declares, where each
// card's content comes from, and which of them carry a right-hand FUNCTION PANEL.
//
// What is pinned here (the shape the platform reads, verified against the host's own
// code in docs/dev/v2-sidebar-notes.md):
//   * `face.image` is required on EVERY card and must be a real, non-empty file under
//     `ui/` (no coverless fallback in v2);
//   * a card WITHOUT `realization` is a CANVAS card — the only kind the Card Center
//     can drag onto a page (`realization: "page"` tiles are not draggable: the host's
//     `Us()` returns true for them and the drag source emits
//     `chalkboard-layout-card-create-unavailable`);
//   * `functionPanel` needs an `id`, and its `route` must be a real `ui/` page;
//   * we do NOT claim `app/input.panels`: our UI never calls `hana.inputPanel.*`
//     (the two hits in the tree are the vendored SDK's own implementation), so the
//     capability would buy an extra grant and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const cards = manifest.contributes?.cards || [];

const uiFile = (route) => path.join(ROOT, "ui", route.replace(/^\//, ""));

test("the manifest identifies this App and points at real entry points", () => {
  assert.equal(manifest.manifestVersion, 2, "v2 is the only readable format");
  assert.equal(manifest.id, path.basename(ROOT), "the id must equal the folder name");
  assert.ok(fs.existsSync(path.join(ROOT, manifest.entry)), `entry ${manifest.entry} exists`);
  // `icon` is package-relative (not under ui/), unlike a card's face.
  assert.ok(fs.existsSync(path.join(ROOT, manifest.icon)), `icon ${manifest.icon} exists`);
  assert.ok(fs.statSync(path.join(ROOT, manifest.icon)).size > 0, "the icon is not empty");
  assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+/, "minAppVersion is MAJOR.MINOR.PATCH");
});

test("every card has a real cover and a real route", () => {
  assert.ok(cards.length >= 2, "the page card and the canvas card");
  const ids = cards.map((c) => c.id);
  assert.deepEqual([...new Set(ids)], ids, "ids are unique");
  for (const card of cards) {
    assert.ok(card.id && typeof card.id === "string", "id");
    assert.ok(card.title && typeof card.title === "string", `${card.id}: title`);
    assert.ok(card.route?.startsWith("/"), `${card.id}: route must be a ui/ path`);
    assert.ok(fs.existsSync(uiFile(card.route)), `${card.id}: ${card.route} exists`);
    // v2 has no coverless fallback: the file must exist, inside ui/, non-empty.
    assert.ok(card.face?.image, `${card.id}: face.image is required`);
    const face = path.join(ROOT, "ui", card.face.image);
    assert.ok(fs.existsSync(face), `${card.id}: ${card.face.image} exists`);
    assert.ok(fs.statSync(face).size > 0, `${card.id}: the cover is not empty`);
    assert.doesNotMatch(face, /\.\./, `${card.id}: the cover stays inside ui/`);
  }
});

test("one card is a CANVAS card (the only kind that can be dragged onto a page)", () => {
  const canvas = cards.filter((c) => !c.realization);
  assert.equal(canvas.length, 1, "exactly one plain canvas card");
  assert.equal(canvas[0].id, "dashboard");
  // The canvas card is the SLIM view: a glanceable card must not boot the full
  // page's editor/drawer code (~2.5k lines). Same reason the function panels use it.
  assert.equal(canvas[0].route, "/card.html", "the slim view, not the full page");
  // The page card stays a page: it is the site-navigation entry with everything.
  const page = cards.find((c) => c.id === "panel");
  assert.equal(page.realization, "page");
  assert.equal(page.siteNavEntry, true);
  assert.equal(page.route, "/panel.html", "the full page is untouched");
});

test("the canvas card is the one with a right-hand function panel", () => {
  // The FUNCTION PANEL is what the product asked for on the always-on card. The
  // whole-page card is the full-function page: it carries no panel of its own
  // (nothing asked for one, and the page already holds everything).
  const withPanel = cards.filter((c) => c.functionPanel);
  assert.deepEqual(withPanel.map((c) => c.id), ["dashboard"], "only the canvas card");
  const fp = withPanel[0].functionPanel;
  assert.ok(typeof fp.id === "string" && fp.id.length > 0, "functionPanel.id");
  assert.equal(fp.route, "/card.html", "the same narrow view as the card itself");
  assert.ok(fs.existsSync(uiFile(fp.route)), `${fp.route} exists`);
  assert.equal(fp.embedUrl, undefined, "route and embedUrl are exclusive");
  assert.equal(fp.service, undefined, "a service would raise minAppVersion");
  const page = cards.find((c) => c.id === "panel");
  assert.equal(page.functionPanel, undefined, "the full page does not carry a panel");
});

test("we do not claim capabilities our UI never uses", () => {
  // `app/input.panels` guards `hana.inputPanel.*`. Our UI never calls it (the two
  // hits in the tree are the vendored SDK's own implementation), and nothing asked
  // for an input-box panel, so claiming the grant would only add an unused
  // permission and a re-approval. This test is the rule: declare what we call.
  assert.deepEqual(manifest.capabilities, [
    "app/tools.expose-to-model",
    "app/ui.open-external",
    "app/ui.clipboard-write",
    "app/process.spawn",
    "app/resources.read",
  ]);
  assert.ok(!manifest.capabilities.includes("app/input.panels"), "no unused grant");
  const ours = ["ui/assets/panel.js", "ui/assets/settings.js", "ui/assets/card.js"].map(read).join("\n");
  assert.doesNotMatch(ours, /hana\.inputPanel\./, "and no call site that would need it");
  // Nothing we declare is gated above our own minAppVersion floor.
  const gated = cards.some((c) => c.titleMode || ["structural", "edge-to-edge"].includes(c.cardForm) || c.service);
  assert.equal(gated, false, "no field that requires minAppVersion >= 0.1017.0");
});

test("the slim view is wired, localised, and reuses the existing routes", () => {
  const html = read("ui/card.html");
  const js = read("ui/assets/card.js");
  // Same SDK + theme the full panel uses.
  assert.match(html, /src="\.\/assets\/card\.js"/);
  assert.match(html, /href="\.\/assets\/card\.css"/);
  assert.match(html, /href="\.\/assets\/app-ui\.css"/);
  assert.match(html, /data-hana-app-ui/);
  assert.match(js, /import \{ hana \} from "\.\/sdk\.js"/);
  // Three things only: state, speed, start/stop.
  for (const id of ["slimState", "slimTg", "slimPp", "slimStart", "slimStop"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is on the card`);
  }
  for (const id of ["slimGpu", "slimMem", "slimOpen"]) {
    assert.ok(!html.includes(`id="${id}"`), `${id} does not belong on the slim view`);
  }
  // Same backend as the full panel — no second API for the card.
  const literal = [...js.matchAll(/api\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(literal)].sort(), ["status"], "only GET /status by name");
  const verbs = [...js.matchAll(/act\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(verbs)].sort(), ["start", "stop"], "the same two actions the panel has");
  assert.doesNotMatch(js, /cards\.open/, "the slim view does not navigate: the page switcher does that");
  // Every string it shows is in all six languages.
  const i18n = read("ui/assets/i18n.js");
  const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(keys.size >= 4, "the labels it renders");
  for (const key of keys) {
    const hits = [...i18n.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g"))];
    assert.equal(hits.length, 6, `${key} must be translated in all six languages`);
  }
  // The state labels it can show are all declared.
  for (const key of [...js.matchAll(/"(state\.[A-Za-z]+)"/g)].map((m) => m[1])) {
    assert.ok(i18n.includes(`"${key}"`), `${key} exists`);
  }
});
