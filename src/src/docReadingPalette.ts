// Mermaid's engine path needs an explicit palette. FlowGraph already follows
// CSS tokens; this keeps sequence/state diagrams in the same paper/night mood.

import type { DocReadingTheme } from "./markdownReader/types";
import type { TerminalPalette } from "./terminalThemes";

const PAPER: TerminalPalette = {
  xterm: {
    background: "#f7f3e8",
    foreground: "#3a342b",
    cursor: "#7a5c3e",
    cursorAccent: "#f7f3e8",
    selectionBackground: "#7a5c3e33",
    black: "#3a342b",
    red: "#a33b3b",
    green: "#4e7a46",
    yellow: "#99702c",
    blue: "#3f6c9e",
    magenta: "#8a4f7d",
    cyan: "#3f7a7a",
    white: "#d8d0c0",
    brightBlack: "#6b6253",
    brightRed: "#c14f4f",
    brightGreen: "#5f8f55",
    brightYellow: "#b88a3e",
    brightBlue: "#5285b8",
    brightMagenta: "#a56698",
    brightCyan: "#4f9494",
    brightWhite: "#fbf8f0",
  },
  workspace: {
    idleBackground: "#f7f3e8",
    raisedBackground: "#efe8d8",
    codeBackground: "#efe8d8",
    border: "#ddd2bd",
    mutedForeground: "#7c7263",
    headingForeground: "#241f18",
    scrollbar: "rgba(60, 50, 35, 0.22)",
  },
};

const NIGHT: TerminalPalette = {
  xterm: {
    background: "#1b1f27",
    foreground: "#d8d3c8",
    cursor: "#c9b48f",
    cursorAccent: "#1b1f27",
    selectionBackground: "#c9b48f33",
    black: "#2a2f3a",
    red: "#d77a7a",
    green: "#8fbf8f",
    yellow: "#d6b46a",
    blue: "#8ab4d8",
    magenta: "#c79ad6",
    cyan: "#7fc4c4",
    white: "#d8d3c8",
    brightBlack: "#464e5c",
    brightRed: "#e89595",
    brightGreen: "#a8d6a8",
    brightYellow: "#e8c98a",
    brightBlue: "#a4c8e8",
    brightMagenta: "#dcb4e8",
    brightCyan: "#98d8d8",
    brightWhite: "#f1ede4",
  },
  workspace: {
    idleBackground: "#1b1f27",
    raisedBackground: "#222833",
    codeBackground: "#151922",
    border: "#2f3642",
    mutedForeground: "#8e95a3",
    headingForeground: "#f1ede4",
    scrollbar: "rgba(240, 235, 220, 0.24)",
  },
};

export function getDocReadingPalette(theme: DocReadingTheme): TerminalPalette {
  return theme === "paper" ? PAPER : NIGHT;
}
