// 1.1.0 batch 7: local docker image candidates/pull + running-instance values.
//
// Pure helpers and orchestration are unit tested directly (no docker daemon,
// no running service); the settings page wiring is pinned with grep-style
// regression guards, matching the existing settings/profiles test style.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import {
  splitCmdline,
  ggufDirFromConfig,
  localRuntimeValues,
  containerRuntimeValues,
  buildRunningReport,
} from "../lib/runtime-values.js";
import { createDockerAdapter } from "../lib/docker.js";
import {
  beginImagePull,
  getImagePullState,
  resetImagePullState,
} from "../lib/imagepull.js";
import { STRINGS, LANGS } from "../ui/assets/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-batch7-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  resetImagePullState();
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async setMany(patch) {
        Object.assign(store, patch);
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

// A tiny executable that ignores its argv and prints fixed stdout/stderr.
function fakeDocker({ stdout = "", stderr = "", code = 0 } = {}) {
  const dir = tmpDir();
  const file = path.join(dir, "docker");
  let script = "#!/bin/sh\n";
  if (stdout) script += "cat <<'DOCKER_OUT'\n" + stdout + "\nDOCKER_OUT\n";
  if (stderr) script += "cat <<'DOCKER_ERR' 1>&2\n" + stderr + "\nDOCKER_ERR\n";
  script += `exit ${code}\n`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// ── i18n ──────────────────────────────────────────────────────────────────

test("batch 7 i18n keys exist and are non-empty in every locale", () => {
  const keys = [
    "field.imagePull",
    "field.imageRepull",
    "field.imagePullHint",
    "field.imagePullBusy",
    "field.imagePulled",
    "field.imagePullFailed",
    "field.imageAvailable",
    "field.imageMissing",
    "field.imageListFailed",
    "profile.sourceRuntime",
    "profile.sourceRuntimeVolume",
    "profile.sourceDefault",
    "profile.sourceDefaultValue",
    "profile.runtimeNote",
    "profile.runtimeUnavailable",
  ];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
  }
});

// ── splitCmdline / ggufDirFromConfig ─────────────────────────────────────

test("splitCmdline accepts NUL- and space-separated command lines", () => {
  assert.deepEqual(
    splitCmdline(["/usr/bin/python", "/srv/serve/server.py", "--port", "8080"].join("\0")),
    ["/usr/bin/python", "/srv/serve/server.py", "--port", "8080"],
  );
  assert.deepEqual(splitCmdline("  /usr/bin/python   /srv/serve/server.py  --port 8080 "), [
    "/usr/bin/python",
    "/srv/serve/server.py",
    "--port",
    "8080",
  ]);
  assert.deepEqual(splitCmdline(""), []);
});

test("ggufDirFromConfig prefers explicit fields, else the --native folder", () => {
  assert.equal(ggufDirFromConfig({ gguf_dir: "/models/explicit" }), "/models/explicit");
  assert.equal(ggufDirFromConfig({ model_dir: "/models/dir" }), "/models/dir");
  assert.equal(
    ggufDirFromConfig({ args: ["--native", "/data/models/IQ3_S/model-00001-of-00002.gguf"] }),
    "/data/models/IQ3_S",
  );
  assert.equal(ggufDirFromConfig({ args: ["--model", "/data/models/IQ2/model.gguf"] }), "/data/models/IQ2");
  assert.equal(ggufDirFromConfig({ args: [] }), "");
  assert.equal(ggufDirFromConfig(null), "");
});

// ── localRuntimeValues ────────────────────────────────────────────────────

test("localRuntimeValues reads the live local process and config", () => {
  const cmdline =
    "/srv/python/bin/python3 /srv/strata/serve/server.py " +
    "--engine strata --config /srv/strata/strata-iq3_s.json --port 8080 --gpu 0";
  const configJson = {
    args: [
      "--engine",
      "strata",
      "--native",
      "/srv/strata-data/models/IQ3_S/Qwen3.8-...-00001-of-00002.gguf",
    ],
  };
  const cfg = {
    profiles: [
      {
        id: "p1",
        name: "default",
        type: "local",
        strataDir: "",
        pythonPath: "",
        gpu: "",
        ggufDir: "",
        port: 0,
      },
    ],
    activeProfileId: "p1",
    defaultGgufDir: "",
    defaultPort: 0,
  };
  const status = { state: "running", configFile: "strata-live.json", settings: {} };
  const { values, sources } = localRuntimeValues({ cmdline, configJson, cfg, status });

  assert.equal(values.strataDir, "/srv/strata");
  assert.equal(sources.strataDir, "runtime");
  assert.equal(values.pythonPath, "/srv/python/bin/python3");
  assert.equal(sources.pythonPath, "runtime");
  assert.equal(values.configFile, "strata-iq3_s.json");
  assert.equal(sources.configFile, "runtime");
  assert.equal(values.port, 8080);
  assert.equal(sources.port, "runtime");
  assert.equal(values.gpu, "0");
  assert.equal(sources.gpu, "runtime");
  assert.equal(values.ggufDir, "/srv/strata-data/models/IQ3_S");
  assert.equal(sources.ggufDir, "runtime");
});

test("localRuntimeValues falls back to status / profile / default per field", () => {
  const cfg = {
    profiles: [
      {
        id: "p1",
        name: "default",
        type: "local",
        strataDir: "/stored/strata",
        pythonPath: "/stored/python",
        gpu: "1",
        ggufDir: "",
        port: 0,
      },
    ],
    activeProfileId: "p1",
    defaultGgufDir: "/default/models",
    defaultPort: 9000,
  };
  const status = {
    state: "running",
    configFile: "live.json",
    settings: { pythonResolved: "/live/python" },
  };
  // No cmdline, no config: python and configFile are runtime via status.
  const { values, sources } = localRuntimeValues({ cmdline: "", configJson: null, cfg, status });
  assert.equal(values.strataDir, "/stored/strata");
  assert.equal(sources.strataDir, "profile");
  assert.equal(values.pythonPath, "/live/python");
  assert.equal(sources.pythonPath, "runtime");
  assert.equal(values.configFile, "live.json");
  assert.equal(sources.configFile, "runtime");
  assert.equal(values.gpu, "1");
  assert.equal(sources.gpu, "profile");
  assert.equal(values.ggufDir, "/default/models");
  assert.equal(sources.ggufDir, "default");
  assert.equal(values.port, 9000);
  assert.equal(sources.port, "default");
});

// The selected config is a top-level key, so configFile has no profile fallback:
// with no live signal the drawer leaves it unset rather than inventing one.
test("localRuntimeValues never falls back to a profile for configFile", () => {
  const cfg = {
    profiles: [{ id: "p1", name: "default", type: "local", strataDir: "/s", configFile: "stored.json" }],
    activeProfileId: "p1",
  };
  const { values, sources } = localRuntimeValues({
    cmdline: "",
    configJson: null,
    cfg,
    status: { state: "running", settings: {} },
  });
  assert.equal(values.configFile, undefined);
  assert.equal(sources.configFile, undefined);
});

// ── containerRuntimeValues ────────────────────────────────────────────────

test("containerRuntimeValues reads image, name, the model mount and published port", () => {
  const info = {
    Id: "0123456789abcdef0123456789abcdef",
    Name: "/strata",
    State: { Status: "running" },
    Config: { Image: "strata:1.1", Env: ["ENGINE_PORT=8080", "MODELS_DIR=/models"] },
    Mounts: [
      { Type: "volume", Name: "strata-data", Destination: "/data" },
      { Type: "bind", Source: "/models/IQ3_S", Destination: "/models" },
    ],
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "18080" }] } },
  };
  const profile = {
    id: "c1",
    name: "card",
    type: "container",
    image: "stored:old",
    containerName: "stored-name",
    ModelDir: "",
    ModelsBindDir: "/models",
    EnginePort: 0,
  };
  const { values, sources } = containerRuntimeValues(info, profile, { defaultGgufDir: "", defaultPort: 0 });
  assert.equal(values.image, "strata:1.1");
  assert.equal(sources.image, "runtime");
  assert.equal(values.containerName, "strata");
  assert.equal(sources.containerName, "runtime");
  assert.equal(values.modelDir, "/models/IQ3_S");
  assert.equal(sources.modelDir, "runtime");
  assert.equal(values.port, 18080);
  assert.equal(sources.port, "runtime");
});

