// How many requests may decode at once, by the card's TOTAL VRAM.
//
// The product's tiers (not the engine's): the engine's own window is 8 slots, but on a
// card where the experts mostly run from RAM a batch mostly costs speed, so the tiers cap
// far below that. Total VRAM — not free VRAM — is what decides: the card's size is a
// property of the machine, while free VRAM moves with every request and would make the
// recommendation jump around. The tier is only a guard rail; the warning that comes with
// turning it on carries the real costs.
//
// All numbers are MiB, because "16 GB" cards report 16380 MiB (firmware), so a GiB
// comparison against "> 16" would put them in the next tier up.
export const PARALLEL_OFF = 1; // what "off" writes: nothing, i.e. the engine's default of 1
export const PARALLEL_HARD_MAX = 8; // the engine's own batch window

export function parallelTier(totalMiB) {
  const mib = Number(totalMiB);
  if (!Number.isFinite(mib) || mib <= 0) {
    // No GPU reading (service stopped, nvidia-smi missing): allow it, but on the middle
    // tier and say so. Disabling on a transient read failure would take the feature away
    // for a reason that is not about the machine at all.
    return { tier: "unknown", disabled: false, recommended: 2, max: 3, warn: false };
  }
  if (mib <= 8 * 1024) return { tier: "8", disabled: true, recommended: 0, max: 0, warn: false };
  if (mib <= 12 * 1024) return { tier: "12", disabled: false, recommended: 2, max: 2, warn: true };
  if (mib <= 16 * 1024) return { tier: "16", disabled: false, recommended: 2, max: 3, warn: false };
  if (mib <= 24 * 1024) return { tier: "24", disabled: false, recommended: 3, max: 4, warn: false };
  if (mib <= 32 * 1024) return { tier: "32", disabled: false, recommended: 4, max: 6, warn: false };
  return { tier: "big", disabled: false, recommended: 4, max: PARALLEL_HARD_MAX, warn: false };
}

// What the number field may hold: the engine needs 2 for a batch (1 is "off"), and the
// tier decides the ceiling.
export function parallelBounds(totalMiB) {
  const tier = parallelTier(totalMiB);
  return { min: 2, max: Math.max(2, tier.max), tier };
}

// The value a fresh "on" starts at, clamped into the tier's window.
export function parallelDefault(totalMiB) {
  const { min, max, tier } = parallelBounds(totalMiB);
  if (tier.disabled) return 0;
  return Math.min(max, Math.max(min, tier.recommended || min));
}
