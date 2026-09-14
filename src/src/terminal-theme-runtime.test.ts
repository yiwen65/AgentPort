// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  setNativeTheme: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ setTheme: runtimeMocks.setNativeTheme }));
vi.mock("./terminals", () => ({
  applyTerminalSettings: runtimeMocks.applyTerminalSettings,
  applyXtermTheme: runtimeMocks.applyXtermTheme,
  attachHandle: vi.fn(),
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  MAX_PERSISTENT_TERMINALS: 6,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import { applyThemeSettings } from "./actions";
import { getState, setState } from "./store";
import type { Settings } from "./types";

const settings: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "system",
  terminalTheme: "aurora",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: false,
  agentOrder: ["shell"],
  agentHidden: [],
  telemetryEnabled: false,
};

let prefersDark = false;

function mediaQuery(query: string): MediaQueryList {
  return {
    matches: query.includes("prefers-color-scheme") ? prefersDark : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe("terminal theme runtime pairing", () => {
  beforeEach(() => {
    prefersDark = false;
    vi.stubGlobal("matchMedia", vi.fn(mediaQuery));
    setState({ settings: { ...settings }, themeEffective: "dark" });
    document.documentElement.style.cssText = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-terminal-theme");
    vi.clearAllMocks();
  });

  afterEach(() => {
    setState({ settings: null });
    document.documentElement.style.cssText = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-terminal-theme");
    vi.unstubAllGlobals();
  });

  it("keeps the selected family while the effective app mode changes", () => {
    applyThemeSettings();

    expect(getState().settings?.theme).toBe("system");
    expect(getState().settings?.terminalTheme).toBe("aurora");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.terminalTheme).toBe("aurora");
    expect(document.documentElement.style.getPropertyValue("--bg-term")).toBe("#f7f9ff");
    expect(runtimeMocks.applyXtermTheme).toHaveBeenLastCalledWith("light", "aurora");

    prefersDark = true;
    applyThemeSettings();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.terminalTheme).toBe("aurora");
    expect(document.documentElement.style.getPropertyValue("--bg-term")).toBe("#0d1321");
    expect(runtimeMocks.applyXtermTheme).toHaveBeenLastCalledWith("dark", "aurora");
    expect(runtimeMocks.applyTerminalSettings).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.setNativeTheme).toHaveBeenLastCalledWith("dark");
  });
});