test("containerRuntimeValues returns empty maps when the container is missing", () => {
  const { values, sources } = containerRuntimeValues(null, { type: "container" }, {});
  assert.deepEqual(values, {});
  assert.deepEqual(sources, {});
});

// ── listImages ────────────────────────────────────────────────────────────

test("listImages parses docker images and skips dangling entries", { skip: process.platform === "win32" }, () => {
  const bin = fakeDocker({
    stdout: [
      "strata\tlatest\tabc1234567890deadbeef\t2 weeks ago\t1.2GB",
      "<none>\t<none>\tdeadbeefdead\t3 weeks ago\t0B",
      "alpine\t3.19\tcafebabe1234\t1 month ago\t7MB",
    ].join("\n"),
  });
  const res = createDockerAdapter(bin).listImages();
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(res.images.length, 2);
  assert.deepEqual(res.images[0], {
    ref: "strata:latest",
    repository: "strata",
    tag: "latest",
    id: "abc123456789",
    created: "2 weeks ago",
    size: "1.2GB",
  });
  assert.equal(res.images[1].ref, "alpine:3.19");
  assert.equal(res.images[1].id, "cafebabe1234");
});

test("listImages reports failure without throwing", { skip: process.platform === "win32" }, () => {
  const bin = fakeDocker({ stderr: "Cannot connect to the Docker daemon", code: 1 });
  const res = createDockerAdapter(bin).listImages();
  assert.equal(res.ok, false);
  assert.equal(res.error, "Cannot connect to the Docker daemon");
  assert.deepEqual(res.images, []);
});

