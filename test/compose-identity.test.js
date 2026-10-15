// The deployment's identity: the compose project name and the mount paths.
//
// Two things a user changes independently must not silently reshape a
// deployment:
//   * the compose PROJECT NAME — without an explicit top-level `name:`, Compose
//     derives it from the directory holding the file, so moving DeployDir would
//     rename the stack. It is pinned to the container name (normalised to what
//     Compose accepts) instead.
//   * the MOUNT PATHS — Compose resolves a *relative* source against the compose
//     file's directory, so the generated file writes host paths as absolute
//     paths (resolved against DeployDir), while named volumes and `~`/`$VAR`
//     sources are left untouched.
//
// A real `docker compose config` run backs the project-name half when the host
// has Compose; otherwise that one check is skipped (the repo stays
// dependency-free and CI-safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  containerSpec,
  renderComposeFile,
  composeFilePath,
  composeProjectName,
  absolutizeBindSource,
  absolutizeHostPath,
} from "../lib/compose.js";
import { normalizeProfile, emptyContainerProfile, DEFAULT_MODELS_BIND_DIR } from "../lib/profiles.js";
import { mi50Preset, mi50HostDirs } from "../lib/mi50.js";

const tmpRoots = [];
function tmpDir(prefix = "strata-identity-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── ① the compose project name ────────────────────────────────────────────

test("the project name is derived from the container name, normalised for Compose", () => {
  assert.equal(composeProjectName({ containerName: "strata" }), "strata");
  assert.equal(composeProjectName({ containerName: "strata-mi50" }), "strata-mi50");
  assert.equal(composeProjectName({ containerName: "My Box.1" }), "my-box-1");
  assert.equal(composeProjectName({ containerName: "_leading" }), "leading");
  assert.equal(composeProjectName({ containerName: "..." }), "strata", "nothing usable falls back");
  assert.equal(composeProjectName({ containerName: "" }), "strata");
  assert.equal(composeProjectName({ containerName: "", id: "p-abc" }), "p-abc", "the id is the next source");
  // Compose requires [a-z0-9][a-z0-9_-]*.
  for (const name of ["strata", "My Box.1", "strata-mi50", "UPPER_CASE"]) {
    assert.match(composeProjectName({ containerName: name }), /^[a-z0-9][a-z0-9_-]*$/);
  }
});

test("the compose file carries the project name explicitly", () => {
  const spec = containerSpec({ containerName: "strata-mi50", imageName: "img", GpuModel: "nvidia" });
  assert.equal(spec.projectName, "strata-mi50");
  const text = renderComposeFile(spec, { profileName: "p" });
  assert.match(text, /^name: "strata-mi50"$/m);
  // Still a single services: block, and no stray `-p`-ish key.
  assert.equal((text.match(/^services:$/gm) || []).length, 1);
});

// ── ③ the mount paths ─────────────────────────────────────────────────────

test("a relative bind source resolves against the DeployDir; absolute / named / ~ are kept", () => {
  const dir = "/srv/compose/box";
  // Absolute stays byte-identical.
  assert.equal(absolutizeBindSource("/mnt/models:/models", dir), "/mnt/models:/models");
  // A relative path (dotted or separator-bearing) becomes absolute.
  assert.equal(absolutizeBindSource("./models:/models", dir), "/srv/compose/box/models:/models");
  assert.equal(absolutizeBindSource("../shared:/shared", dir), "/srv/compose/shared:/shared");
  assert.equal(absolutizeBindSource("sub/dir:/x:ro", dir), "/srv/compose/box/sub/dir:/x:ro");
  // A BARE name is a named volume, never a path — resolving it would change the
  // deployment.
  assert.equal(absolutizeBindSource("strata-data:/data", dir), "strata-data:/data");
  // `~` and `$VAR` are resolved by the CLI against the home / environment, so
  // they are already directory-independent.
  assert.equal(absolutizeBindSource("~/models:/models", dir), "~/models:/models");
  assert.equal(absolutizeBindSource("$HOME/m:/m", dir), "$HOME/m:/m");
  // Windows-ish absolutes count as absolute everywhere.
  assert.equal(absolutizeBindSource("C:\\models:/models", dir), "C:\\models:/models");
  assert.equal(absolutizeBindSource("", dir), "");
});

test("the model directory is a host folder, so a relative one resolves too", () => {
  assert.equal(absolutizeHostPath("/mnt/models", "/srv/box"), "/mnt/models");
  assert.equal(absolutizeHostPath("models", "/srv/box"), "/srv/box/models");
  assert.equal(absolutizeHostPath("./m", "/srv/box"), "/srv/box/m");
  assert.equal(absolutizeHostPath("~/m", "/srv/box"), "~/m");
  assert.equal(absolutizeHostPath("", "/srv/box"), "");
});

test("containerSpec emits absolute host paths and keeps named volumes intact", () => {
  const dir = tmpDir();
  const spec = containerSpec({
    containerName: "box",
    imageName: "img",
    GpuModel: "nvidia",
    ModelDir: "models",
    VolumeBinds: ["./data:/data", "/abs/models:/models", "box-data:/box-data", "~/home:/home"],
    DeployDir: dir,
  });
  assert.equal(spec.deployDir, dir);
  assert.equal(spec.modelDir, path.join(dir, "models"), "the model dir is absolute");
  assert.ok(spec.volumeBinds.includes(path.join(dir, "data") + ":/data"), "the dotted bind is absolute");
  assert.ok(spec.volumeBinds.includes("/abs/models:/models"));
  assert.ok(spec.volumeBinds.includes("box-data:/box-data"), "the named volume stays a name");
  assert.ok(spec.volumeBinds.includes("~/home:/home"));
});

test("the emitted file never carries a relative host path in its service mounts", () => {
  const dir = tmpDir();
  const text = renderComposeFile(
    containerSpec({
      containerName: "box",
      imageName: "img",
      GpuModel: "nvidia",
      ModelDir: "models",
      VolumeBinds: ["./data:/data", "box-data:/box-data"],
      DeployDir: dir,
    }),
    {},
  );
  const serviceVolumes = text.slice(text.indexOf("    volumes:"), text.indexOf("  volumes:") === -1 ? undefined : text.indexOf("  volumes:"));
  for (const line of serviceVolumes.split("\n").filter((l) => l.trim().startsWith("- "))) {
    const source = line.trim().slice(2).replace(/^"|"$/g, "").split(":")[0];
    assert.ok(
      path.posix.isAbsolute(source) || path.win32.isAbsolute(source) || !source.includes("/"),
      `mount source must be absolute or a named volume, got ${source}`,
    );
  }
  // A bare name is declared at the top level (Compose refuses an undeclared
  // named volume), with an explicit name so the volume is not project-prefixed.
  assert.match(text, /^volumes:$/m);
  assert.match(text, /^  "box-data":$/m);
  assert.match(text, /^    name: "box-data"$/m);
});

test("the MI50 preset's host directories are absolute, so its mounts are too", () => {
  const dirs = mi50HostDirs({ containerName: "strata-mi50", home: "/home/u" });
  for (const value of Object.values(dirs)) assert.ok(path.isAbsolute(value), `${value} must be absolute`);
  const preset = mi50Preset({ containerName: "strata-mi50", home: "/home/u" });
  for (const bind of preset.VolumeBinds) {
    const source = bind.split(":")[0];
    assert.ok(path.isAbsolute(source), `preset bind source must be absolute: ${bind}`);
  }
  // ...and they survive the spec unchanged.
  const spec = containerSpec(normalizeProfile({ name: "mi50", type: "container", containerName: "strata-mi50", ...preset }));
  for (const bind of spec.volumeBinds) {
    assert.ok(path.isAbsolute(bind.split(":")[0]), `spec bind must stay absolute: ${bind}`);
  }
  // The model bind falls back to /models when ModelsBindDir is empty.
  const bare = containerSpec(emptyContainerProfile({ containerName: "c", ModelDir: "/m" }));
  assert.equal(bare.modelsBindDir, DEFAULT_MODELS_BIND_DIR);
});

// A profile migrated from the pre-compose flat fields gets a synthesized
// `<containerName>-data:/data` named volume (the old `docker run` recipe did
// exactly that). It must be declared with that very name, or the compose path
// both refuses the project and would orphan the existing volume's data.
test("a legacy named-volume mount is declared with its own name", () => {
  const profile = normalizeProfile({
    name: "old",
    type: "container",
    imageName: "strata",
    imageTag: "latest",
    containerName: "oldbox",
    ggufDir: "/srv/models",
  });
  // The migration synthesized it (no dataDir was stored).
  assert.ok(profile.VolumeBinds.includes("oldbox-data:/data"), "the legacy data mount is synthesized");
  const text = renderComposeFile(containerSpec(profile), {});
  assert.match(text, /- "oldbox-data:\/data"/);
  assert.match(text, /^volumes:$/m);
  assert.match(text, /^  "oldbox-data":$/m);
  assert.match(text, /^    name: "oldbox-data"$/m, "the volume keeps the un-prefixed legacy name");
});

// ── the real `docker compose config` (skipped when Compose is absent) ─────

let HAS_COMPOSE = false;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 15000 });
  HAS_COMPOSE = true;
} catch {
  HAS_COMPOSE = false;
}

