// Which model a setup run installs — and the two numbers that decide it.
//
// The catalog mirrors setup.py's `MODELS` / `FAMILIES` (the numbers are copied, not
// re-derived: they are setup's policy and they move with it). Two very different
// numbers are involved, and keeping them apart is the whole point of this file:
//
//   * `ramGiB` — what the machine can actually use. It is THE SAME NUMBER setup.py
//     uses: `ram_gb()` (setup.py:423) reads MemTotal on Linux and
//     GlobalMemoryStatusEx on Windows. Feasibility ("can this size run here?") is
//     judged on it, so our selectable set can never contradict setup's own
//     "needs 62 GB of RAM, you have 91" note.
//   * `nominalGiB` — what the box was sold as (32/48/64/96/128…). It decides the
//     TIER, and the tier decides the DEFAULT pick, because docs/MODELS.md's table is
//     written in nominal capacities ("96 GB or more"). A 96 GB machine reports
//     ~91 GiB of MemTotal (firmware, iGPU carve-out, ECC), so comparing 91 against
//     the table's "96" leaves it in the 64–96 gap forever — which is exactly how an
//     IQ3_S box got a setup run that recommended IQ3_XXS instead.
//
// Splitting the two jobs is what makes both honest: feasibility stays on the number
// setup uses (no drift, no false promises), and the *default* follows the hardware
// the user bought (a 96 GB machine is offered IQ3_S, as the docs say).
//
// Measured on this machine: MemTotal 95_581_796 kB = 91.1 GiB, nominal 96 GB.

// What a box is actually sold as. Rounding MemTotal UP to the nearest of these is
// robust against the usual reservations: 91.1 → 96, 62.4 → 64, 46.9 → 48,
// 123.0 → 128, 185 → 192, 247 → 256. It never merges two standard capacities.
export const STANDARD_CAPACITIES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

// The RAM a machine can really use, in GiB — setup.py's `ram_gb()` equivalent.
export function usableRamGiB(totalBytes) {
  return Number(totalBytes) / 2 ** 30;
}

// The capacity the box was sold as, in GB (up to the next standard size).
export function nominalCapacityGiB(memGiB) {
  const gb = Number(memGiB) || 0;
  for (const c of STANDARD_CAPACITIES) if (gb <= c) return c;
  return STANDARD_CAPACITIES[STANDARD_CAPACITIES.length - 1];
}

// docs/MODELS.md "Pick by RAM": 32 / 48 / 64 / "96 GB or more". `below` is a box
// under 32 GB (the Coder is not certain there, so nothing is recommended).
export function tierKey(memGiB) {
  const nominal = nominalCapacityGiB(memGiB);
  if (nominal < 32) return "below";
  if (nominal < 48) return "32";
  if (nominal < 64) return "48";
  if (nominal < 96) return "64";
  return "96";
}

// The catalog, in setup.py's order (that order is the menu order, and it is what
// the sizes are listed as there). `families` is the set of releases that ship this
// size; setup.py defaults it to ("qwen", "swift") when absent.
export const FAMILIES = [
  { key: "qwen", name: "qwen3.8-flash-next", tag: "", title: "Qwen3.8-Flash-Next" },
  { key: "swift", name: "swift-1.5", tag: "swift-", title: "Swift 1.5" },
  { key: "coder", name: "qwen3.8-flash-next-coder", tag: "coder-", title: "Qwen3.8-Flash-Next Coder" },
  { key: "unsloth", name: "qwen3.8-flash-next-unsloth", tag: "unsloth-", title: "Qwen3.8-Flash-Next (Unsloth)" },
];

