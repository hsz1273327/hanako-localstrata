// The default name for the "当前设置备份为" field.
//
// It is a real VALUE, not a placeholder: the field opens on a name that works, so
// pressing 运行 setup… backs the current settings up without anyone typing. Clearing
// the field is how the user says "no backup" (that behaviour is unchanged).
//
// The name must satisfy the shape the config picker lists
// (`^strata-[A-Za-z0-9._-]+\.json$`, lib/deployer/common.js `listConfigFiles`),
// because a backup nobody can select is useless. A hyphen is inside that character
// class, so both forms below are valid.
//
// Collision: a date alone is right until the second run of the same day, and
// "the target already exists" stays a hard refusal (a file the user may care about
// is never replaced). So the default is chosen from what is already there — the
// date, or the date plus the time when the date is taken — the field shows a name
// that works, and nothing existing is ever touched or renamed.
const pad = (n) => String(n).padStart(2, "0");

function stamps(now) {
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  return {
    day: `${y}${m}${d}`,
    minute: `${y}${m}${d}-${pad(now.getHours())}${pad(now.getMinutes())}`,
  };
}

export function backupDefaultName(current, { now = new Date(), existing = [] } = {}) {
  const base = String(current || "").trim().replace(/\.json$/, "");
  if (!base) return ""; // nothing selected: there is nothing to back up
  const taken = new Set((Array.isArray(existing) ? existing : []).map((n) => String(n).trim()));
  const { day, minute } = stamps(now);
  const byDay = `${base}-${day}.json`;
  if (!taken.has(byDay)) return byDay;
  // The day already has one: the time makes it distinct. If even that is taken,
  // this is still the name we offer — the refusal (and the dialog's inline error)
  // says so out loud instead of inventing a suffix.
  return `${base}-${minute}.json`;
}

export default { backupDefaultName };
