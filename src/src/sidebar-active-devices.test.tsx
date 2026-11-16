// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  focusSessionKeyMock,
  reconnectActiveDeviceMock,
  connectDeviceMock,
  disconnectDeviceFlowMock,
  remoteListProjectsMock,
  remoteListProjectSessionsMock,
  connectionsState,
  actionsMock,
} = vi.hoisted(() => ({
  focusSessionKeyMock: vi.fn(),
  reconnectActiveDeviceMock: vi.fn(),
  connectDeviceMock: vi.fn(),
  disconnectDeviceFlowMock: vi.fn(),
  remoteListProjectsMock: vi.fn(),
  remoteListProjectSessionsMock: vi.fn(),
  connectionsState: {
    connections: {
      dev_b: { phase: "connected", error: null, hello: null },
    } as Record<string, { phase: string; error: string | null; hello: unknown }>,
    explicitDeviceIds: ["dev_b"],
    refreshing: false,
  },
  actionsMock: {
    copyTextWithToast: vi.fn(),
    archiveSessionFlow: vi.fn(),
    interruptSessionFlow: vi.fn(),
    openNewSessionDialog: vi.fn(),
    removeProjectFlow: vi.fn(),
    removeWorktreeFlow: vi.fn(),
    renameProjectFlow: vi.fn(),
    renameSessionInlineFlow: vi.fn(),
    resumeSessionFlow: vi.fn(),
    restartSessionFlow: vi.fn(),
    quickStartSession: vi.fn(),
    addProjectFromPickerFlow: vi.fn(),
    removeSessionFlow: vi.fn(),
    selectSession: vi.fn(),
    stopSessionFlow: vi.fn(),
    refreshRepositoryStatus: vi.fn(),
    saveProjectLayoutFlow: vi.fn(),
    toggleSessionPinFlow: vi.fn(),
  },
}));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return { ...actual };
});
vi.mock("./actions", () => actionsMock);
vi.mock("./deviceSwitch", () => ({
  focusSessionKey: focusSessionKeyMock,
  reconnectActiveDevice: reconnectActiveDeviceMock,
  switchDevice: vi.fn(),
  switchDeviceAndFocusRecent: vi.fn(),
}));
vi.mock("./deviceTeardown", () => ({
  disconnectDeviceFlow: disconnectDeviceFlowMock,
}));
vi.mock("./deviceConnections", () => ({
  useDeviceConnections: (selector?: (state: typeof connectionsState) => unknown) =>
    selector ? selector(connectionsState) : connectionsState,
  connectDevice: connectDeviceMock,
  getDeviceConnectionsState: () => connectionsState,
  isDeviceConnected: (deviceId: string) =>
    deviceId === "local" ||
    connectionsState.connections[deviceId]?.phase === "connected",
  markDeviceDisconnected: vi.fn(),
  isExplicitlyConnected: (deviceId: string) =>
    deviceId === "local" || connectionsState.explicitDeviceIds.includes(deviceId),
}));
vi.mock("./remote/runtime", () => ({
  remoteBackendFor: () => ({
    listProjects: remoteListProjectsMock,
    listProjectSessions: remoteListProjectSessionsMock,
  }),
}));
vi.mock("./api", () => ({
  api: {
    listProjects: vi.fn(),
    getNativeHistory: vi.fn(),
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    sendInput: vi.fn(),
    resizePty: vi.fn(),
    markSessionLogRendered: vi.fn(),
    markSessionOutputUnread: vi.fn(),
    autoRenameSessionFromFirstInput: vi.fn(),
    openExternalUrl: vi.fn(),
  },
  errorText: (error: unknown) => String(error),
  copyText: vi.fn(),
}));

import Sidebar from "./components/Sidebar";
import { setState } from "./store";
import {
  refreshDeviceSnapshot,
  resetDeviceSessionsForTests,
} from "./deviceSessions";
import {
  refreshDevices,
  renameDevice,
  resetDevicesStoreForTests,
  setDevicesInvokerForTests,
} from "./devicesStore";
import { singletonPaneLayout, splitPane } from "./paneLayout";
import type { ProjectView, SessionView } from "./types";

