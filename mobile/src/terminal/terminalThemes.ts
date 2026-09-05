import type { ITheme } from "@xterm/xterm";

export const MOBILE_TERMINAL_THEME_IDS = [
  "one",
  "cupertino",
  "graphite",
  "aurora",
  "ember",
  "sakura",
] as const;

export type MobileTerminalThemeId = (typeof MOBILE_TERMINAL_THEME_IDS)[number];

export const MOBILE_TERMINAL_THEME_MODES = ["dark", "light"] as const;

export type MobileTerminalThemeMode = (typeof MOBILE_TERMINAL_THEME_MODES)[number];

export const MOBILE_TERMINAL_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const REQUIRED_XTERM_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  ...MOBILE_TERMINAL_ANSI_KEYS,
] as const;

type RequiredXtermKey = (typeof REQUIRED_XTERM_KEYS)[number];
export type CompleteMobileTerminalXtermTheme = Readonly<
  ITheme & Required<Pick<ITheme, RequiredXtermKey>>
>;

export interface MobileTerminalWorkspacePalette {
  /** Surface shown while no Session is active. */
  readonly idleBackground: string;
  /** One subtle elevation step for timeline cards and document diagrams. */
  readonly raisedBackground: string;
  /** Recessed monospace/code surface. */
  readonly codeBackground: string;
  readonly border: string;
  readonly mutedForeground: string;
  readonly headingForeground: string;
  readonly scrollbar: string;
}

export interface MobileTerminalPalette {
  readonly xterm: CompleteMobileTerminalXtermTheme;
  readonly workspace: MobileTerminalWorkspacePalette;
}

export interface MobileTerminalThemeDefinition {
  readonly id: MobileTerminalThemeId;
  readonly dark: MobileTerminalPalette;
  readonly light: MobileTerminalPalette;
}

function palette(
  xterm: CompleteMobileTerminalXtermTheme,
  workspace: MobileTerminalWorkspacePalette,
): MobileTerminalPalette {
  return { xterm, workspace };
}

