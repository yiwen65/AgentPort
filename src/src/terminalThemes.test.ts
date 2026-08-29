// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTerminalThemeCss,
  getTerminalPalette,
  normalizeTerminalThemeId,
  TERMINAL_ANSI_KEYS,
  TERMINAL_THEME_IDS,
  TERMINAL_THEME_MODES,
  TERMINAL_THEMES,
} from "./terminalThemes";

function relativeLuminance(color: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`Expected an opaque six-digit hex color, received ${color}`);
  }
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

const REQUIRED_XTERM_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  ...TERMINAL_ANSI_KEYS,
] as const;

const READABLE_ANSI_KEYS = TERMINAL_ANSI_KEYS.filter(
  (key) => key !== "black" && key !== "brightBlack",
);

describe("terminal theme catalog", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-terminal-theme");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.cssText = "";
  });

  it("contains every confirmed family and both complete mode palettes", () => {
    expect(TERMINAL_THEME_IDS).toEqual([
      "one",
      "cupertino",
      "graphite",
      "aurora",
      "ember",
      "sakura",
    ]);

    for (const id of TERMINAL_THEME_IDS) {
      const definition = TERMINAL_THEMES[id];
      expect(definition.id).toBe(id);
      for (const mode of TERMINAL_THEME_MODES) {
        const { xterm, workspace } = definition[mode];
        for (const key of REQUIRED_XTERM_KEYS) {
          expect(xterm[key], `${id}/${mode}/${key}`).toMatch(/^#|^rgb/);
        }
        for (const [key, value] of Object.entries(workspace)) {
          expect(value, `${id}/${mode}/workspace.${key}`).toMatch(/^#|^rgb/);
        }
      }
    }
  });

  it("preserves the shipped One Dark and One Light xterm mappings", () => {
    expect(TERMINAL_THEMES.one.dark.xterm).toEqual({
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#abb2bf",
      cursorAccent: "#282c34",
      selectionBackground: "#abb2bf30",
      black: "#3f4451",
      red: "#e05561",
      green: "#8cc265",
      yellow: "#d18f52",
      blue: "#4aa5f0",
      magenta: "#c162de",
      cyan: "#42b3c2",
      white: "#d7dae0",
      brightBlack: "#4f5666",
      brightRed: "#ff616e",
      brightGreen: "#a5e075",
      brightYellow: "#f0a45d",
      brightBlue: "#4dc4ff",
      brightMagenta: "#de73ff",
      brightCyan: "#4cd1e0",
      brightWhite: "#e6e6e6",
    });
    expect(TERMINAL_THEMES.one.light.xterm).toEqual({
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      cursorAccent: "#fafafa",
      selectionBackground: "#e5e5e6",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#986801",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#52525b",
      brightBlack: "#4f525e",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#26262c",
    });
  });

  it("meets AA for body text and the new themes' readable ANSI slots", () => {
    for (const id of TERMINAL_THEME_IDS) {
      for (const mode of TERMINAL_THEME_MODES) {
        const { xterm, workspace } = TERMINAL_THEMES[id][mode];
        expect(
          contrastRatio(xterm.background, xterm.foreground),
          `${id}/${mode} foreground`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(xterm.background, workspace.mutedForeground),
          `${id}/${mode} muted foreground`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(xterm.background, workspace.headingForeground),
          `${id}/${mode} heading foreground`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(xterm.background, xterm.cursor),
          `${id}/${mode} cursor visibility`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(xterm.cursor, xterm.cursorAccent),
          `${id}/${mode} block-cursor text`,
        ).toBeGreaterThanOrEqual(4.5);

        // One remains byte-compatible with the shipped mapping. xterm's
        // minimumContrastRatio=4.5 repairs its historic low-contrast ANSI
        // cells at render time. New themes meet that target in source for all
        // text-oriented slots; black/brightBlack remain semantic dim colors.
        if (id !== "one") {
          for (const key of READABLE_ANSI_KEYS) {
            expect(
              contrastRatio(xterm.background, xterm[key]),
              `${id}/${mode}/${key}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it("falls back to One and applies workspace variables without changing app mode", () => {
    document.documentElement.dataset.theme = "light";

    expect(normalizeTerminalThemeId("future-theme")).toBe("one");
    expect(getTerminalPalette("future-theme", "dark")).toBe(TERMINAL_THEMES.one.dark);
    expect(applyTerminalThemeCss(document.documentElement, "aurora", "dark")).toBe("aurora");

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.terminalTheme).toBe("aurora");
    expect(document.documentElement.style.getPropertyValue("--bg-term")).toBe("#0d1321");
    expect(document.documentElement.style.getPropertyValue("--term-text")).toBe("#dce7f7");
    expect(document.documentElement.style.getPropertyValue("--workspace-live")).toBe("#0d1321");
    expect(document.documentElement.style.getPropertyValue("--term-code-bg")).toBe("#080d18");
  });
});
