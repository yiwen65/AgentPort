// Shared Shiki theme names for fenced code and the CodeMirror editor. This
// module stays free of Shiki runtime imports so both lazy and eager
// consumers can resolve a theme name synchronously.

import type { DocReadingTheme } from "./types";

export type CodeThemeName =
  | "github-light-default"
  | "github-dark-default"
  | "min-light"
  | "vitesse-dark";

export function codeThemeFor(
  readingTheme: DocReadingTheme,
  effective: "light" | "dark",
): CodeThemeName {
  if (readingTheme === "paper") return "min-light";
  if (readingTheme === "night") return "vitesse-dark";
  return effective === "dark" ? "github-dark-default" : "github-light-default";
}
