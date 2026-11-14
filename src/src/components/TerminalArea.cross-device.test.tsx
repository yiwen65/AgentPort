// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  attachHandleMock,
  connectDeviceMock,
  focusSessionKeyMock,
  isDeviceConnectedMock,
  located,
  sessionsState,
} = vi.hoisted(() => {
  const located = new Map<string, { deviceId: string; key: string; session: unknown; project: unknown }>();
  const sessionsState = {
    snapshots: {
      dev_b: {
        deviceId: "dev_b",
        deviceName: "Beta",
        transport: "ssh",
        projects: [],
        fetchedAt: 1,
        metadataFetchedAt: 1,
        loading: false,
        error: null,
      },
    },
    refreshing: false,
  };
  return {
    attachHandleMock: vi.fn().mockResolvedValue(undefined),
    connectDeviceMock: vi.fn().mockResolvedValue({}),
    focusSessionKeyMock: vi.fn(),
    isDeviceConnectedMock: vi.fn(() => true),
    located,
    sessionsState,
  };
});

vi.mock("../actions", () => ({
  PANE_SEPARATOR_SIZE: 6,
  canSplitSessionPane: vi.fn(() => true),
  openNewSessionDialog: vi.fn(),
  openSplitAgentPicker: vi.fn(),
  persistCurrentPaneLayout: vi.fn(),
  removeSessionPane: vi.fn(),
  removeSessionFlow: vi.fn(),
  renameSessionFlow: vi.fn(),
  resumeSessionFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  setPaneSplitRatio: vi.fn(),
  splitSessionIntoPane: vi.fn(),
  stopSessionFlow: vi.fn(),
  toggleSessionPaneMaximized: vi.fn(),
}));
vi.mock("../api", () => ({
  api: {},
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
  readClipboardText: vi.fn().mockResolvedValue(""),
}));
vi.mock("../terminals", () => ({
  attachHandle: attachHandleMock,
  fitSession: vi.fn(),
  focusSession: vi.fn(),
  getHandle: vi.fn(),
  hasWarmTerminalPreview: vi.fn(() => false),
  isTerminalPreviewRendered: vi.fn(() => true),
  loadOlderNativeHistory: vi.fn().mockResolvedValue(false),
  mountTerminal: vi.fn(),
  insertTextIntoTerminal: vi.fn(() => true),
  scrollTerminalViewport: vi.fn(),
  scrollToBottom: vi.fn(),
  setTerminalActive: vi.fn(),
  restoreDesktopTerminalSize: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../deviceSessions", () => ({
  findSessionByKey: (key: string) => located.get(key) ?? null,
  findSessionByKeyForState: (_state: unknown, key: string) =>
    located.get(key) ?? null,
  refreshDeviceSnapshot: vi.fn().mockResolvedValue(true),
  useDeviceSessions: (
    selector?: (state: typeof sessionsState) => unknown,
  ) => (selector ? selector(sessionsState) : sessionsState),
}));
vi.mock("../deviceConnections", () => ({
  connectDevice: connectDeviceMock,
  isDeviceConnected: (deviceId: string) =>
    deviceId === "local" ? true : isDeviceConnectedMock(),
  useDeviceConnections: (
    selector?: (state: {
      connections: Record<string, { phase: string; error: null }>;
    }) => unknown,
  ) => {
    const state = { connections: { dev_b: { phase: "connected", error: null } } };
    return selector ? selector(state) : state;
  },
}));
vi.mock("../devicesStore", () => ({
  useDevicesStore: (
    selector?: (state: {
      devices: Array<{ id: string; name: string; transport: string }>;
    }) => unknown,
  ) => {
    const state = {
      devices: [{ id: "dev_b", name: "Beta", transport: "ssh" }],
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock("../deviceSwitch", () => ({
  focusSessionKey: focusSessionKeyMock,
  reconnectActiveDevice: vi.fn().mockResolvedValue(true),
}));
vi.mock("./DocumentPanel", () => ({
  default: () => <aside data-testid="document-panel" />,
}));
vi.mock("./StatusDot", () => ({
  default: () => <span />,
}));

import { singletonPaneLayout, splitPane } from "../paneLayout";
import { setState } from "../store";
import type { ProjectView, SessionView } from "../types";
import TerminalArea from "./TerminalArea";

function session(id: string, projectId: string, title: string): SessionView {
  return {
    id,
    projectId,
    worktreeId: null,
    title,
    adapter: "shell",
    cwd: "/tmp",
    lifecycle: "running",
    hostAlive: true,
    agentSessionId: null,
    resumePrecision: "unavailable",
    permissionMode: "native",
    transport: "pty",
    unread: false,
    status: null,
    pinnedAt: null,
    createdAt: "2026-11-14T00:00:00.000Z",
  };
}

const localSession = session("pty-a", "prj_local", "Local PTY");
const remoteSession = session("pty-b", "prj_remote", "Remote PTY");
const localProject: ProjectView = {
  id: "prj_local",
  name: "Local",
  rootPath: "/tmp/local",
  gitRootPath: null,
  pinned: false,
  sessions: [localSession],
  worktrees: [],
};
const remoteProject: ProjectView = {
  id: "prj_remote",
  name: "Remote",
  rootPath: "/tmp/remote",
  gitRootPath: null,
  pinned: false,
  sessions: [remoteSession],
  worktrees: [],
};

const remoteKey = "dev_b:pty-b";

describe("TerminalArea cross-device panes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    located.clear();
    located.set("pty-a", {
      deviceId: "local",
      key: "pty-a",
      session: localSession,
      project: localProject,
    });
    located.set(remoteKey, {
      deviceId: "dev_b",
      key: remoteKey,
      session: remoteSession,
      project: remoteProject,
    });
    isDeviceConnectedMock.mockReturnValue(true);
    const layout = splitPane(
      singletonPaneLayout("pty-a"),
      "pty-a",
      remoteKey,
      "right",
      "split-cross",
    );
    setState({
      activeDevice: { kind: "local" },
      activeSessionId: "pty-a",
      projects: [localProject],
      terminalLayout: layout,
      terminalLayoutGroups: [layout],
      attachedIds: ["pty-a", remoteKey],
      runtime: {
        "pty-a": { attached: true },
        [remoteKey]: { attached: true },
      } as never,
      maximizedSessionId: null,
      deviceSwitching: false,
      docGroups: [],
      docPanelExpanded: false,
    });
  });

  afterEach(cleanup);

  it("mounts a remote pane with its device badge and routes attachment by key", async () => {
    const view = render(<TerminalArea />);
    expect(
      view.container.querySelector(`[data-pane-session-id="${remoteKey}"]`),
    ).not.toBeNull();
    expect(view.getByText("Beta")).toBeTruthy();
    await waitFor(() => {
      expect(attachHandleMock).toHaveBeenCalledWith("pty-a");
      expect(attachHandleMock).toHaveBeenCalledWith(remoteKey);
    });
  });

  it("focusing the remote pane uses the device-aware focus helper", () => {
    const view = render(<TerminalArea />);
    const remote = view.container.querySelector(
      `[data-pane-session-id="${remoteKey}"]`,
    )!;
    fireEvent.pointerDown(remote);
    expect(focusSessionKeyMock).toHaveBeenCalledWith(remoteKey);
  });

  it("shows a reconnect surface instead of mounting a missing remote Session", async () => {
    located.delete(remoteKey);
    isDeviceConnectedMock.mockReturnValue(false);
    const view = render(<TerminalArea />);
    const remote = view.container.querySelector(
      `[data-pane-session-id="${remoteKey}"]`,
    );
    expect(remote?.classList.contains("missing-session-pane")).toBe(true);
    expect(view.getByText("未连接")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(connectDeviceMock).toHaveBeenCalledWith("dev_b"));
  });

  it("keeps a remote pane visible while a device switch is in flight", () => {
    const view = render(<TerminalArea />);
    act(() => setState({ deviceSwitching: true }));
    expect(
      view.container.querySelector(`[data-pane-session-id="${remoteKey}"]`),
    ).not.toBeNull();
  });
});
