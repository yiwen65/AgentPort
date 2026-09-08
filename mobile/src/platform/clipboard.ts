import { invoke, isTauri } from "@tauri-apps/api/core";

/** Read only in response to the user's Paste action, never during rendering.
 * WKWebView's web Clipboard API can reject while presenting a second Paste
 * menu. The installed app uses UIPasteboard via Tauri instead. Native denial
 * must not fall back to WebKit (another prompt or a second read).
 */
export function readClipboardText(): Promise<string> {
  if (isTauri()) return invoke<string>("plugin:clipboard-manager|read_text");
  // Browser-only development still needs the click's synchronous activation.
  if (!navigator.clipboard) return Promise.reject(new Error("Clipboard unavailable"));
  return navigator.clipboard.readText();
}
