// The Performance block must not flicker.
//
// It did, once per refresh: `els.speedBox.hidden = isSetup || !els.speedRows.children.length`
// (panel.js) made the block's VISIBILITY a function of the metrics SAMPLE. And that
// sample legitimately goes empty: `readRecentLogs` parses only the log's last 512 KB
// (`parseMetrics(readTail(file))`), so when a quiet stretch — or a long log that
// scrolled past the last timed request — pushes the "… generated in N ms (X tok/s)"
// lines out of that window, every field is null. The block then vanished at the next
// 5 s refresh and came back on the next request.
//
// Two rules are pinned here:
//   1. Visibility follows the SERVICE STATE (running / starting / stopping /
//      restarting), never the presence of a measurement.
//   2. The rows are always the same four, each "—" until measured, so a number
//      arriving or leaving changes a cell, not the layout.
//
// The status payload never omits `metrics` — it is `EMPTY_METRICS` when there is no
// log at all — so this was a rendering rule reading a jittery value, not a missing
// field. Both halves are asserted below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_METRICS, parseMetrics } from "../lib/deployer/common.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the Performance block's visibility is the service state, not the sample", () => {
  const js = read("ui/assets/panel.js");
  // The old rule, verbatim, must be gone: a layout decision must not read a value
  // that goes quiet.
  assert.doesNotMatch(
    js,
    /speedBox\.hidden\s*=\s*[^;]*speedRows\.children\.length/,
    "hiding on an empty metrics window is the bug",
  );
  assert.match(
    js,
    /els\.speedBox\.hidden = isSetup \|\| !\(isRunning \|\| isBusy\);/,
    "running (and coming up / going down) is when the block belongs on screen",
  );
  // `isRunning`/`isBusy` are derived from the state set, not from the payload.
  assert.match(js, /const isRunning = s\.state === "running";/);
  assert.match(js, /const isBusy = s\.state === "starting" \|\| s\.state === "stopping" \|\| s\.state === "restarting";/);
  // Content is painted BEFORE the visibility decision on every paint, so the two
  // can never disagree for a frame.
  assert.ok(
    js.indexOf("paintSpeeds(s.metrics)") < js.indexOf("els.speedBox.hidden"),
    "paint the rows, then decide whether the block shows",
  );
});

test("the four rows are always there, with — for what is not measured", () => {
  const js = read("ui/assets/panel.js");
  const fn = js.slice(js.indexOf("function paintSpeeds("), js.indexOf("function paintUptime("));
  assert.ok(fn.length > 0, "paintSpeeds exists");
  // An unconditional row list: the labels are pushed whatever the numbers are.
  assert.match(fn, /const value = \(v, unit\) => \(Number\.isFinite\(v\) \? `\$\{v\}\$\{unit\}` : "—"\)/);
  for (const label of ["label.tg", "label.pp", "label.expertCache", "label.kvHit"]) {
    assert.ok(fn.includes(`t("${label}")`), `${label} keeps its row`);
  }
  // No conditional push: a row must not appear/disappear.
  assert.doesNotMatch(fn, /if \(Number\.isFinite\([^)]*\)\)\s*\w*rows?\.push/);
  assert.doesNotMatch(fn, /rows\.push/, "the rows array is built unconditionally");
});

test("the status payload always carries metrics (so nothing is ever omitted)", () => {
  // The no-log branch of readRecentLogs (lib/deployer/source.js) returns this shape.
  assert.deepEqual(Object.keys(EMPTY_METRICS).sort(), [
    "expertCacheHit",
    "kvHit",
    "pp",
    "ppLast",
    "samples",
    "tg",
    "tgLast",
  ]);
  // A log with no timed request parses to all-null numbers — not to a missing field.
  const quiet = parseMetrics("loading model…\nready\n> request handled\n");
  for (const key of ["pp", "tg", "expertCacheHit", "kvHit"]) {
    assert.equal(Number.isFinite(quiet[key]), false, `${key} is null while quiet`);
    assert.ok(key in quiet, `${key} is present`);
  }
  // And a real line still fills them (the parser is not broken by this change).
  const busy = parseMetrics("generated in 1000 ms (42.5 tok/s)\nread in 500 ms (800 tok/s)\n");
  assert.equal(busy.tg, 42.5);
  assert.equal(busy.pp, 800);
});

test("the resources / logs blocks keep their own rules (this change is scoped)", () => {
  const js = read("ui/assets/panel.js");
  // Resources are whole-machine figures: hidden while the service is not running.
  assert.match(js, /els\.resourceBox\.hidden = isSetup \|\| !isRunning;/);
  // The log block still follows its own content (a log with no lines has no block).
  assert.match(js, /els\.logsBox\.hidden = isSetup \|\| !\(s\.log\?\.lines\?\.length\);/);
});

// ── the data side: WHICH log file the metrics come from ─────────────────────
//
// The install folder holds several logs, and two of them are written while the
// service runs: the server's (`strata-iq3_s.log`, the one the CONFIG declares, where
// `strata serve: … read in N ms (X tok/s), … generated in N ms (Y tok/s)` lines live)
// and the ENGINE's own (`strata-strata-iq3_s.log`, `[strata] done: 220 tokens in 7 s
// (49.2 tok/s)` — a format parseMetrics does not match). Picking "the newest by
// mtime" therefore alternated between them within seconds, so the Performance rows
// were empty half the time and the block hid itself.

test("metrics come from the log the CONFIG declares, not from the newest file", async () => {
  const { readRecentLogs } = await import("../lib/deployer/source.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-log-"));
  try {
    const declared = path.join(dir, "strata-iq3_s.log");
    const engine = path.join(dir, "strata-strata-iq3_s.log");
    fs.writeFileSync(declared, "strata serve: prompt 903 tokens = 0 reused + 903 read in 2021 ms (446.9 tok/s), 220 generated in 4497 ms (48.9 tok/s)\n");
    // The engine's log is the NEWEST one — that is what used to win the mtime race.
    fs.writeFileSync(engine, "[strata] done: 220 tokens in 7 s (49.2 tok/s) (stop, cancel=False)\n");
    fs.utimesSync(declared, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    fs.writeFileSync(
      path.join(dir, "strata-iq3_s.json"),
      JSON.stringify({ log: declared, args: [], model_name: "qwen3.8-flash-next-iq3_s" }),
    );
    const cfg = { strataDir: dir, configFile: "strata-iq3_s.json" };
    const log = readRecentLogs(cfg, 5);
    assert.equal(log.file, "strata-iq3_s.log", "the declared log, even though the engine's is newer");
    assert.equal(log.metrics.tg, 48.9, "and its numbers are the measured ones");
    assert.equal(log.metrics.pp, 446.9);
    // The engine log alone would have produced nothing — that was the flicker.
    const { parseMetrics } = await import("../lib/deployer/common.js");
    assert.equal(Number.isFinite(parseMetrics(fs.readFileSync(engine, "utf8")).tg), false);

    // No declared log / unreadable config → still answer, newest first (old behaviour).
    fs.rmSync(declared);
    const fallback = readRecentLogs(cfg, 5);
    assert.equal(fallback.file, "strata-strata-iq3_s.log");
    fs.rmSync(path.join(dir, "strata-iq3_s.json"));
    const none = readRecentLogs(cfg, 5);
    assert.ok(["strata-strata-iq3_s.log", null].includes(none.file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
