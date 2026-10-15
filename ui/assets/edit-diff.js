// ui/assets/edit-diff.js — the config editor's change model.
//
// ONE place decides both what the "pending changes" list shows and what a save
// sends, so the two can never disagree.
//
// The rule that matters here: an ABSENT value (undefined / null / "" / blanks)
// means "no value at all", so "nothing → nothing" is NOT a change. Without that
// rule an unreadable config (every value absent) produced a list of phantom
// changes the moment the editor opened — and one click on Save would have tried
// to write them into a perfectly good config file.
//
// A field the user EMPTIED that had a value is a different thing: it is listed as
// a change, but it is not sent. The config writer rewrites a flag's value; it
// cannot remove the flag, so an empty value is not a writable edit. Reporting it
// (rather than silently dropping it) is what keeps "you cleared this" and "there
// was nothing there" distinguishable.

export function isAbsent(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

// baseline: { key: storedValue }   raw: { key: inputValue }   types: { key: "number"|"text"|… }
// → {
//     items:   [{ key, old, next }]  — what "pending changes" lists
//     cleared: [{ key, old }]        — emptied fields that HAD a value (listed, not sent)
//     payload: { key: value }        — exactly what a save sends
//   }
export function editDiff(baseline = {}, raw = {}, types = {}) {
  const items = [];
  const cleared = [];
  const payload = {};

  for (const [key, value] of Object.entries(raw)) {
    const had = !isAbsent(baseline[key]);
    const has = !isAbsent(value);
    // Nothing on either side → nothing to say. (The phantom-diff bug.)
    if (!had && !has) continue;

    const next = has ? (types[key] === "number" ? Number(value) : String(value).trim()) : null;
    // A number input can hold a half-typed value; it is not an edit yet.
    if (has && typeof next === "number" && !Number.isFinite(next)) continue;
    // Same value on both sides → not an edit.
    if (had && has && String(baseline[key]) === String(next)) continue;

    if (!has) {
      cleared.push({ key, old: baseline[key] });
      items.push({ key, old: baseline[key], next: null });
      continue;
    }
    payload[key] = next;
    items.push({ key, old: baseline[key] ?? null, next });
  }

  return { items, cleared, payload };
}

export default { isAbsent, editDiff };