// ── beginImagePull ────────────────────────────────────────────────────────

test("beginImagePull rejects an invalid image name", async () => {
  resetImagePullState();
  await assert.rejects(
    () => beginImagePull({}, "bad image name", { dockerBin: "/usr/bin/docker" }),
    /镜像名不合法/,
  );
});

test("beginImagePull tracks stdout/stderr and finishes ok", async () => {
  resetImagePullState();
  const child = fakeSpawn();
  let captured = null;
  const spawnFn = (bin, args, opts) => {
    captured = { bin, args, opts };
    return child;
  };
  const started = await beginImagePull({}, "strata:latest", {
    dockerBin: "/usr/bin/docker",
    spawn: spawnFn,
  });
  assert.equal(started.started, true);
  assert.equal(started.state.running, true);
  assert.equal(captured.bin, "/usr/bin/docker");
  assert.deepEqual(captured.args, ["pull", "strata:latest"]);
  assert.equal(captured.opts.windowsHide, true);

  child.stdout.emit("data", "Pulling from library/strata\n");
  child.stderr.emit("data", "Download complete\n");
  child.emit("close", 0);

  const state = getImagePullState();
  assert.equal(state.running, false);
  assert.equal(state.ok, true);
  assert.equal(state.error, null);
  assert.deepEqual(state.tail, ["Pulling from library/strata", "Download complete"]);
});

test("beginImagePull records the last output line on failure", async () => {
  resetImagePullState();
  const child = fakeSpawn();
  await beginImagePull({}, "strata:latest", {
    dockerBin: "/usr/bin/docker",
    spawn: () => child,
  });
  child.stderr.emit("data", "manifest unknown\n");
  child.emit("close", 1);
  const state = getImagePullState();
  assert.equal(state.running, false);
  assert.equal(state.ok, false);
  assert.equal(state.error, "manifest unknown");
});

test("beginImagePull returns already while a pull is in flight", async () => {
  resetImagePullState();
  const child = fakeSpawn();
  await beginImagePull({}, "strata:latest", {
    dockerBin: "/usr/bin/docker",
    spawn: () => child,
  });
  const again = await beginImagePull({}, "alpine:3.19", {
    dockerBin: "/usr/bin/docker",
    spawn: () => {
      throw new Error("must not spawn a second pull");
    },
  });
  assert.equal(again.started, false);
  assert.equal(again.already, true);
  assert.equal(again.state.image, "strata:latest");
  child.emit("close", 0);
  resetImagePullState();
});

// ── buildRunningReport ────────────────────────────────────────────────────