function session(id: string, title: string): SessionView {
  return {
    id,
    projectId: "prj",
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

function project(id: string, name: string, sessionId: string): ProjectView {
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    gitRootPath: null,
    pinned: false,
    sessions: [session(sessionId, sessionId)],
    worktrees: [],
  };
}

describe("cross-device active sidebar", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    resetDeviceSessionsForTests();
    resetDevicesStoreForTests();
    connectionsState.connections = {
      dev_b: { phase: "connected", error: null, hello: null },
    };
    connectionsState.explicitDeviceIds = ["dev_b"];
    setDevicesInvokerForTests(async (command) => {
      if (command === "device_list") {
        return [
          { id: "dev_b", name: "Beta", transport: "ssh", hostname: "b", port: 22, username: "u" },
          { id: "dev_c", name: "Gamma", transport: "relay", peer: { relayUrl: "wss://r", publicKey: "pk", hostId: "h" } },
        ];
      }
      return [];
    });
    await refreshDevices();
    remoteListProjectsMock.mockResolvedValue([
      project("prj_remote", "RemoteProj", "ses_shared"),
    ]);
    remoteListProjectSessionsMock.mockResolvedValue([
      project("prj_remote", "RemoteProj", "ses_shared"),
    ]);
    await refreshDeviceSnapshot("dev_b");
    connectDeviceMock.mockImplementation(async (deviceId: string) => {
      connectionsState.connections[deviceId] = {
        phase: "connected",
        error: null,
        hello: null,
      };
      connectionsState.explicitDeviceIds.push(deviceId);
      return { protocolVersion: "1", capabilities: [], deviceName: deviceId };
    });
    setState({
      activeDevice: { kind: "local" },
      activeSessionId: null,
      projects: [project("prj_local", "LocalProj", "ses_shared")],
      runtime: {},
      archivingSessionIds: [],
      repositoryStatuses: {},
      sidebarViewMode: "activeAgents",
      sidebarWorktreeProjectId: null,
      contextMenu: null,
      deviceSwitching: false,
      terminalLayoutGroups: [],
    });
  });

  afterEach(cleanup);

  it("shows equal Session ids from different devices with remote device labels", async () => {
    render(<Sidebar collapsed={false} width={296} />);

    await waitFor(() => {
      expect(screen.getByText("LocalProj")).toBeTruthy();
      expect(screen.getByText("RemoteProj")).toBeTruthy();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // Local rows stay label-free; only the remote device gets a colored label.
    expect(screen.queryByText("本机")).toBeNull();
    expect(screen.getAllByText("Beta")).toHaveLength(1);
    expect(screen.queryByText("Gamma")).toBeNull();
    const accents = screen
      .getAllByRole("listitem")
      .map((item) =>
        item
          .querySelector("[data-device-accent]")
          ?.getAttribute("data-device-accent"),
      );
    expect(accents.filter(Boolean)).toHaveLength(1);
    // Every row exposes its owning agent in the bottom-right corner.
    expect(document.querySelectorAll(".session-agent-badge")).toHaveLength(2);
  });

  it("relabels a background device immediately after a rename, without switching", async () => {
    render(<Sidebar collapsed={false} width={296} />);
    await screen.findByText("Beta");
    await act(async () => {
      await renameDevice("dev_b", "Beta renamed");
    });
    await screen.findByText("Beta renamed");
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("routes a background row click through the device-aware focus helper", async () => {
    render(<Sidebar collapsed={false} width={296} />);
    const source = await screen.findByText("RemoteProj");
    fireEvent.click(source.closest('[role="button"]')!);
    expect(focusSessionKeyMock).toHaveBeenCalledWith("dev_b:ses_shared");
  });

  it("routes background pin and archive actions with the owning device", async () => {
    render(<Sidebar collapsed={false} width={296} />);
    const source = await screen.findByText("RemoteProj");
    const row = source.closest('[role="button"]')!;
    const pin = row.querySelector('[aria-label="置顶"]')!;
    fireEvent.click(pin);
    expect(actionsMock.toggleSessionPinFlow).toHaveBeenCalledWith(
      "ses_shared",
      "dev_b",
    );

    fireEvent.click(row.querySelector('[aria-label="归档"]')!);
    expect(actionsMock.archiveSessionFlow).toHaveBeenCalledWith(
      "ses_shared",
      "dev_b",
    );
  });

  it("labels devices and project context on split-group rows", async () => {
    const group = splitPane(
      singletonPaneLayout("ses_shared"),
      "ses_shared",
      "dev_b:ses_shared",
      "right",
      "remote-split",
    );
    setState({ sidebarViewMode: "projects", terminalLayoutGroups: [group] });
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.click(screen.getByRole("button", { name: "分屏分组" }));

    const remoteRow = (await screen.findByText("RemoteProj")).closest(
      ".tree-row.session",
    )!;
    expect(remoteRow.querySelector(".session-device")?.textContent).toBe(
      "Beta",
    );
    expect(
      remoteRow.querySelector(".active-session-source")?.textContent,
    ).toBe("RemoteProj");

    const localRow = screen.getByText("LocalProj").closest(
      ".tree-row.session",
    )!;
    expect(localRow.querySelector(".session-device")).toBeNull();
    expect(
      localRow.querySelector(".active-session-source")?.textContent,
    ).toBe("LocalProj");
  });

});
