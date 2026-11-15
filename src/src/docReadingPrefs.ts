// Reading-surface preferences. Like the document font scale these are UI
// preferences (not device data), so they live in localStorage and apply to
// every device's viewer.

import { setState } from "./store";
import type { DocReadingTheme } from "./markdownReader/types";

export type { DocReadingTheme } from "./markdownReader/types";

export const DOC_READING_THEME_STORAGE_KEY = "agentport-doc-reading-theme";
export const DOC_CODE_LINE_NUMBERS_STORAGE_KEY = "agentport-doc-code-line-numbers";
export const DOC_CODE_WRAP_STORAGE_KEY = "agentport-doc-code-wrap";

const THEMES: DocReadingTheme[] = ["terminal", "paper", "night"];

function readTheme(): DocReadingTheme {
  try {
    const raw = window.localStorage.getItem(DOC_READING_THEME_STORAGE_KEY);
    return THEMES.includes(raw as DocReadingTheme) ? (raw as DocReadingTheme) : "terminal";
  } catch {
    return "terminal";
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences still apply for this run when WebView storage is unavailable.
  }
}

/** Restores every reading preference into the store. */
export function restoreDocReadingPrefs(): void {
  setState({
    docReadingTheme: readTheme(),
    docCodeLineNumbers: readBoolean(DOC_CODE_LINE_NUMBERS_STORAGE_KEY, false),
    docCodeWrap: readBoolean(DOC_CODE_WRAP_STORAGE_KEY, true),
  });
}

/** Startup hook, called next to initFontZoom(). */
export function initDocReadingPrefs(): void {
  restoreDocReadingPrefs();
}

export function setDocReadingTheme(theme: DocReadingTheme): void {
  setState({ docReadingTheme: theme });
  persist(DOC_READING_THEME_STORAGE_KEY, theme);
}

export function setDocCodeLineNumbers(value: boolean): void {
  setState({ docCodeLineNumbers: value });
  persist(DOC_CODE_LINE_NUMBERS_STORAGE_KEY, value ? "1" : "0");
}

export function setDocCodeWrap(value: boolean): void {
  setState({ docCodeWrap: value });
  persist(DOC_CODE_WRAP_STORAGE_KEY, value ? "1" : "0");
}
