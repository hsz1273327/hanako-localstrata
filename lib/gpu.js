// lib/gpu.js — the container GPU vendor templates.
//
// The user never sees docker's device vocabulary. The panel asks one question
// ("which vendor?") plus an optional "which cards?" and this module expands the
// answer into the primitives the compose file / `docker run` need:
//
//   nvidia → a device reservation (compose `deploy.resources…devices`, CLI
//            `--gpus`) for all GPUs or a specific device id list.
//   amd    → the ROCm device nodes + cgroup rule (community MI50 images).
//   none   → nothing.
//
// Keep this module pure and dependency-free: it is the single place that knows
// the vendor-specific constants, so the compose writer, the legacy `docker run`
// fallback and the tests cannot drift.

export const GPU_VENDORS = ["nvidia", "amd", "none"];

// AMD ROCm (e.g. the community MI50 image): the two device nodes every ROCm
// container needs, plus the cgroup rule that lets it reach the render nodes.
// These are template constants, never user fields.
export const AMD_DEVICES = ["/dev/kfd", "/dev/dri"];
export const AMD_DEVICE_CGROUP_RULES = ["c 226:* rmw"];

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

// vendor + ids → { devices, deviceCgroupRules, deployDevices, cliGpus }.
//   devices            → compose `devices:` (AMD only)
//   deviceCgroupRules  → compose `device_cgroup_rules:` contributed by the vendor
//   deployDevices      → compose `deploy.resources.reservations.devices` (NVIDIA)
//   cliGpus            → the `--gpus` value for the legacy `docker run` path
export function gpuTemplate(vendor, gpuIds) {
  const v = String(vendor ?? "").trim().toLowerCase();
  const out = { devices: [], deviceCgroupRules: [], deployDevices: [], cliGpus: null };
  if (v === "nvidia") {
    const ids = parseGpuIds(gpuIds);
    if (ids.length) {
      out.deployDevices = [{ driver: "nvidia", deviceIds: ids, capabilities: ["gpu"] }];
      out.cliGpus = `device=${ids.join(",")}`;
    } else {
      out.deployDevices = [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }];
      out.cliGpus = "all";
    }
  } else if (v === "amd") {
    out.devices = [...AMD_DEVICES];
    out.deviceCgroupRules = [...AMD_DEVICE_CGROUP_RULES];
  }
  return out;
}

export default { GPU_VENDORS, AMD_DEVICES, AMD_DEVICE_CGROUP_RULES, parseGpuIds, gpuTemplate };
