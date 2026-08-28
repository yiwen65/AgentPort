// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({
  applyThemeSettings: vi.fn(),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));

import { api } from "../api";
import { currentUiLanguage, UI_LANGUAGE_STORAGE_KEY } from "../i18n";
import { getState, setState } from "../store";
import type { Settings } from "../types";
import SettingsDialog from "./SettingsDialog";

const settings: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "system",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["claude", "codex", "shell"],
  agentHidden: [],
  telemetryEnabled: false,
};

describe("Settings language preference", () => {
  beforeEach(() => {
    setState({
      settings: { ...settings },
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

  it("scrolls the shared content pane to the top when changing sections", () => {
    const { container } = render(<SettingsDialog />);
    const content = container.querySelector<HTMLElement>(".settings-content");
    expect(content).not.toBeNull();
    if (!content) throw new Error("settings content missing");
    content.scrollTop = 240;

    fireEvent.click(screen.getByRole("button", { name: "通知" }));

    expect(content.scrollTop).toBe(0);
  });

  it("keeps storage cleanup focused and contains long legacy inventories", async () => {
    vi.spyOn(api, "getLegacyLogInventory").mockResolvedValue({
      entries: [
        {
          id: "legacy-1",
          sessionId: "ses_very_long_legacy_session_identifier_that_must_not_expand_the_page",
          runId: null,
          path: "/tmp/output.log",
          bytes: 1024,
          active: false,
          nativeStatus: { status: "available", sources: [] },
        },
        {
          id: "legacy-2",
          sessionId: "ses_active",
          runId: "run-2",
          path: "/tmp/active-output.log",
          bytes: 2048,
          active: true,
          nativeStatus: { status: "unavailable", reason: "missing" },
        },
      ],
      totalBytes: 3072,
      deletableBytes: 1024,
    });
    const { container } = render(<SettingsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "存储清理" }));

    const list = await screen.findByRole("group", { name: "旧版重复日志" });
    expect(list.classList.contains("legacy-log-list")).toBe(true);
    expect(container.querySelector(".legacy-log-session")?.textContent).toContain("ses_very_long");
    expect(screen.queryByText("历史读取模式")).toBeNull();
    expect(screen.queryByText("渲染模式")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全选可清理项" }));
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes[0]?.checked).toBe(true);
    expect(checkboxes[1]?.checked).toBe(false);
    expect(checkboxes[1]?.disabled).toBe(true);
  });

  it("switches immediately and saves independently from the settings draft", async () => {
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { finishSave = resolve; });
    const save = vi.spyOn(api, "saveSettings").mockReturnValue(pendingSave);
    render(<SettingsDialog />);

    fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en-US" } });

    await waitFor(() => expect(currentUiLanguage()).toBe("en-US"));
    expect(getState().settings?.uiLanguage).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("en-US");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ uiLanguage: "en-US" }));
    expect((screen.getByLabelText("Display language") as HTMLSelectElement).value).toBe("en-US");

    await act(async () => finishSave());
    expect(getState().settings?.uiLanguage).toBe("en-US");
  });

  it("rolls i18n, store, draft, html lang, and startup hint back when saving fails", async () => {
    vi.spyOn(api, "saveSettings").mockRejectedValue(new Error("SQLITE_FULL"));
    render(<SettingsDialog />);

    fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en-US" } });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("SQLITE_FULL"));
    expect(currentUiLanguage()).toBe("zh-CN");
    expect(getState().settings?.uiLanguage).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect((screen.getByLabelText("界面语言") as HTMLSelectElement).value).toBe("zh-CN");
  });

  it("does not allow a language write to race an in-flight theme write", async () => {
    let finishSave!: () => void;
    vi.spyOn(api, "saveSettings").mockReturnValue(
      new Promise<void>((resolve) => { finishSave = resolve; }),
    );
    render(<SettingsDialog />);

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    await waitFor(() => expect((screen.getByLabelText("界面语言") as HTMLSelectElement).disabled).toBe(true));
    expect(getState().settings?.theme).toBe("dark");
    expect(getState().settings?.uiLanguage).toBe("zh-CN");

    await act(async () => finishSave());
  });

  it("keeps Settings mounted until an immediate preference write finishes", async () => {
    let finishSave!: () => void;
    vi.spyOn(api, "saveSettings").mockReturnValue(
      new Promise<void>((resolve) => { finishSave = resolve; }),
    );
    render(<SettingsDialog />);

    fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en-US" } });
    const back = await screen.findByRole("button", { name: "Back" });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(back);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(getState().dialog).toEqual({ kind: "settings" });

    await act(async () => finishSave());
    await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(back);
    expect(getState().dialog).toBeNull();
  });
});
