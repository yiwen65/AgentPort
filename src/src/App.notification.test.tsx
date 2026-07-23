// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    boot: vi.fn(),
    markSessionSeen: vi.fn().mockReturnValue(new Promise(() => undefined)),
    probeAgents: vi.fn().mockResolvedValue([]),
    takePendingNotificationSession: vi.fn(),
  },
  onNotificationActivated: vi.fn(),
  onSessionState: vi.fn(),
  selectSession: vi.fn(),
}));

vi.mock("./api", () => ({
  api: mocks.api,
  errorText: (error: unknown) => String(error),
  onNotificationActivated: mocks.onNotificationActivated,
  onProjectsChanged: vi.fn().mockResolvedValue(vi.fn()),
  onRepositoryStateChanged: vi.fn().mockResolvedValue(vi.fn()),
  onSessionAgentId: vi.fn().mockResolvedValue(vi.fn()),
  onSessionExit: vi.fn().mockResolvedValue(vi.fn()),
  onSessionState: mocks.onSessionState,
}));

vi.mock("./actions", () => ({
  applyThemeSettings: vi.fn(),
  isMac: vi.fn().mockReturnValue(true),
  openNewSessionDialog: vi.fn(),
  refreshActiveWorktreeStatus: vi.fn(),
  refreshProjectsSoon: vi.fn(),
  restartSessionFlow: vi.fn(),
  selectSession: mocks.selectSession,
  switchSessionByIndex: vi.fn(),
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
import { setState } from "./store";
import type { BootInfo, SessionView, StatusEventView } from "./types";

const firstSession: SessionView = {
  id: "ses_first",
  projectId: "prj_1",
  worktreeId: null,
  title: "first",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/first.log",
  unread: false,
  status: null,
  createdAt: "2026-07-23T00:00:00.000Z",
};
const targetSession = { ...firstSession, id: "ses_target", title: "target" };

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
    terminalFontFamily: "system-monospace",
    terminalFontSize: 13,
    terminalCommand: "",
    reducedMotion: "system",
    screenReaderMode: false,
    searchIndexEnabled: true,
    agentOrder: ["shell"],
    telemetryEnabled: false,
  },
  adapters: [],
  projects: [{
    id: "prj_1",
    name: "Project",
    rootPath: "/tmp/project",
    gitRootPath: null,
    sessions: [firstSession, targetSession],
    worktrees: [],
  }],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
  timelineError: null,
  timelineMessage: null,
  secretBackend: "available",
  indexState: "ready",
  webview: "system",
  exportsDir: "/tmp/exports",
};

describe("system notification navigation", () => {
  let activate!: (sessionId: string) => void;
  let emitState!: (event: StatusEventView) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectSession.mockImplementation((sessionId: string) => {
      setState({ activeSessionId: sessionId });
    });
    mocks.onNotificationActivated.mockImplementation(async (cb: (sessionId: string) => void) => {
      activate = cb;
      return vi.fn();
    });
    mocks.onSessionState.mockImplementation(async (cb: (event: StatusEventView) => void) => {
      emitState = cb;
      return vi.fn();
    });
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
      showOnboarding: false,
    });
  });

  afterEach(cleanup);

  it("selects the Session attached to a notification instead of the first Session", async () => {
    let finishBoot!: (info: BootInfo) => void;
    mocks.api.boot.mockReturnValue(new Promise((resolve) => { finishBoot = resolve; }));
    mocks.api.takePendingNotificationSession
      .mockResolvedValueOnce("ses_target")
      .mockResolvedValueOnce(null);

    render(<App />);
    await waitFor(() => expect(mocks.onNotificationActivated).toHaveBeenCalledTimes(1));
    act(() => activate("ses_target"));
    finishBoot(bootInfo);

    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_target"));
    expect(mocks.selectSession).not.toHaveBeenCalledWith("ses_first");
  });

  it("switches an already-running app when a notification is clicked", async () => {
    mocks.api.boot.mockResolvedValue(bootInfo);
    mocks.api.takePendingNotificationSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("ses_target");

    render(<App />);
    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_first"));
    mocks.selectSession.mockClear();

    act(() => activate("ses_target"));

    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_target"));
    expect(mocks.selectSession).not.toHaveBeenCalledWith("ses_first");
  });

  it("uses the clicked notification payload instead of a stale pending Session", async () => {
    mocks.api.boot.mockResolvedValue(bootInfo);
    mocks.api.takePendingNotificationSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("ses_first");

    render(<App />);
    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_first"));
    mocks.selectSession.mockClear();

    act(() => activate("ses_target"));

    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_target"));
    expect(mocks.selectSession).not.toHaveBeenCalledWith("ses_first");
    expect(mocks.api.takePendingNotificationSession).toHaveBeenCalledTimes(1);
  });

  it("does not mark an attention event read merely because its Session is active", async () => {
    mocks.api.boot.mockResolvedValue(bootInfo);
    mocks.api.takePendingNotificationSession.mockReset().mockResolvedValue(null);

    render(<App />);
    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("ses_first"));

    act(() => emitState({
      sessionId: "ses_first",
      runId: "run_first",
      runOrdinal: 1,
      sequence: 7,
      state: "idle",
      source: "adapter",
      confidence: "high",
      evidence: "adapter:kimi:TurnEnd",
      logCursor: null,
      occurredAt: "2026-07-24T00:00:00.000Z",
    }));

    expect(mocks.api.markSessionSeen).not.toHaveBeenCalled();
  });
});
