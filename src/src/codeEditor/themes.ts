// CodeMirror themes mirroring the Shiki palettes used by Markdown fences.
// Colors are hand-mapped from the upstream theme token colors; the editor
// chrome consumes app CSS variables so font scale and surfaces stay in sync.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { CodeThemeName } from "../markdownReader/codeThemeName";

export type { EditorThemePref } from "./themePref";
export { EDITOR_THEME_OPTIONS, resolveEditorTheme } from "./themePref";

interface EditorPalette {
  dark: boolean;
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  variable: string;
  type: string;
  constant: string;
  operator: string;
  punctuation: string;
  tag: string;
  attribute: string;
  property: string;
  invalid: string;
  selection: string;
  selectionMatch: string;
  searchMatch: string;
  searchMatchSelected: string;
  activeLine: string;
  gutter: string;
  border: string;
  tooltip: string;
}

const PALETTES: Record<CodeThemeName, EditorPalette> = {
  "github-light-default": {
    dark: false,
    background: "#ffffff",
    foreground: "#1f2328",
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    function: "#8250df",
    variable: "#0550ae",
    type: "#116329",
    constant: "#0550ae",
    operator: "#0550ae",
    punctuation: "#6e7781",
    tag: "#116329",
    attribute: "#0550ae",
    property: "#116329",
    invalid: "#82071e",
    selection: "#0969da33",
    selectionMatch: "#0969da22",
    searchMatch: "#ffdf5d66",
    searchMatchSelected: "#ffb75799",
    activeLine: "#f6f8fa",
    gutter: "#6e7781",
    border: "#d0d7de",
    tooltip: "#ffffff",
  },
  "github-dark-default": {
    dark: true,
    background: "#0d1117",
    foreground: "#e6edf3",
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    function: "#d2a8ff",
    variable: "#79c0ff",
    type: "#7ee787",
    constant: "#79c0ff",
    operator: "#ff7b72",
    punctuation: "#8b949e",
    tag: "#7ee787",
    attribute: "#79c0ff",
    property: "#7ee787",
    invalid: "#ffa198",
    selection: "#3392ff44",
    selectionMatch: "#3392ff2a",
    searchMatch: "#9e6a03aa",
    searchMatchSelected: "#bb8009cc",
    activeLine: "#161b22",
    gutter: "#8b949e",
    border: "#30363d",
    tooltip: "#161b22",
  },
  "min-light": {
    dark: false,
    background: "#ffffff",
    foreground: "#212121",
    comment: "#c2c3c5",
    keyword: "#24292e",
    string: "#2b5581",
    number: "#1976d2",
    function: "#d32f2f",
    variable: "#1976d2",
    type: "#6f42c1",
    constant: "#1976d2",
    operator: "#24292e",
    punctuation: "#d32f2f",
    tag: "#d32f2f",
    attribute: "#6f42c1",
    property: "#d32f2f",
    invalid: "#d32f2f",
    selection: "#1976d233",
    selectionMatch: "#1976d21f",
    searchMatch: "#ffe58f99",
    searchMatchSelected: "#ffc069b3",
    activeLine: "#f6f8fa",
    gutter: "#c2c3c5",
    border: "#e5e7eb",
    tooltip: "#ffffff",
  },
  "vitesse-dark": {
    dark: true,
    background: "#121212",
    foreground: "#dbd7ca",
    comment: "#758575",
    keyword: "#666666",
    string: "#c98a7d",
    number: "#4c9a91",
    function: "#80a665",
    variable: "#c99076",
    type: "#5da994",
    constant: "#c99076",
    operator: "#cb7676",
    punctuation: "#758575",
    tag: "#4d9375",
    attribute: "#bd976a",
    property: "#b8a965",
    invalid: "#bd976a",
    selection: "#4f687e66",
    selectionMatch: "#4f687e3a",
    searchMatch: "#8a6d1f99",
    searchMatchSelected: "#b0892ab3",
    activeLine: "#181818",
    gutter: "#758575",
    border: "#2a2a2a",
    tooltip: "#1b1b1b",
  },
};

function highlightStyle(palette: EditorPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: palette.comment, fontStyle: "italic" },
    {
      tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword],
      color: palette.keyword,
    },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: palette.string },
    { tag: [t.number, t.bool, t.null, t.atom], color: palette.number },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
      color: palette.function,
    },
    { tag: [t.variableName, t.self, t.definition(t.variableName)], color: palette.variable },
    {
      tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
      color: palette.type,
    },
    { tag: [t.constant(t.variableName), t.constant(t.propertyName)], color: palette.constant },
    { tag: [t.operator, t.derefOperator], color: palette.operator },
    { tag: [t.punctuation, t.bracket, t.separator], color: palette.punctuation },
    { tag: [t.tagName, t.angleBracket], color: palette.tag },
    { tag: [t.attributeName], color: palette.attribute },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: palette.property },
    { tag: [t.invalid], color: palette.invalid },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: palette.function, fontWeight: "600" },
    { tag: [t.link, t.url], color: palette.variable, textDecoration: "underline" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "700" },
  ]);
}

function viewTheme(palette: EditorPalette): Extension {
  return EditorView.theme(
    {
      "&": {
        color: palette.foreground,
        backgroundColor: palette.background,
      },
      ".cm-content": {
        caretColor: palette.foreground,
        fontFamily: "var(--font-mono)",
        fontSize: "calc(12px * var(--doc-font-scale, 1))",
        lineHeight: "1.55",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.foreground },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: palette.selection },
      ".cm-activeLine": { backgroundColor: palette.activeLine },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: palette.gutter,
        borderRight: `1px solid ${palette.border}`,
      },
      ".cm-activeLineGutter": { backgroundColor: palette.activeLine, color: palette.foreground },
      ".cm-foldGutter .cm-gutterElement": { color: palette.gutter },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: `1px solid ${palette.border}`,
        color: palette.gutter,
        padding: "0 4px",
      },
      ".cm-selectionMatch": { backgroundColor: palette.selectionMatch },
      ".cm-searchMatch": {
        backgroundColor: palette.searchMatch,
        outline: `1px solid ${palette.border}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: palette.searchMatchSelected,
      },
      ".cm-tooltip": {
        backgroundColor: palette.tooltip,
        border: `1px solid ${palette.border}`,
        color: palette.foreground,
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: palette.selection,
        outline: `1px solid ${palette.operator}`,
      },
    },
    { dark: palette.dark },
  );
}

const cache = new Map<CodeThemeName, Extension>();

export function editorThemeExtensions(name: CodeThemeName): Extension {
  let extension = cache.get(name);
  if (!extension) {
    const palette = PALETTES[name];
    extension = [viewTheme(palette), syntaxHighlighting(highlightStyle(palette))];
    cache.set(name, extension);
  }
  return extension;
}
