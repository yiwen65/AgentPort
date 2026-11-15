// External links are handed to the system browser. The first click asks for
// confirmation; choosing "remember" skips the bubble from then on.

export const EXTERNAL_LINK_CONFIRM_STORAGE_KEY = "agentport-doc-external-link-confirm";

export function shouldConfirmExternalLink(): boolean {
  try {
    return window.localStorage.getItem(EXTERNAL_LINK_CONFIRM_STORAGE_KEY) !== "skip";
  } catch {
    return true;
  }
}

export function rememberExternalLinkChoice(): void {
  try {
    window.localStorage.setItem(EXTERNAL_LINK_CONFIRM_STORAGE_KEY, "skip");
  } catch {
    // Preferences still apply for this run when storage is unavailable.
  }
}

/** Test hook. */
export function resetExternalLinkChoice(): void {
  try {
    window.localStorage.removeItem(EXTERNAL_LINK_CONFIRM_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
