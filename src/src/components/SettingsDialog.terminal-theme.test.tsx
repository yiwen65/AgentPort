// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({
  applyThemeSettings: vi.fn(),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));

import { applyThemeSettings } from "../actions";
import { api } from "../api";
import { applyUiLanguage } from "../i18n";
import { getState, setState } from "../store";
import type { Settings } from "../types";
import SettingsDialog from "./SettingsDialog";

const settings: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "system",
  terminalTheme: "one",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: false,
  agentOrder: ["shell", "codex", "claude"],
  agentHidden: [],
  telemetryEnabled: false,
};

function terminalThemeRadio(name: string): HTMLInputElement {
  return screen.getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLInputElement;
}

describe("Settings terminal color themes", () => {
  beforeEach(async () => {
    await applyUiLanguage("zh-CN");
    setState({
      settings: { ...settings },
      themeEffective: "dark",
      platform: null,
      adapters: [],
      projects: [],
      dialog: { kind: "settings" },
      secretBackend: "Unavailable",
      indexState: "ready",
      rendererFallbackReason: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders six real-palette radio cards with a non-color selected mark", () => {
    const { container } = render(<SettingsDialog />);

    expect(screen.getByRole("radiogroup", { name: "终端配色" })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /One|Cupertino|Graphite|Aurora|Ember|Sakura/ }))
      .toHaveLength(6);
    expect(terminalThemeRadio("One").checked).toBe(true);
    expect(container.querySelector(".terminal-theme-card.selected .terminal-theme-check")?.textContent)
      .toBe("✓");
    expect(container.querySelectorAll(".terminal-theme-swatches > span")).toHaveLength(36);
  });

  it("applies and saves a terminal theme immediately without changing app theme", async () => {
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(undefined);
    render(<SettingsDialog />);

    fireEvent.click(terminalThemeRadio("Aurora"));

    await waitFor(() => expect(getState().settings?.terminalTheme).toBe("aurora"));
    expect(getState().settings?.theme).toBe("system");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ terminalTheme: "aurora", theme: "system" }),
    );
    expect(applyThemeSettings).toHaveBeenCalledTimes(1);
    expect(terminalThemeRadio("Aurora").checked).toBe(true);
  });

  it("rolls the store, draft, DOM, and terminal palette back when saving fails", async () => {
    vi.spyOn(api, "saveSettings").mockRejectedValue(new Error("SQLITE_FULL"));
    render(<SettingsDialog />);

    fireEvent.click(terminalThemeRadio("Graphite"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("SQLITE_FULL"));
    expect(getState().settings?.terminalTheme).toBe("one");
    expect(terminalThemeRadio("One").checked).toBe(true);
    expect(terminalThemeRadio("Graphite").checked).toBe(false);
    expect(applyThemeSettings).toHaveBeenCalledTimes(2);
  });

  it("fences other immediate preferences and closing while a theme write is pending", async () => {
    let finishSave!: () => void;
    vi.spyOn(api, "saveSettings").mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    render(<SettingsDialog />);

    fireEvent.click(terminalThemeRadio("Ember"));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "返回" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole("radio", { name: "深色" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("界面语言") as HTMLSelectElement).disabled).toBe(true);
    expect(terminalThemeRadio("Sakura").disabled).toBe(true);

    await act(async () => finishSave());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "返回" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
