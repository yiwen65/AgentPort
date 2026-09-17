// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    updateStatus: vi.fn().mockResolvedValue({ phase: "disabled" }),
    boot: vi.fn(),
    markSessionSeen: vi.fn().mockReturnValue(new Promise(() => undefined)),
    probeAgents: vi.fn().mockResolvedValue([]),
    takePendingNotificationSession: vi.fn().mockResolvedValue(null),
  },
  onNativeCleanupWarning: vi.fn(),
  openSplitAgentPicker: vi.fn(),
  openSplitSessionDialog: vi.fn(),
}));

vi.mock("./api", () => ({
  onUpdateState: vi.fn().mockResolvedValue(vi.fn()),
  api: mocks.api,
  errorText: (error: unknown) => String(error),
  onGitStateInvalidated: vi.fn().mockResolvedValue(vi.fn()),
  onNotificationActivated: vi.fn().mockResolvedValue(vi.fn()),
  onNativeCleanupWarning: mocks.onNativeCleanupWarning,
  onProjectsChanged: vi.fn().mockResolvedValue(vi.fn()),
  onRepositoryStateChanged: vi.fn().mockResolvedValue(vi.fn()),
  onSessionAgentId: vi.fn().mockResolvedValue(vi.fn()),
  onSessionExit: vi.fn().mockResolvedValue(vi.fn()),
  onSessionState: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("./actions", () => ({
  applyThemeSettings: vi.fn(),
  isMac: vi.fn().mockReturnValue(true),
  openNewSessionDialog: vi.fn(),
  openSplitAgentPicker: mocks.openSplitAgentPicker,
  openSplitSessionDialog: mocks.openSplitSessionDialog,
  readLastSelectedSessionId: () => window.localStorage.getItem("agentport-active-session-id"),
  refreshProjectsSoon: vi.fn(),
  restartSessionFlow: vi.fn(),
  selectSession: vi.fn(),
  switchSessionByIndex: vi.fn(),
  toggleSessionPaneMaximized: vi.fn(),
}));

vi.mock("./terminals", () => ({
  applyTerminalLanguage: vi.fn(),
  pruneHandles: vi.fn(),
  scrollToBottom: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./components/TopBar", () => ({ default: () => null }));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/Tooltip", () => ({ default: () => null }));
vi.mock("./components/Toasts", () => ({ default: () => null }));
vi.mock("./components/ContextMenu", () => ({ default: () => null }));
vi.mock("./components/Onboarding", () => ({ default: () => null }));
vi.mock("./components/Dialogs", () => ({
  ConfirmDialogHost: () => null,
  PromptDialogHost: () => null,
}));

import App from "./App";
import { getState, setState } from "./store";
import type { BootInfo } from "./types";

const bootInfo: BootInfo = {
  platform: {
    os: "macos",
    osVersion: "15.5",
    arch: "arm64",
    webview: "system",
    appVersion: "0.1.0",
  },
  settings: {
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
    searchIndexEnabled: true,
    agentOrder: ["shell"],
    agentHidden: [],
    telemetryEnabled: false,
  },
  adapters: [],
  projects: [],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
  timelineError: null,
  timelineMessage: null,
  secretBackend: "available",
  indexState: "ready",
  webview: "system",
  exportsDir: "/tmp/exports",
};

describe("native cleanup warning", () => {
  let emitWarning!: (event: { count: number }) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.api.boot.mockResolvedValue(bootInfo);
    mocks.api.takePendingNotificationSession.mockResolvedValue(null);
    mocks.onNativeCleanupWarning.mockImplementation(
      async (cb: (event: { count: number }) => void) => {
        emitWarning = cb;
        return vi.fn();
      },
    );
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    setState({
      ready: false,
      bootError: null,
      projects: [],
      activeSessionId: null,
      attachedIds: [],
      dialog: null,
      confirm: null,
      prompt: null,
      showOnboarding: false,
      toasts: [],
    });
  });

  afterEach(cleanup);

  it("shows a toast when the backend reports leftover native files", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.onNativeCleanupWarning).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getState().ready).toBe(true));

    act(() => emitWarning({ count: 2 }));

    await waitFor(() => {
      const toasts = getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].text).toContain("2");
      expect(toasts[0].text).toContain("原生文件");
    });
  });

  it("opens the lightweight Agent picker for pane split shortcuts", async () => {
    render(<App />);
    await waitFor(() => expect(getState().ready).toBe(true));
    act(() => setState({
      activeSessionId: "session-active",
      showOnboarding: false,
    }));

    fireEvent.keyDown(window, { key: "d", metaKey: true });
    fireEvent.keyDown(window, { key: "D", metaKey: true, shiftKey: true });

    expect(mocks.openSplitAgentPicker).toHaveBeenNthCalledWith(
      1,
      "session-active",
      "right",
    );
    expect(mocks.openSplitAgentPicker).toHaveBeenNthCalledWith(
      2,
      "session-active",
      "down",
    );
    expect(mocks.openSplitSessionDialog).not.toHaveBeenCalled();
  });
});