test("buildRunningReport surfaces a live value missing from the profile", async () => {
  const ctx = makeCtx({});
  ctx._store.profiles = JSON.stringify([
    {
      id: "p1",
      name: "default",
      type: "local",
      strataDir: "",
      pythonPath: "",
      gpu: "",
      ggufDir: "",
      port: 0,
    },
  ]);
  ctx._store.activeProfileId = "p1";

  const status = { state: "running", configFile: "strata-iq3_s.json" };
  const cmdline =
    "/srv/python/bin/python3 /srv/strata/serve/server.py " +
    "--config /srv/strata/strata-iq3_s.json --port 8080";
  const configJson = {
    args: ["--native", "/srv/strata-data/models/IQ3_S/model-00001-of-00002.gguf"],
  };
  const report = await buildRunningReport(ctx, { status, cmdline, configJson });

  assert.equal(report.running, true);
  assert.equal(report.method, "local");
  assert.equal(report.profileType, "local");
  assert.equal(report.values.ggufDir, "/srv/strata-data/models/IQ3_S");
  assert.equal(report.sources.ggufDir, "runtime");
  assert.equal(report.values.strataDir, "/srv/strata");
  assert.equal(report.sources.strataDir, "runtime");
  assert.equal(report.values.port, 8080);
  assert.equal(report.sources.port, "runtime");
});

test("buildRunningReport does not read processes when stopped", async () => {
  const ctx = makeCtx({});
  ctx._store.profiles = JSON.stringify([
    { id: "p1", name: "default", type: "local", strataDir: "/s", ggufDir: "", port: 0 },
  ]);
  ctx._store.activeProfileId = "p1";
  const report = await buildRunningReport(ctx, {
    status: { state: "stopped" },
    cmdline: "this would be ignored",
  });
  assert.equal(report.running, false);
  assert.equal(report.state, "stopped");
  assert.deepEqual(report.values, {});
  assert.deepEqual(report.sources, {});
  assert.equal(report.defaults.defaultGgufDir, "");
  assert.equal(report.defaults.defaultPort, 0);
});

// ── source-level regression guards ────────────────────────────────────────