export const MOBILE_TERMINAL_THEMES: Readonly<Record<MobileTerminalThemeId, MobileTerminalThemeDefinition>> = {
  one: {
    id: "one",
    dark: palette(
      {
        // Keep the shipped One Dark Pro mapping byte-for-byte compatible.
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
      },
      {
        idleBackground: "#282c34",
        raisedBackground: "#303640",
        codeBackground: "#21252b",
        border: "#414754",
        mutedForeground: "#8f96a3",
        headingForeground: "#e5e9f0",
        scrollbar: "rgba(243, 245, 251, 0.28)",
      },
    ),
    light: palette(
      {
        // Keep the shipped One Light mapping byte-for-byte compatible.
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
      },
      {
        idleBackground: "#f5f5f5",
        raisedBackground: "#ffffff",
        codeBackground: "#f0f1f3",
        border: "#d9dce1",
        mutedForeground: "#5f626b",
        headingForeground: "#20222a",
        scrollbar: "rgba(17, 18, 23, 0.12)",
      },
    ),
  },
  cupertino: {
    id: "cupertino",
    dark: palette(
      {
        background: "#1c1c1e",
        foreground: "#f2f2f7",
        cursor: "#0a84ff",
        cursorAccent: "#1c1c1e",
        selectionBackground: "#0a84ff42",
        selectionInactiveBackground: "#8e8e932e",
        black: "#4a4a4f",
        red: "#ff453a",
        green: "#30d158",
        yellow: "#ffd60a",
        blue: "#0a84ff",
        magenta: "#bf5af2",
        cyan: "#64d2ff",
        white: "#f2f2f7",
        brightBlack: "#636366",
        brightRed: "#ff6961",
        brightGreen: "#4be070",
        brightYellow: "#ffe45e",
        brightBlue: "#409cff",
        brightMagenta: "#da8fff",
        brightCyan: "#70e1f5",
        brightWhite: "#ffffff",
      },
      {
        idleBackground: "#1c1c1e",
        raisedBackground: "#27272a",
        codeBackground: "#141416",
        border: "#3a3a3c",
        mutedForeground: "#a9a9af",
        headingForeground: "#ffffff",
        scrollbar: "rgba(242, 242, 247, 0.28)",
      },
    ),
    light: palette(
      {
        background: "#fbfbfd",
        foreground: "#1d1d1f",
        cursor: "#0066cc",
        cursorAccent: "#ffffff",
        selectionBackground: "#007aff2e",
        selectionInactiveBackground: "#8e8e9326",
        black: "#1d1d1f",
        red: "#c9342f",
        green: "#167a3f",
        yellow: "#895c00",
        blue: "#0066cc",
        magenta: "#963dad",
        cyan: "#00758a",
        white: "#424245",
        brightBlack: "#4f4f54",
        brightRed: "#c62b26",
        brightGreen: "#13783b",
        brightYellow: "#825600",
        brightBlue: "#005fbd",
        brightMagenta: "#8c36a4",
        brightCyan: "#006b80",
        brightWhite: "#202124",
      },
      {
        idleBackground: "#f4f4f7",
        raisedBackground: "#ffffff",
        codeBackground: "#f2f2f7",
        border: "#d8d8dc",
        mutedForeground: "#5f6066",
        headingForeground: "#111113",
        scrollbar: "rgba(29, 29, 31, 0.16)",
      },
    ),
  },
  graphite: {
    id: "graphite",
    dark: palette(
      {
        background: "#0d0d0e",
        foreground: "#ededed",
        cursor: "#ffffff",
        cursorAccent: "#0d0d0e",
        selectionBackground: "#ffffff2e",
        selectionInactiveBackground: "#a1a1aa24",
        black: "#3f3f46",
        red: "#ef6f6c",
        green: "#4cc38a",
        yellow: "#f5d90a",
        blue: "#5b9cf6",
        magenta: "#ab7ad5",
        cyan: "#3bc9c4",
        white: "#dedee3",
        brightBlack: "#5b5b64",
        brightRed: "#ff8b88",
        brightGreen: "#62d49a",
        brightYellow: "#ffe45c",
        brightBlue: "#78b2ff",
        brightMagenta: "#c59aeb",
        brightCyan: "#65ddd7",
        brightWhite: "#ffffff",
      },
      {
        idleBackground: "#0d0d0e",
        raisedBackground: "#18181a",
        codeBackground: "#050506",
        border: "#2c2c2f",
        mutedForeground: "#a1a1aa",
        headingForeground: "#ffffff",
        scrollbar: "rgba(237, 237, 237, 0.26)",
      },
    ),
    light: palette(
      {
        background: "#ffffff",
        foreground: "#18181b",
        cursor: "#18181b",
        cursorAccent: "#ffffff",
        selectionBackground: "#18181b24",
        selectionInactiveBackground: "#71717a1f",
        black: "#18181b",
        red: "#c62a2f",
        green: "#18794e",
        yellow: "#8a5a00",
        blue: "#245cc4",
        magenta: "#793aaf",
        cyan: "#0e7490",
        white: "#3f3f46",
        brightBlack: "#52525b",
        brightRed: "#d13438",
        brightGreen: "#1f8556",
        brightYellow: "#9a6500",
        brightBlue: "#2f66ce",
        brightMagenta: "#8647b8",
        brightCyan: "#0b7f9d",
        brightWhite: "#27272a",
      },
      {
        idleBackground: "#f7f7f7",
        raisedBackground: "#fafafa",
        codeBackground: "#f4f4f5",
        border: "#e4e4e7",
        mutedForeground: "#5f5f66",
        headingForeground: "#09090b",
        scrollbar: "rgba(24, 24, 27, 0.16)",
      },
    ),
  },
  aurora: {
    id: "aurora",
    dark: palette(
      {
        background: "#0d1321",
        foreground: "#dce7f7",
        cursor: "#67e8f9",
        cursorAccent: "#0d1321",
        selectionBackground: "#6366f147",
        selectionInactiveBackground: "#64748b2e",
        black: "#38445b",
        red: "#fb7185",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#a78bfa",
        cyan: "#22d3ee",
        white: "#dce7f7",
        brightBlack: "#52617b",
        brightRed: "#ff8fa0",
        brightGreen: "#5ee0ad",
        brightYellow: "#ffd45a",
        brightBlue: "#87bbff",
        brightMagenta: "#c2aafa",
        brightCyan: "#67e8f9",
        brightWhite: "#f8fbff",
      },
      {
        idleBackground: "#0d1321",
        raisedBackground: "#151f33",
        codeBackground: "#080d18",
        border: "#263451",
        mutedForeground: "#9babc3",
        headingForeground: "#f8fbff",
        scrollbar: "rgba(103, 232, 249, 0.24)",
      },
    ),
    light: palette(
      {
        background: "#f7f9ff",
        foreground: "#172033",
        cursor: "#315ecf",
        cursorAccent: "#ffffff",
        selectionBackground: "#4f46e52b",
        selectionInactiveBackground: "#64748b24",
        black: "#172033",
        red: "#c33d58",
        green: "#147d64",
        yellow: "#865b00",
        blue: "#315ecf",
        magenta: "#7846a8",
        cyan: "#087c87",
        white: "#39445a",
        brightBlack: "#505c73",
        brightRed: "#bd334f",
        brightGreen: "#10785f",
        brightYellow: "#7c5100",
        brightBlue: "#2857c2",
        brightMagenta: "#713b9f",
        brightCyan: "#067681",
        brightWhite: "#20293c",
      },
      {
        idleBackground: "#eef2fb",
        raisedBackground: "#ffffff",
        codeBackground: "#edf1fb",
        border: "#d8deec",
        mutedForeground: "#59657a",
        headingForeground: "#10182a",
        scrollbar: "rgba(49, 94, 207, 0.18)",
      },
    ),
  },
  ember: {
    id: "ember",
    dark: palette(
      {
        background: "#211814",
        foreground: "#f4dfd0",
        cursor: "#f2b84b",
        cursorAccent: "#211814",
        selectionBackground: "#d9774552",
        selectionInactiveBackground: "#a17c682e",
        black: "#55443c",
        red: "#ff7a6b",
        green: "#9ccf7d",
        yellow: "#f2b84b",
        blue: "#72a7e8",
        magenta: "#d98cb3",
        cyan: "#71c4b2",
        white: "#f4dfd0",
        brightBlack: "#6b574d",
        brightRed: "#ff9588",
        brightGreen: "#b1df94",
        brightYellow: "#ffd073",
        brightBlue: "#91bdf0",
        brightMagenta: "#e5a6c8",
        brightCyan: "#8ed8c7",
        brightWhite: "#fff8f1",
      },
      {
        idleBackground: "#211814",
        raisedBackground: "#2d211b",
        codeBackground: "#17100d",
        border: "#49362d",
        mutedForeground: "#bfa99b",
        headingForeground: "#fff8f1",
        scrollbar: "rgba(242, 184, 75, 0.25)",
      },
    ),
    light: palette(
      {
        background: "#fffaf5",
        foreground: "#3d2a22",
        cursor: "#a55a00",
        cursorAccent: "#ffffff",
        selectionBackground: "#d9774533",
        selectionInactiveBackground: "#9a766326",
        black: "#3d2a22",
        red: "#bd3f37",
        green: "#3f7b3d",
        yellow: "#825700",
        blue: "#365f9d",
        magenta: "#8f466c",
        cyan: "#28756c",
        white: "#594239",
        brightBlack: "#614b42",
        brightRed: "#b83a32",
        brightGreen: "#397638",
        brightYellow: "#7a5000",
        brightBlue: "#305891",
        brightMagenta: "#874064",
        brightCyan: "#246f66",
        brightWhite: "#2f201b",
      },
      {
        idleBackground: "#f8f1ea",
        raisedBackground: "#ffffff",
        codeBackground: "#f8eee6",
        border: "#ead9cc",
        mutedForeground: "#70584c",
        headingForeground: "#2f201b",
        scrollbar: "rgba(130, 87, 0, 0.2)",
      },
    ),
  },
  sakura: {
    id: "sakura",
    dark: palette(
      {
        background: "#211920",
        foreground: "#eadde7",
        cursor: "#f0839b",
        cursorAccent: "#211920",
        selectionBackground: "#d9468f42",
        selectionInactiveBackground: "#9f7d982e",
        black: "#55444f",
        red: "#f0839b",
        green: "#8fc59f",
        yellow: "#ddb866",
        blue: "#86a8e7",
        magenta: "#d99bd6",
        cyan: "#80c4c0",
        white: "#eadde7",
        brightBlack: "#6c5865",
        brightRed: "#fa9aaf",
        brightGreen: "#a5d5b3",
        brightYellow: "#edc97f",
        brightBlue: "#9db9f0",
        brightMagenta: "#e7afe3",
        brightCyan: "#97d7d2",
        brightWhite: "#fff7fc",
      },
      {
        idleBackground: "#211920",
        raisedBackground: "#2e232d",
        codeBackground: "#171116",
        border: "#493947",
        mutedForeground: "#baa9b6",
        headingForeground: "#fff7fc",
        scrollbar: "rgba(240, 131, 155, 0.24)",
      },
    ),
    light: palette(
      {
        background: "#fff9fc",
        foreground: "#3a2735",
        cursor: "#a92f5a",
        cursorAccent: "#ffffff",
        selectionBackground: "#db277733",
        selectionInactiveBackground: "#9f7d9826",
        black: "#3a2735",
        red: "#b7375e",
        green: "#397a57",
        yellow: "#805a00",
        blue: "#3e62a6",
        magenta: "#8c3f88",
        cyan: "#2a7374",
        white: "#57404f",
        brightBlack: "#644e5c",
        brightRed: "#b13259",
        brightGreen: "#347552",
        brightYellow: "#765200",
        brightBlue: "#385b9a",
        brightMagenta: "#843881",
        brightCyan: "#266d6e",
        brightWhite: "#2d1d29",
      },
      {
        idleBackground: "#f8eff5",
        raisedBackground: "#fffefe",
        codeBackground: "#f8edf4",
        border: "#ead8e4",
        mutedForeground: "#765d70",
        headingForeground: "#2d1d29",
        scrollbar: "rgba(140, 63, 136, 0.19)",
      },
    ),
  },
};

