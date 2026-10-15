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
export const CLIPBOARD_LEGACY = "legacy";
export const CLIPBOARD_NONE = "none";

// `hostWrite` / `browserWrite` / `legacyWrite` are injected so the fallback chain
// is testable and so a caller can supply only the paths it actually has. The
// order matters: the host capability is the app's intended path, the async
// browser API is the modern-but-permission-gated one, and the legacy Selection
// command is the one that does NOT need the clipboard-write permission.
export async function copyToClipboard(text, { hostWrite, browserWrite, legacyWrite } = {}) {
  const value = String(text ?? "");
  if (!value) return { ok: false, via: CLIPBOARD_NONE, error: "empty" };

  const failures = [];
  const attempts = [
    [CLIPBOARD_HOST, hostWrite],
    [CLIPBOARD_BROWSER, browserWrite],
    [CLIPBOARD_LEGACY, legacyWrite],
  ];
  for (const [via, write] of attempts) {
    if (typeof write !== "function") continue;
    try {
      await write(value);
      return { ok: true, via, error: null };
    } catch (e) {
      failures.push(`${via}: ${e?.message || e}`);
    }
  }
  return { ok: false, via: CLIPBOARD_NONE, error: failures.join(" | ") || "no clipboard path available" };
}

export default { copyToClipboard, CLIPBOARD_HOST, CLIPBOARD_BROWSER, CLIPBOARD_LEGACY, CLIPBOARD_NONE };
