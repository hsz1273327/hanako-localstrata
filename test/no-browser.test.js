// "The plugin never opens a browser" — one contract, three argv builders.
//
// Strata's setup opens the chat page by default (`open_browser` true, `--open` in
// the run-<model>.sh it writes). For this plugin that is pure noise: the plugin IS
// the UI. So:
//   * the first-run / --setup job passes `--no-browser` (lib/firstrun.js's setupArgs);
//   * the update's `setup.py --update` passes it too (routes/update.js);
//   * the start of `serve/server.py` passes no `--open` at all — serve opens a
//     browser only when it sees that flag (serve/server.py:5865), so a start from
//     here is quiet no matter what the config's `open_browser` says.
//
// These are argv assertions only: nothing is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";

import { setupArgs } from "../lib/firstrun.js";
import { updateSetupArgs } from "../routes/update.js";
import { serverStartArgs } from "../lib/deployer/source.js";

const SETUP_PY = "/srv/Strata/setup.py";

test("the first-run setup carries --no-browser, exactly once", () => {
  const args = setupArgs({ dataDir: "/srv/Strata-data" }, SETUP_PY);
  assert.ok(args.includes("--no-browser"), `first-run setup must pass --no-browser: ${args.join(" ")}`);
  assert.equal(args.filter((a) => a === "--no-browser").length, 1, "added in setupArgs only, never twice");
  // It sits with the other unconditional flags, not somewhere a per-run
  // parameter could push past it.
  assert.ok(args.indexOf("--no-browser") < args.indexOf("--data-dir"));

  // A run that asks for parameters keeps it as well.
  const withParams = setupArgs(
    { dataDir: "/srv/Strata-data", ggufDir: "/mnt/gguf", setup: { model: "qwen3-coder-30b", context: "131072" } },
    SETUP_PY,
  );
  assert.equal(withParams.filter((a) => a === "--no-browser").length, 1);
  // ...and there is no opposite flag anywhere that would undo it.
  assert.ok(!withParams.includes("--browser"));
});

test("the update's setup.py --update carries --no-browser too", () => {
  const args = updateSetupArgs(SETUP_PY, "/srv/Strata-data");
  assert.ok(args.includes("--no-browser"), `update must pass --no-browser: ${args.join(" ")}`);
  assert.equal(args.filter((a) => a === "--no-browser").length, 1);
  assert.ok(args.includes("--update") && args.includes("--yes"));
  assert.equal(args[args.indexOf("--data-dir") + 1], "/srv/Strata-data");
  assert.ok(!args.includes("--browser"));
});

test("starting serve/server.py passes no --open (the plugin is the UI)", () => {
  const plain = serverStartArgs({
    serverScript: "/srv/Strata/serve/server.py",
    configPath: "/srv/Strata/strata-q4.json",
    port: 8080,
  });
  assert.ok(!plain.includes("--open"), `start must not pass --open: ${plain.join(" ")}`);
  assert.equal(plain[0], "/srv/Strata/serve/server.py");
  assert.deepEqual(plain.slice(1), ["--engine", "strata", "--config", "/srv/Strata/strata-q4.json", "--port", "8080"]);

  // Same with a GPU selector, the only optional flag the start adds.
  const withGpu = serverStartArgs({
    serverScript: "/srv/Strata/serve/server.py",
    configPath: "/srv/Strata/strata-q4.json",
    port: 8080,
    gpu: " 0,1 ",
  });
  assert.ok(!withGpu.includes("--open"));
  assert.deepEqual(withGpu.slice(-2), ["--gpu", "0,1"]);
});

// The three together: two runs that could open a window ask setup not to, and
// the one start that could ask serve to does not even mention it.
test("no path in the plugin can open a browser", () => {
  const setup = setupArgs({ dataDir: "/srv/Strata-data" }, SETUP_PY);
  const update = updateSetupArgs(SETUP_PY, "/srv/Strata-data");
  const start = serverStartArgs({ serverScript: "/srv/Strata/serve/server.py", configPath: "/c.json", port: 1 });
  for (const [name, args] of [["setup", setup], ["update", update], ["start", start]]) {
    assert.ok(!args.includes("--open"), `${name} must never pass --open`);
  }
  assert.ok(setup.includes("--no-browser") && update.includes("--no-browser"));
});