export function isMobileTerminalThemeId(value: unknown): value is MobileTerminalThemeId {
  return (
    typeof value === "string" &&
    (MOBILE_TERMINAL_THEME_IDS as readonly string[]).includes(value)
  );
}

export function normalizeMobileTerminalThemeId(value: unknown): MobileTerminalThemeId {
  return isMobileTerminalThemeId(value) ? value : "one";
}

export function getMobileTerminalThemeDefinition(value: unknown): MobileTerminalThemeDefinition {
  return MOBILE_TERMINAL_THEMES[normalizeMobileTerminalThemeId(value)];
}


export function isMobileTerminalThemeMode(value: unknown): value is MobileTerminalThemeMode {
  return (
    typeof value === "string" &&
    (MOBILE_TERMINAL_THEME_MODES as readonly string[]).includes(value)
  );
}

export function normalizeMobileTerminalThemeMode(value: unknown): MobileTerminalThemeMode {
  return isMobileTerminalThemeMode(value) ? value : "dark";
}

export function getMobileTerminalPalette(
  value: unknown,
  mode: unknown,
): MobileTerminalPalette {
  return getMobileTerminalThemeDefinition(value)[normalizeMobileTerminalThemeMode(mode)];
}

export const MOBILE_THEME_MODES = ["light", "dark", "system"] as const;
export type MobileThemeMode = (typeof MOBILE_THEME_MODES)[number];

