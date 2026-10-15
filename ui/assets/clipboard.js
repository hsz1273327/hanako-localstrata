// ui/assets/clipboard.js — writing to the clipboard, with an honest result.
//
// Two paths exist and they are NOT equivalent:
//   * the HOST capability — `hana.clipboard.writeText`, backed by the
//     `app/ui.clipboard-write` grant — is the intended one. A card runs in a
//     sandboxed iframe, so the browser's own clipboard API is usually
//     unavailable there.
//   * `navigator.clipboard` is therefore a FALLBACK, not the primary.
//
// A copy that does nothing is the worst possible outcome, so the result carries
// WHY it failed: the caller can then tell "this app was never granted the
// capability" (the user can fix that in the host) apart from "the grant exists
// but the environment refused the write" (a different problem entirely).

export const CLIPBOARD_HOST = "host";
export const CLIPBOARD_BROWSER = "browser";
export const CLIPBOARD_NONE = "none";

// `hostWrite` / `browserWrite` are injected so the fallback chain is testable and
// so a caller can supply only the paths it actually has.
export async function copyToClipboard(text, { hostWrite, browserWrite } = {}) {
  const value = String(text ?? "");
  if (!value) return { ok: false, via: CLIPBOARD_NONE, error: "empty" };

  const failures = [];
  if (typeof hostWrite === "function") {
    try {
      await hostWrite(value);
      return { ok: true, via: CLIPBOARD_HOST, error: null };
    } catch (e) {
      failures.push(`host: ${e?.message || e}`);
    }
  }
  if (typeof browserWrite === "function") {
    try {
      await browserWrite(value);
      return { ok: true, via: CLIPBOARD_BROWSER, error: null };
    } catch (e) {
      failures.push(`browser: ${e?.message || e}`);
    }
  }
  return { ok: false, via: CLIPBOARD_NONE, error: failures.join(" | ") || "no clipboard path available" };
}

export default { copyToClipboard, CLIPBOARD_HOST, CLIPBOARD_BROWSER, CLIPBOARD_NONE };
