// lib/gpu.js — the GPU *card-model* catalog and its compose templates.
//
// The user never types docker's device vocabulary. They pick one card model
// (which fixes the vendor) and, optionally, which of those cards to use. This
// module turns that into the primitives the compose file / `docker run` need:
//
//   nvidia   → a device reservation (compose `deploy.resources…devices`, CLI
//              `--gpus`), all GPUs or an explicit device id list.
//   amd-*    → the ROCm device nodes, and — for cards whose ROCm support needs
//              it — a device cgroup rule and/or extra `environment` entries
//              (e.g. the MI50 needs HSA_OVERRIDE_GFX_VERSION + LD_LIBRARY_PATH).
//
// Vendor is a *property of the model*, not a separate field: one source of
// truth, and the panel can never record a contradictory pair. Keep this module
// pure and dependency-free — it is the single place that knows the
// vendor/model-specific constants.
//
// ┌─ catalog ───────────────────────────────────────────────────────────────┐
// │ key            vendor  gfx      devices  cgroup  env                    │
// │ nvidia         nvidia  —        —        —       —                      │
// │ amd-mi50       amd     gfx906   kfd+dri  yes     HSA…9.0.6, LD_LIBRARY…│
// │ amd-7900xtx    amd     gfx1100  kfd+dri  —       —                      │
// │ amd-9060xt     amd     gfx1200  kfd+dri  —       —                      │
// │ amd-9070xt     amd     gfx1201  kfd+dri  —       —                      │
// │ amd            amd     —        kfd+dri  —       —   (generic ROCm)     │
// └─────────────────────────────────────────────────────────────────────────┘

// The two device nodes every ROCm container needs, in the host:container form.
const ROCM_DEVICES = ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"];

// Every candidate card model. `nvidia` is one entry because no NVIDIA card
// needs a model-specific fragment (the device request is identical for all RTX
// generations); split it later if that ever changes — keys are free-form.
export const GPU_MODELS = {
  nvidia: {
    label: "NVIDIA GeForce RTX (CUDA)",
    vendor: "nvidia",
    gfx: null,
    env: [],
    devices: [],
    deviceCgroupRules: [],
  },
  "amd-mi50": {
    label: "AMD Instinct MI50 (Vega 20, gfx906)",
    vendor: "amd",
    gfx: "gfx906",
    env: ["HSA_OVERRIDE_GFX_VERSION=9.0.6", "LD_LIBRARY_PATH=/opt/rocm/lib"],
    devices: ROCM_DEVICES,
    deviceCgroupRules: ["c 226:* rmw"],
  },
  "amd-7900xtx": {
    label: "AMD Radeon RX 7900 XT / XTX (RDNA3, gfx1100)",
    vendor: "amd",
    gfx: "gfx1100",
    env: [],
    devices: ROCM_DEVICES,
    deviceCgroupRules: [],
  },
  "amd-9060xt": {
    label: "AMD Radeon RX 9060 XT (RDNA4, gfx1200)",
    vendor: "amd",
    gfx: "gfx1200",
    env: [],
    devices: ROCM_DEVICES,
    deviceCgroupRules: [],
  },
  "amd-9070xt": {
    label: "AMD Radeon RX 9070 / 9070 XT (RDNA4, gfx1201)",
    vendor: "amd",
    gfx: "gfx1201",
    env: [],
    devices: ROCM_DEVICES,
    deviceCgroupRules: [],
  },
  // Anything ROCm-supported we have not enumerated: the shared device nodes,
  // no model-specific extras. ("unconfirmed" for exotic targets — pick a
  // concrete model entry once known.)
  amd: {
    label: "Other AMD (ROCm, generic)",
    vendor: "amd",
    gfx: null,
    env: [],
    devices: ROCM_DEVICES,
    deviceCgroupRules: [],
  },
};

export const GPU_MODEL_KEYS = Object.keys(GPU_MODELS);

// The vendors the catalog may contain. `none` is deliberately absent: local
// inference always has a card, so "no GPU" is not a user choice.
export const GPU_VENDORS = ["nvidia", "amd"];

// The catalog as the panel consumes it (key + label + vendor + gfx hint).
export function gpuModelCatalog() {
  return GPU_MODEL_KEYS.map((key) => {
    const m = GPU_MODELS[key];
    return { key, label: m.label, vendor: m.vendor, gfx: m.gfx };
  });
}

export function gpuModelInfo(key) {
  const k = String(key ?? "").trim();
  return GPU_MODELS[k] ? { key: k, ...GPU_MODELS[k] } : null;
}

// "all" / "" / undefined → every GPU. Anything else is a comma list of device
// ids ("0", "0,1"), returned as an array; non-numeric fragments are dropped.
export function parseGpuIds(value) {
  const s = String(value ?? "").trim();
  if (!s || s.toLowerCase() === "all") return [];
  return s
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));
}

// model key + ids → { key, model, vendor, devices, deviceCgroupRules, env,
// deployDevices, cliGpus, known }.
//   devices            → compose `devices:` (AMD)
//   deviceCgroupRules  → compose `device_cgroup_rules:` contributed by the model
//   env                → environment entries the model requires
//   deployDevices      → compose `deploy.resources.reservations.devices` (NVIDIA)
//   cliGpus            → the `--gpus` value for the legacy `docker run` path
export function gpuTemplate(modelKey, gpuIds) {
  const key = String(modelKey ?? "").trim();
  const model = GPU_MODELS[key] || null;
  const out = {
    key,
    model,
    known: !!model,
    vendor: model?.vendor || "",
    devices: [...(model?.devices || [])],
    deviceCgroupRules: [...(model?.deviceCgroupRules || [])],
    env: [...(model?.env || [])],
    deployDevices: [],
    cliGpus: null,
  };
  if (model?.vendor === "nvidia") {
    const ids = parseGpuIds(gpuIds);
    if (ids.length) {
      out.deployDevices = [{ driver: "nvidia", deviceIds: ids, capabilities: ["gpu"] }];
      out.cliGpus = `device=${ids.join(",")}`;
    } else {
      out.deployDevices = [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }];
      out.cliGpus = "all";
    }
  }
  return out;
}

export default {
  GPU_MODELS,
  GPU_MODEL_KEYS,
  GPU_VENDORS,
  gpuModelCatalog,
  gpuModelInfo,
  parseGpuIds,
  gpuTemplate,
};