function normalizeMobileThemeMode(value: unknown): MobileThemeMode {
  return value === "system" || isMobileTerminalThemeMode(value) ? value : "system";
}

export interface MobileTerminalAppearance {
  readonly theme: MobileTerminalThemeId;
  readonly mode: MobileThemeMode;
}

export const DEFAULT_MOBILE_TERMINAL_APPEARANCE: MobileTerminalAppearance = {
  theme: "one",
  mode: "system",
};

export const MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY =
  "agentport-mobile-v2:terminal-appearance";

type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

function availableStorage(): AppearanceStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadMobileTerminalAppearance(
  storage: AppearanceStorage | undefined = availableStorage(),
): MobileTerminalAppearance {
  try {
    const raw = storage?.getItem(MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MOBILE_TERMINAL_APPEARANCE };
    const parsed = JSON.parse(raw) as { theme?: unknown; mode?: unknown };
    return {
      theme: normalizeMobileTerminalThemeId(parsed.theme),
      mode: normalizeMobileThemeMode(parsed.mode),
    };
  } catch {
    return { ...DEFAULT_MOBILE_TERMINAL_APPEARANCE };
  }
}

export function saveMobileTerminalAppearance(
  appearance: MobileTerminalAppearance,
  storage: AppearanceStorage | undefined = availableStorage(),
): void {
  try {
    storage?.setItem(MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY, JSON.stringify({
      theme: normalizeMobileTerminalThemeId(appearance.theme),
      mode: normalizeMobileThemeMode(appearance.mode),
    }));
  } catch {
    // Appearance persistence is best-effort; the live selection still applies.
  }
}