test("settings page wires image candidates/pull and the runtime report", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  for (const id of ["pf-image-options", "pf-image-pull", "pf-image-status", "profileRuntimeNote"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
  const js = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(js, /images\/pull/);
  assert.match(js, /profiles\/running/);
  assert.match(js, /field-source/);
  assert.match(js, /clearInterval/);
  assert.match(js, /clearFieldSources/);
  // The read-only view must lock the pull action.
  assert.match(js, /profileImagePull\.disabled\s*=\s*readOnly/);

  const routes = fs.readFileSync(path.join(ROOT, "routes/settings.js"), "utf8");
  assert.match(routes, /app\.get\(\s*"\/profiles\/running"/);
  assert.match(routes, /app\.get\(\s*"\/images"/);
  assert.match(routes, /app\.post\(\s*"\/images\/pull"/);
  assert.match(routes, /app\.get\(\s*"\/images\/pull"/);

  // The native-picker permission is declared this batch to unlock the host
  // directory picker (app/resources.read).
  const manifest = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
  assert.match(manifest, /app\/resources\.read/);
});

test("batch 8 i18n keys exist and are non-empty in every locale", () => {
  const keys = ["field.pickPath", "field.pickPython", "field.pickUnsupported", "field.pickFailed"];
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key} must not be empty`);
    }
    // The generic label stays neutral: no Python semantics mixed into it.
    assert.doesNotMatch(String(STRINGS[lang]["field.pickPath"]), /python/i, `${lang} field.pickPath must stay generic`);
    // The interpreter's label names Python.
    assert.match(String(STRINGS[lang]["field.pickPython"]), /python/i, `${lang} field.pickPython must name Python`);
  }
});

test("settings page wires the host directory picker", () => {
  const manifest = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
  // The new capability is declared, without dropping the existing ones.
  assert.match(manifest, /app\/resources\.read/);
  for (const cap of [
    "app/tools.expose-to-model",
    "app/ui.open-external",
    "app/ui.clipboard-write",
    "app/process.spawn",
  ]) {
    assert.match(manifest, new RegExp(cap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `manifest must keep ${cap}`);
  }

  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  // The local model folder's picker is gone with its field (a GGUF folder is a
  // setup input now, chosen in the panel); the container's block stays.
  for (const id of ["pf-strataDir-pick", "pf-container-extra"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }
  assert.doesNotMatch(html, /pf-ggufDir-pick/, "the local model-folder picker is gone");

  const js = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(js, /resources\.pick/);
  // The host mode is passed through to the one implementation.
  assert.match(js, /await hana\.resources\.pick\(\{ mode \}\)/);
  assert.match(js, /field\.pickUnsupported/);
  assert.match(js, /field\.pickFailed/);
  // The pickers are write-side actions: locked in the read-only view. The
  // container block's own pickers are locked by the shared module.
  assert.match(js, /containerFields\.setReadOnly\(readOnly\)/);
  assert.match(js, /profileStrataDirPick\.disabled\s*=\s*readOnly/);
});

// The General box's "default model directory" is a GGUF path field like the
// drawer's, so it gets the same button through the same implementation: one
// pickPath(), parameterized by the host mode and the message sink of its box.
test("the General default model directory reuses the host directory picker", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  assert.match(html, /id="defaultGgufDir-pick"/);
  // Same localized label as the other pickers: no new i18n key.
  assert.match(html, /id="defaultGgufDir-pick"[^>]*data-i18n="field\.pickPath"/);

  const js = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(js, /defaultGgufDirPick:\s*document\.getElementById\("defaultGgufDir-pick"\)/);
  // Exactly one implementation — the degradation logic is never duplicated.
  assert.equal((js.match(/async function pickPath\s*\(/g) || []).length, 1);
  assert.match(js, /async function pickPath\s*\(\s*input,\s*mode,\s*notify\s*=\s*setProfileMessage\s*\)/);
  // It runs through that one implementation, reporting into #message.
  assert.match(js, /pickDirectory\(els\.defaultGgufDir,\s*setMessage\)/);
  // The General box has no read-only mode, so the input stays hand-editable.
  assert.doesNotMatch(js, /defaultGgufDir\.disabled/);
});

// Every path field in the drawer gets a picker, and the interpreter uses file
// mode (it is a file, and it may stay empty or hold a bare command name).
test("drawer path fields use the host picker with the right mode", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/settings.html"), "utf8");
  for (const id of ["pf-strataDir-pick", "pf-pythonPath-pick"]) {
    assert.match(html, new RegExp(`id="${id}"`), `settings.html must contain #${id}`);
  }

  const js = fs.readFileSync(path.join(ROOT, "ui/assets/settings.js"), "utf8");
  assert.match(js, /pickDirectory\(els\.profileStrataDir\)/);
  assert.match(js, /pickFile\(els\.profilePythonPath\)/);
  // The interpreter's button names Python; the directory fields keep the
  // generic label.
  assert.match(html, /id="pf-pythonPath-pick"[^>]*data-i18n="field\.pickPython"/);
  for (const id of ["pf-strataDir-pick", "defaultGgufDir-pick"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-i18n="field\\.pickPath"`), `#${id} must use the generic label`);
  }
  // Directories go through directory mode; the interpreter through file mode.
  assert.match(js, /function pickDirectory\(input, notify = setProfileMessage\)\s*\{\s*return pickPath\(input, "directory", notify\)/);
  assert.match(js, /function pickFile\(input, notify = setProfileMessage\)\s*\{\s*return pickPath\(input, "file", notify\)/);
  // The interpreter field stays optional and hand-typable: nothing marks it
  // required and no picker rewrites a bare command name into an absolute path.
  assert.doesNotMatch(js, /pythonPath[^\n]*required/i);
  // Read-only view locks every picker, the interpreter one included.
  assert.match(js, /els\.profilePythonPathPick\.disabled\s*=\s*readOnly/);
  assert.match(js, /els\.profileStrataDirPick\.disabled\s*=\s*readOnly/);
  // The container block's path fields (host model dir, compose dir) get the
  // same picker through the shared module — the page hands it pickPath.
  assert.match(js, /createContainerFields\([^)]*\{[\s\S]*?pickPath,[\s\S]*?\}\)/);
});