test(
  "docker compose honours the explicit name, not the directory (requires Docker Compose)",
  { skip: HAS_COMPOSE ? false : "docker compose is not available on this host" },
  () => {
    const containerName = "strata-identity-check";
    // A directory whose basename is deliberately NOT the container name.
    const dir = tmpDir("some-other-folder-");
    const spec = containerSpec({ containerName, imageName: "alpine:3", GpuModel: "nvidia", DeployDir: dir });
    fs.writeFileSync(composeFilePath(dir), renderComposeFile(spec, { profileName: "p" }));

    const configured = execFileSync("docker", ["compose", "config"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.match(configured, new RegExp(`^name: ${containerName}$`, "m"), "the project name comes from the file, not the folder");

    // Contrast: strip the `name:` line and Compose falls back to the folder name
    // (lower-cased, as Compose normalises project names).
    const stripped = path.join(dir, "no-name.yml");
    fs.writeFileSync(stripped, fs.readFileSync(composeFilePath(dir), "utf8").replace(/^name:.*\n/m, ""));
    const dirDerived = execFileSync("docker", ["compose", "-f", "no-name.yml", "config"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });
    const folderDerived = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    assert.match(dirDerived, new RegExp(`^name: ${folderDerived}$`, "m"), "without name: the folder decides");
  },
);