function relativeLuminance(color: string): number {
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

function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

/**
 * Palette aliases used by the terminal and by the app-wide Theme projection.
 * Keep xterm colors exact; semantic text roles account for raised UI surfaces.
 */
export function getMobileTerminalWorkspaceVariables(
  value: unknown,
  modeValue: unknown,
): Readonly<Record<string, string>> {
  const mode = normalizeMobileTerminalThemeMode(modeValue);
  const { xterm, workspace } = getMobileTerminalPalette(value, mode);
  const uiSurfaces = [xterm.background, workspace.raisedBackground, workspace.codeBackground];
  const mutedForeground = uiSurfaces.every((surface) =>
    contrastRatio(workspace.mutedForeground, surface) >= 4.5
  ) ? workspace.mutedForeground : xterm.foreground;
  const semantic = mode === "dark" ? {
    danger: "#ff8b88",
    success: "#78dba0",
    warning: "#ffd166",
  } : {
    danger: "#b4232f",
    success: "#176b42",
    warning: "#6f4b00",
  };
  return {
    "--terminal-bg": xterm.background,
    "--terminal-fg": xterm.foreground,
    "--terminal-idle-bg": workspace.idleBackground,
    "--terminal-panel": workspace.raisedBackground,
    "--terminal-code-bg": workspace.codeBackground,
    "--terminal-border": workspace.border,
    "--terminal-muted": workspace.mutedForeground,
    "--terminal-heading": workspace.headingForeground,
    "--terminal-scrollbar": workspace.scrollbar,
    "--terminal-accent": xterm.blue,
    "--terminal-accent-strong": xterm.brightBlue,
    "--terminal-danger": xterm.red,
    "--terminal-success": xterm.green,
    "--terminal-warning": xterm.yellow,
    "--terminal-selection": xterm.selectionBackground,
    "--terminal-control-border": withAlpha(xterm.foreground, "24"),
    "--terminal-control-fill-start": withAlpha(xterm.foreground, "1a"),
    "--terminal-control-fill-end": withAlpha(xterm.foreground, "08"),
    "--terminal-control-inset": withAlpha(xterm.foreground, "1f"),
    "--terminal-control-active-border": withAlpha(xterm.foreground, "3d"),
    "--terminal-control-active-bg": withAlpha(xterm.foreground, "21"),
    "--terminal-control-active-inset": withAlpha(xterm.foreground, "2e"),
    "--text": workspace.headingForeground,
    "--muted": mutedForeground,
    "--tertiary-text": mutedForeground,
    "--line": workspace.border,
    "--line-soft": workspace.border,
    "--fill": workspace.codeBackground,
    "--fill-strong": workspace.raisedBackground,
    "--accent": xterm.blue,
    "--accent-strong": xterm.brightBlue,
    "--success": semantic.success,
    "--warning": semantic.warning,
    "--danger": semantic.danger,
    "--danger-fill": "#b4232f",
    "--panel": workspace.raisedBackground,
    "--panel-strong": workspace.codeBackground,
    "--nav-glass": workspace.raisedBackground,
    "--content-active": xterm.selectionBackground,
    "--content-active-ring": xterm.blue,
    "--shadow": mode === "dark"
      ? "0 18px 50px rgba(0, 0, 0, 0.38)"
      : "0 18px 50px rgba(17, 18, 23, 0.18)",
  };
}
