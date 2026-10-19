// The "version" block's decision, as one pure function so it can be tested.
//
// Why this exists: the update action used to be reachable only when a LOCAL version was
// known. The local version came from the RUNNING server's `/v1/status`, so a stopped
// service made it `null`, the comparison was skipped, and the update row collapsed into
// "latest 0.1.45" with no way to update — even though stopping first is exactly what the
// update pipeline does (`routes/update.js` stops the service as step 3).
//
// The rule now: an UNKNOWN local version is never "up to date". It is "we cannot tell",
// which on a stopped service means "offer the update"; while running it keeps the
// existing "stop the service to update" hint.

export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const RUNNING = new Set(["running", "starting", "stopping", "restarting"]);
const present = (v) => typeof v === "string" && v.trim() !== "";

// → "action-update" | "hint-stop" | "up-to-date" | "latest-only"
export function versionRowPlan({ state, local, latest, checkState } = {}) {
  // No answer from GitHub yet (or it failed): show only what we know.
  if (checkState !== "checked" || !present(latest)) return "latest-only";
  // Known local version that is not behind: nothing to do.
  if (present(local) && compareVersions(latest, local) <= 0) return "up-to-date";
  // Behind — or unknown. A stopped service can update right away; a running one is told
  // to stop first (the pipeline would stop it anyway, but not without the user knowing).
  return RUNNING.has(String(state || "")) ? "hint-stop" : "action-update";
}
