// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { confirmMock, toastMock, disconnectMock, forgetMock, dropMock, releaseMock, switchMock } =
  vi.hoisted(() => ({
    confirmMock: vi.fn(),
    toastMock: vi.fn(),
    disconnectMock: vi.fn(),
    forgetMock: vi.fn(),
    dropMock: vi.fn(),
    releaseMock: vi.fn(),
    switchMock: vi.fn(),
  }));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return { ...actual, confirmDialog: confirmMock, toast: toastMock };
});
vi.mock("./deviceConnections", () => ({
  disconnectDevice: disconnectMock,
  forgetDeviceConnection: forgetMock,
}));
vi.mock("./deviceSessions", () => ({ dropDeviceSnapshot: dropMock }));
vi.mock("./terminals", () => ({ releaseTerminal: releaseMock }));
vi.mock("./deviceSwitch", () => ({ switchDevice: switchMock }));
vi.mock("./devicesStore", () => ({
  getDevicesState: () => ({ devices: [{ id: "dev_b", name: "Beta" }] }),
}));

import { disconnectDeviceFlow, paneKeysForDevice } from "./deviceTeardown";
import {
  emptyPaneLayout,
  singletonPaneLayout,
  splitPane,
} from "./paneLayout";
import { getState, setActiveDevice, setState } from "./store";
import type { SessionView } from "./types";

function session(id: string): SessionView {
  return {
    id,
    projectId: "prj",
    worktreeId: null,
    title: id,
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

function install() {
  const layout = splitPane(
    singletonPaneLayout("ses_local"),
    "ses_local",
    "dev_b:ses_remote",
    "right",
    "split-1",
  );
  setActiveDevice({ kind: "local" });
  setState({
    activeDevice: { kind: "local" },
    activeSessionId: "ses_local",
    projects: [
      {
        id: "prj",
        name: "Project",
        rootPath: "/tmp",
        gitRootPath: null,
        pinned: false,
        sessions: [session("ses_local")],
        worktrees: [],
      },
    ],
    terminalLayout: layout,
    terminalLayoutGroups: [layout],
    attachedIds: ["ses_local", "dev_b:ses_remote"],
    runtime: {
      ses_local: { attached: true },
      "dev_b:ses_remote": { attached: true },
    } as never,
    archivingSessionIds: ["dev_b:ses_remote"],
    maximizedSessionId: "dev_b:ses_remote",
  });
}

describe("disconnectDeviceFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    confirmMock.mockResolvedValue(true);
    disconnectMock.mockResolvedValue(undefined);
    releaseMock.mockResolvedValue(undefined);
    switchMock.mockResolvedValue(undefined);
    install();
  });

  it("closes only the selected device's panes after confirmation", async () => {
    expect(paneKeysForDevice("dev_b")).toEqual(["dev_b:ses_remote"]);

    const ok = await disconnectDeviceFlow("dev_b");

    expect(ok).toBe(true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith("dev_b:ses_remote");
    expect(disconnectMock).toHaveBeenCalledWith("dev_b");
    expect(dropMock).toHaveBeenCalledWith("dev_b");
    const state = getState();
    expect(state.terminalLayout.root).not.toBeNull();
    expect(JSON.stringify(state.terminalLayout)).not.toContain("dev_b:");
    expect(state.runtime["dev_b:ses_remote"]).toBeUndefined();
    expect(state.attachedIds).toEqual(["ses_local"]);
    expect(state.archivingSessionIds).toEqual([]);
    expect(state.maximizedSessionId).toBeNull();
  });

  it("keeps everything when the confirmation is cancelled", async () => {
    confirmMock.mockResolvedValue(false);
    const before = getState().terminalLayout;

    expect(await disconnectDeviceFlow("dev_b")).toBe(false);
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(getState().terminalLayout).toBe(before);
  });

  it("returns to THIS computer before removing the active device", async () => {
    const remote = {
      kind: "remote" as const,
      deviceId: "dev_b",
      deviceName: "Beta",
      capabilities: [],
    };
    setActiveDevice(remote);
    setState({
      activeDevice: remote,
      activeSessionId: "ses_remote",
      terminalLayout: singletonPaneLayout("dev_b:ses_remote"),
      terminalLayoutGroups: [],
    });
    switchMock.mockImplementation(async () => {
      setActiveDevice({ kind: "local" });
      setState({ activeDevice: { kind: "local" }, activeSessionId: null });
    });

    expect(await disconnectDeviceFlow("dev_b")).toBe(true);
    expect(switchMock).toHaveBeenCalledWith({ kind: "local" });
    expect(disconnectMock).toHaveBeenCalledWith("dev_b");
  });

  it("is a no-op for the local device", async () => {
    expect(await disconnectDeviceFlow("local")).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("handles an empty layout without a confirmation", async () => {
    setState({
      terminalLayout: emptyPaneLayout(),
      terminalLayoutGroups: [],
      attachedIds: [],
      runtime: {},
    });
    expect(await disconnectDeviceFlow("dev_b")).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