export const MODELS = {
  Q2_0: { ramGiB: 48, arenaGiB: 34.0, families: ["qwen"] },
  IQ2_XS: { ramGiB: 48, arenaGiB: 35.5 },
  IQ3_XXS: { ramGiB: 60, arenaGiB: 42.9 },
  IQ3_S: { ramGiB: 62, arenaGiB: 50.3, families: ["qwen"] },
  IQ1_M: { ramGiB: 32, arenaGiB: 23.4, families: ["coder"] },
  "UD-Q4_K_XL": { ramGiB: 48, arenaGiB: 77.0, families: ["unsloth"], budget: true, nvidiaOnly: true, experimental: true },
  "UD-IQ4_XS": { ramGiB: 48, arenaGiB: 59.5, families: ["unsloth"], budget: true },
};

// setup.py's menu order.
export const MODEL_ORDER = ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S", "IQ1_M", "UD-Q4_K_XL", "UD-IQ4_XS"];

export const MODEL_FAMILIES_DEFAULT = ["qwen", "swift"];
export function modelFamilies(model) {
  return MODELS[model]?.families || MODEL_FAMILIES_DEFAULT;
}

// The family a size is chosen from when the user does not pick one: its first
// release (qwen for the shared sizes, coder for the Coder release, …). Only a
// single-family size is PINNED to it — a size that ships in qwen and swift is left
// to setup's own family menu (which prefers Swift on Strix Halo, setup.py:4956).
export function defaultFamily(model) {
  return modelFamilies(model)[0];
}

// ── Feasibility: setup.py's own conditions (only the RAM half is ours to mirror) ──

// setup.py:3255 — the RAM beside the experts: the OS, the engine's buffers, the server.
export const LOW_RAM_HEADROOM_GIB = 10;

export function lowRamNeeded(model, ramGiB) {
  const m = MODELS[model];
  return !!m && ramGiB < m.arenaGiB + LOW_RAM_HEADROOM_GIB;
}

// setup.py:3295 — in the low-RAM mode the experts the GPU does not hold fit the RAM
// left beside the rest (as file cache).
export function lowRamFits(model, ramGiB, vramGiB = 0) {
  const m = MODELS[model];
  if (!m) return false;
  return ramGiB - 6 + Math.max(0, (Number(vramGiB) || 0) - 5) >= m.arenaGiB;
}

// → { ok, reason } where reason is one of:
//   "fits"       — the RAM holds the experts (setup's plain path)
//   "lowRam"     — too big for the RAM alone, but the low-RAM mode makes it work
//   "needsRam"   — not enough RAM, and the low-RAM mode does not save it
//   "nvidiaOnly" — an NVIDIA-only size on an AMD card (the HIP engine has no
//                  prompt kernels for it, setup.py:4998/confirm_risk)
//   "unknown"
export function feasibility(model, { ramGiB = 0, vramGiB = 0, hip = false } = {}) {
  const m = MODELS[model];
  if (!m) return { ok: false, reason: "unknown" };
  if (hip && m.nvidiaOnly) return { ok: false, reason: "nvidiaOnly" };
  if (ramGiB >= m.ramGiB) return { ok: true, reason: "fits" };
  // The budget sizes (Unsloth's) have no low-RAM variant — no experts.bin to map
  // (setup.py:4990), so a short RAM box cannot run them at all.
  if (m.budget) return { ok: false, reason: "needsRam" };
  if (lowRamNeeded(model, ramGiB) && lowRamFits(model, ramGiB, vramGiB)) return { ok: true, reason: "lowRam" };
  return { ok: false, reason: "needsRam" };
}

// ── The default pick: the docs' table, then the best that still fits ────────────

// docs/MODELS.md "Pick by RAM" (and README's table):
//   32 GB  → the Coder (it is the only one that fits a plain 32 GB box)
//   48 GB  → IQ2_XS (or Q2_0, the fastest)
//   64 GB  → IQ2_XS, with IQ3_XXS / IQ3_S selectable
//   96 GB+ → IQ3_S
const TIER_PICK = { "32": "IQ1_M", "48": "IQ2_XS", "64": "IQ2_XS", "96": "IQ3_S", below: null };

