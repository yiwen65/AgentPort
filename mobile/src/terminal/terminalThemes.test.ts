import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_TERMINAL_APPEARANCE,
  getMobileTerminalPalette,
  getMobileTerminalWorkspaceVariables,
  loadMobileTerminalAppearance,
  MOBILE_TERMINAL_ANSI_KEYS,
  MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY,
  MOBILE_TERMINAL_THEME_IDS,
  MOBILE_TERMINAL_THEME_MODES,
  MOBILE_TERMINAL_THEMES,
  normalizeMobileTerminalThemeId,
  normalizeMobileTerminalThemeMode,
  saveMobileTerminalAppearance,
} from "./terminalThemes";

const REQUIRED_XTERM_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  ...MOBILE_TERMINAL_ANSI_KEYS,
] as const;

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

describe("mobile terminal theme catalog", () => {
  beforeEach(() => localStorage.clear());

  it("contains the same six families with complete dark and light xterm palettes", () => {
    expect(MOBILE_TERMINAL_THEME_IDS).toEqual([
      "one",
      "cupertino",
      "graphite",
      "aurora",
      "ember",
      "sakura",
    ]);
    expect(MOBILE_TERMINAL_THEME_MODES).toEqual(["dark", "light"]);

    for (const id of MOBILE_TERMINAL_THEME_IDS) {
      const definition = MOBILE_TERMINAL_THEMES[id];
      expect(definition.id).toBe(id);
      for (const mode of MOBILE_TERMINAL_THEME_MODES) {
        const { xterm, workspace } = definition[mode];
        for (const key of REQUIRED_XTERM_KEYS) {
          expect(xterm[key], `${id}/${mode}/${key}`).toMatch(/^#|^rgb/);
        }
        for (const [key, value] of Object.entries(workspace)) {
          expect(value, `${id}/${mode}/workspace.${key}`).toMatch(/^#|^rgb/);
        }
        expect(contrastRatio(xterm.background, xterm.foreground), `${id}/${mode} foreground`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(xterm.background, workspace.mutedForeground), `${id}/${mode} muted`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(xterm.background, xterm.cursor), `${id}/${mode} cursor`).toBeGreaterThanOrEqual(3);

        const variables = getMobileTerminalWorkspaceVariables(id, mode);
        const uiSurfaces = [xterm.background, workspace.raisedBackground, workspace.codeBackground];
        for (const surface of uiSurfaces) {
          expect(contrastRatio(surface, variables["--muted"]), `${id}/${mode} UI muted`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(surface, variables["--danger"]), `${id}/${mode} UI danger`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(surface, variables["--success"]), `${id}/${mode} UI success`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(surface, variables["--warning"]), `${id}/${mode} UI warning`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(surface, variables["--terminal-accent"]), `${id}/${mode} focus indicator`).toBeGreaterThanOrEqual(3);
        }
        expect(contrastRatio("#ffffff", variables["--danger-fill"]), `${id}/${mode} danger button`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("preserves the desktop One mappings exactly", () => {
    expect(MOBILE_TERMINAL_THEMES.one.dark.xterm).toEqual({
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
    expect(MOBILE_TERMINAL_THEMES.one.light.xterm).toEqual({
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

  it("normalizes unknown values and persists one app-wide appearance", () => {
    expect(normalizeMobileTerminalThemeId("future-theme")).toBe("one");
    expect(normalizeMobileTerminalThemeMode("system")).toBe("dark");
    expect(loadMobileTerminalAppearance()).toEqual(DEFAULT_MOBILE_TERMINAL_APPEARANCE);

    localStorage.setItem(MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY, "not-json");
    expect(loadMobileTerminalAppearance()).toEqual(DEFAULT_MOBILE_TERMINAL_APPEARANCE);

    localStorage.setItem(MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    expect(loadMobileTerminalAppearance()).toEqual({ theme: "aurora", mode: "light" });

    saveMobileTerminalAppearance({ theme: "sakura", mode: "system" });
    expect(loadMobileTerminalAppearance()).toEqual({ theme: "sakura", mode: "system" });
    saveMobileTerminalAppearance({ theme: "sakura", mode: "dark" });
    expect(JSON.parse(localStorage.getItem(MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY)!)).toEqual({ theme: "sakura", mode: "dark" });
  });

  it("derives scoped workspace variables from the same palette as xterm", () => {
    const palette = getMobileTerminalPalette("ember", "light");
    const variables = getMobileTerminalWorkspaceVariables("ember", "light");

    expect(variables["--terminal-bg"]).toBe(palette.xterm.background);
    expect(variables["--terminal-fg"]).toBe(palette.xterm.foreground);
    expect(variables["--terminal-panel"]).toBe(palette.workspace.raisedBackground);
    expect(variables["--terminal-border"]).toBe(palette.workspace.border);
    expect(variables["--terminal-accent"]).toBe(palette.xterm.blue);
    expect(variables["--terminal-danger"]).toBe(palette.xterm.red);
    expect(document.documentElement.style.getPropertyValue("--terminal-bg")).toBe("");
  });
});
