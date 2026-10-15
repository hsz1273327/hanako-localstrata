// lib/mi50.js — the MI50 community-image preset.
//
// The MI50 (Vega 20 / gfx906) is outside Strata's supported architectures and
// has no official image, so a community member publishes one. When the user's
// card model *is* an MI50, this module supplies the fields that the community
// image fixes, so the panel can offer a one-click preset instead of making the
// user type six env vars and three binds by hand.
//
// ── division of labour (never duplicate, never omit) ─────────────────────
// * The card-model template (lib/gpu.js) already carries the docker *device*
//   vocabulary for `amd-mi50`: `/dev/kfd` + `/dev/dri`, the `c 226:* rmw`
//   cgroup rule, and HSA_OVERRIDE_GFX_VERSION / LD_LIBRARY_PATH. Those follow
//   from the card, not from the image, so the preset must NOT repeat them: it
//   writes `GpuModel: "amd-mi50"` and lets the template expand them.
// * The preset carries what the *image* fixes: its pinned tag, the three mounts,
//   the entrypoint's env, the engine/wizard ports, and the shared-memory /
//   memlock / seccomp the image needs.
//
// `ApiKeyEnv` is deliberately left untouched: the image ships a setup wizard
// (see WEB_PORT) that writes the config and owns the key, so the host-held key
// has no variable to be injected into. (Unconfirmed — see docs/dev notes.)
import os from "node:os";
import path from "node:path";
import { gpuModelInfo } from "./gpu.js";

export const MI50_MODEL_KEY = "amd-mi50";
// The gfx target that identifies the card family; the catalog stores it on the
// model entry, so "is this an MI50?" is a lookup, not a string comparison on a
// hard-coded key.
export const MI50_GFX = "gfx906";

// The community image the MI50 is run with. Pinned, never `latest`: the tag is
// the reviewed build, and a floating tag would silently change the engine.
export const MI50_IMAGE = Object.freeze({ name: "xxdoman/strata-mi50", tag: "0.1.43.1" });

export const MI50_ENGINE_PORT = 8085;
export const MI50_WIZARD_PORT = 8090;
export const MI50_SHM_SIZE = "16g";

// The image's container-side paths and the env its entrypoint reads. `CONFIG`
// points at a file inside the DATA mount (the wizard writes it there); its exact
// default name is the one unconfirmed value in this preset.
export const MI50_ENV = Object.freeze([
  "MODELS_DIR=/models",
  "DATA_DIR=/data",
  "CONFIG=/data/config/strata.json",
  `ENGINE_PORT=${MI50_ENGINE_PORT}`,
  `WEB_PORT=${MI50_WIZARD_PORT}`,
]);

// True when the catalog entry for `modelKey` is a gfx906 card (today: the MI50).
export function isMi50Model(modelKey) {
  return gpuModelInfo(modelKey)?.gfx === MI50_GFX;
}

// A filesystem-safe single path segment, mirroring the compose DeployDir rule.
function segment(value, fallback) {
  const s = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

// Where the three mounts live on the host. A concrete path under the user's home
// (next to the profile's compose folder) beats an empty bind — `:/models` is an
// invalid mount — and beats a docker-managed named volume, because a path is
// something the user can point at their own model directory. The user can still
// edit these (they are ordinary VolumeBinds).
export function mi50HostDirs({ containerName = "", home = os.homedir() } = {}) {
  const base = path.join(home, ".hanako-localstrata", segment(containerName, "strata-mi50"));
  return {
    models: path.join(base, "models"),
    data: path.join(base, "data"),
    work: path.join(base, "work"),
  };
}

// The fields the preset writes onto a container profile, or null when the model
// is not a gfx906 card. `modelKey` defaults to the MI50 so a bare call is the
// preset itself; the guard keeps "non-MI50 → no defaults" a single check.
export function mi50Preset({ modelKey = MI50_MODEL_KEY, containerName = "", home = os.homedir() } = {}) {
  if (!isMi50Model(modelKey)) return null;
  const dirs = mi50HostDirs({ containerName, home });
  return {
    imageName: MI50_IMAGE.name,
    imageTag: MI50_IMAGE.tag,
    GpuModel: MI50_MODEL_KEY,
    // The three mounts the image expects. `/work` must be writable (the image
    // builds/writes there).
    VolumeBinds: [`${dirs.models}:/models`, `${dirs.data}:/data`, `${dirs.work}:/work`],
    // The wizard port is a plain published port; the engine port has dedicated
    // fields (EnginePort / EngineBindPort).
    PortBinds: [`${MI50_WIZARD_PORT}:${MI50_WIZARD_PORT}`],
    EnginePort: MI50_ENGINE_PORT,
    EngineBindPort: MI50_ENGINE_PORT,
    environment: [...MI50_ENV],
    ulimits: ["memlock=-1"],
    security_opt: ["seccomp=unconfined"],
    ShmSize: MI50_SHM_SIZE,
  };
}

// Merge the preset onto a container profile (a pure helper for tests and any
// server-side application). A non-MI50 model returns the profile unchanged.
export function applyMi50Preset(profile = {}, opts = {}) {
  const patch = mi50Preset(opts);
  if (!patch) return { ...profile };
  return { ...profile, ...patch };
}

// The catalog the settings page needs to render the card-model picker, plus the
// constant halves of the preset (image + ports) so the prompt can name them.
// The instance-dependent half (host dirs) comes from `mi50Preset` at apply time.
export function mi50Catalog() {
  return {
    modelKey: MI50_MODEL_KEY,
    gfx: MI50_GFX,
    imageName: MI50_IMAGE.name,
    imageTag: MI50_IMAGE.tag,
    enginePort: MI50_ENGINE_PORT,
    wizardPort: MI50_WIZARD_PORT,
  };
}

export default {
  MI50_MODEL_KEY,
  MI50_GFX,
  MI50_IMAGE,
  MI50_ENGINE_PORT,
  MI50_WIZARD_PORT,
  MI50_SHM_SIZE,
  MI50_ENV,
  isMi50Model,
  mi50HostDirs,
  mi50Preset,
  applyMi50Preset,
  mi50Catalog,
};