// When the tier's pick cannot run (a 32 GB box whose RAM holds nothing bigger, an
// AMD card for an NVIDIA-only size), fall back to the best size that can, best
// quality first and the Coder last (it keeps half the experts, docs/MODELS.md).
const FALLBACK_ORDER = ["IQ3_S", "IQ3_XXS", "IQ2_XS", "UD-IQ4_XS", "Q2_0", "UD-Q4_K_XL", "IQ1_M"];

export function recommend(hw = {}) {
  const tier = tierKey(hw.ramGiB || 0);
  const pick = TIER_PICK[tier];
  if (pick && feasibility(pick, hw).ok) return { model: pick, tier, source: "tier" };
  const ok = MODEL_ORDER.filter((m) => feasibility(m, hw).ok);
  // docs/MODELS.md: "For general use, or whenever your RAM allows, take a full
  // model" — the Coder keeps half the experts, so it is the answer for a 32 GB box
  // (the tier pick above) and the last resort below that, never a fallback.
  const isCoder = (m) => modelFamilies(m).includes("coder");
  const fits = ok.filter((m) => !isCoder(m) && feasibility(m, hw).reason === "fits");
  const byPref = FALLBACK_ORDER.filter((m) => fits.includes(m));
  if (byPref.length) return { model: byPref[0], tier, source: "fallback" };
  // Nothing fits outright: the low-RAM mode is the way, and the size that strains
  // the RAM least (smallest arena) is the one to offer.
  const low = ok
    .filter((m) => !isCoder(m) && feasibility(m, hw).reason === "lowRam")
    .sort((a, b) => MODELS[a].arenaGiB - MODELS[b].arenaGiB);
  if (low.length) return { model: low[0], tier, source: "lowRam" };
  const any = FALLBACK_ORDER.find((m) => ok.includes(m));
  return { model: any || null, tier, source: any ? "fallback" : "none" };
}

// `qwen3.8-flash-next-iq3_s` → { family: "qwen", model: "IQ3_S" }; setup.py:5454
// writes `<family name>-<model lowercased>` (no tag). The longer family names are
// prefixes of the plain one, so the longest must be tried first.
export function parseModelName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return null;
  const families = [...FAMILIES].sort((a, b) => b.name.length - a.name.length);
  for (const f of families) {
    if (!s.startsWith(`${f.name}-`)) continue;
    const rest = s.slice(f.name.length + 1);
    for (const model of MODEL_ORDER) {
      if (rest === model.toLowerCase() && modelFamilies(model).includes(f.key)) return { family: f.key, model };
    }
  }
  return null;
}

// The whole answer the panel needs, in one payload: the machine's two numbers, the
// tier, every size with its verdict, and which one is recommended. `current` comes
// from the config's own `model_name` so the dialog can offer "keep the current one"
// without asking the server twice.
export function setupModelPlan({ memGiB = 0, vramGiB = 0, hip = false, currentName = "" } = {}) {
  const ramGiB = Math.round(Number(memGiB) * 10) / 10;
  const hw = { ramGiB: Number(memGiB) || 0, vramGiB, hip };
  const nominalGiB = nominalCapacityGiB(hw.ramGiB);
  const chosen = recommend(hw);
  const current = parseModelName(currentName);
  const models = [];
  for (const family of FAMILIES) {
    for (const model of MODEL_ORDER) {
      if (!modelFamilies(model).includes(family.key)) continue;
      const f = feasibility(model, hw);
      models.push({
        family: family.key,
        familyTitle: family.title,
        model,
        ramGiB: MODELS[model].ramGiB,
        ok: f.ok,
        reason: f.reason,
        recommended: chosen.model === model && f.ok,
        experimental: !!MODELS[model].experimental,
        nvidiaOnly: !!MODELS[model].nvidiaOnly,
      });
    }
  }
  return {
    ram: { usableGiB: ramGiB, nominalGiB, tier: chosen.tier },
    vramGiB: Number(vramGiB) || 0,
    hip: !!hip,
    models,
    recommended: chosen.model
      ? { family: defaultFamily(chosen.model), model: chosen.model, source: chosen.source }
      : null,
    current: current || null,
  };
}
