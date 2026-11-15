// Pure theme-selection helpers, kept free of CodeMirror imports so the
// document panel can resolve a theme without pulling the editor bundle in.

import { codeThemeFor, type CodeThemeName } from "../markdownReader/codeThemeName";
import type { DocReadingTheme } from "../markdownReader/types";

export type EditorThemePref = "follow" | CodeThemeName;

export const EDITOR_THEME_OPTIONS: readonly EditorThemePref[] = [
  "follow",
  "github-light-default",
  "github-dark-default",
  "min-light",
  "vitesse-dark",
];

export function resolveEditorTheme(
  pref: EditorThemePref,
  readingTheme: DocReadingTheme,
  effective: "light" | "dark",
): CodeThemeName {
  return pref === "follow" ? codeThemeFor(readingTheme, effective) : pref;
}
