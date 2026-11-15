// Code-editor preferences live in localStorage like the reading-surface
// preferences: they are UI choices shared across every device's viewer.

import { setState } from "../store";
import { EDITOR_THEME_OPTIONS, type EditorThemePref } from "./themePref";

export type { EditorThemePref };

export type EditorIndentWidth = "auto" | 2 | 4 | 8;
export type EditorIndentStyle = "auto" | "spaces" | "tabs";

export interface DocEditorPrefs {
  theme: EditorThemePref;
  indent: EditorIndentWidth;
  indentStyle: EditorIndentStyle;
  wrap: boolean;
  whitespace: boolean;
}

export interface EffectiveIndent {
  width: number;
  useSpaces: boolean;
}

export const DOC_EDITOR_THEME_STORAGE_KEY = "agentport-doc-editor-theme";
export const DOC_EDITOR_INDENT_STORAGE_KEY = "agentport-doc-editor-indent";
export const DOC_EDITOR_INDENT_STYLE_STORAGE_KEY = "agentport-doc-editor-indent-style";
export const DOC_EDITOR_WRAP_STORAGE_KEY = "agentport-doc-editor-wrap";
export const DOC_EDITOR_WHITESPACE_STORAGE_KEY = "agentport-doc-editor-whitespace";

const INDENT_WIDTHS: EditorIndentWidth[] = ["auto", 2, 4, 8];
const INDENT_STYLES: EditorIndentStyle[] = ["auto", "spaces", "tabs"];

function readTheme(): EditorThemePref {
  try {
    const raw = window.localStorage.getItem(DOC_EDITOR_THEME_STORAGE_KEY);
    return EDITOR_THEME_OPTIONS.includes(raw as EditorThemePref)
      ? (raw as EditorThemePref)
      : "follow";
  } catch {
    return "follow";
  }
}

function readIndent(): EditorIndentWidth {
  try {
    const raw = window.localStorage.getItem(DOC_EDITOR_INDENT_STORAGE_KEY);
    const parsed = raw === "auto" ? raw : Number(raw);
    return INDENT_WIDTHS.includes(parsed as EditorIndentWidth)
      ? (parsed as EditorIndentWidth)
      : "auto";
  } catch {
    return "auto";
  }
}

function readIndentStyle(): EditorIndentStyle {
  try {
    const raw = window.localStorage.getItem(DOC_EDITOR_INDENT_STYLE_STORAGE_KEY);
    return INDENT_STYLES.includes(raw as EditorIndentStyle)
      ? (raw as EditorIndentStyle)
      : "auto";
  } catch {
    return "auto";
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

/** Restores every editor preference into the store. */
export function restoreDocEditorPrefs(): void {
  setState({
    docEditorTheme: readTheme(),
    docEditorIndent: readIndent(),
    docEditorIndentStyle: readIndentStyle(),
    docEditorWrap: readBoolean(DOC_EDITOR_WRAP_STORAGE_KEY, false),
    docEditorWhitespace: readBoolean(DOC_EDITOR_WHITESPACE_STORAGE_KEY, false),
  });
}

/** Startup hook, called next to initDocReadingPrefs(). */
export function initDocEditorPrefs(): void {
  restoreDocEditorPrefs();
}

export function setDocEditorTheme(theme: EditorThemePref): void {
  setState({ docEditorTheme: theme });
  persist(DOC_EDITOR_THEME_STORAGE_KEY, theme);
}

export function setDocEditorIndent(indent: EditorIndentWidth): void {
  setState({ docEditorIndent: indent });
  persist(DOC_EDITOR_INDENT_STORAGE_KEY, String(indent));
}

export function setDocEditorIndentStyle(style: EditorIndentStyle): void {
  setState({ docEditorIndentStyle: style });
  persist(DOC_EDITOR_INDENT_STYLE_STORAGE_KEY, style);
}

export function setDocEditorWrap(value: boolean): void {
  setState({ docEditorWrap: value });
  persist(DOC_EDITOR_WRAP_STORAGE_KEY, value ? "1" : "0");
}

export function setDocEditorWhitespace(value: boolean): void {
  setState({ docEditorWhitespace: value });
  persist(DOC_EDITOR_WHITESPACE_STORAGE_KEY, value ? "1" : "0");
}

/** Resolves "auto" to the conventional indent for the detected language. */
export function effectiveIndent(
  prefs: Pick<DocEditorPrefs, "indent" | "indentStyle">,
  language: string | null,
): EffectiveIndent {
  const autoWidth = language === "python" ? 4 : 2;
  const autoSpaces = language === "go" ? false : true;
  return {
    width: prefs.indent === "auto" ? autoWidth : prefs.indent,
    useSpaces: prefs.indentStyle === "auto" ? autoSpaces : prefs.indentStyle === "spaces",
  };
}
