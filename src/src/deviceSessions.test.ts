// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  localListProjectsMock,
  remoteListProjectsMock,
  remoteListProjectSessionsMock,
  isDeviceConnectedMock,
  connectionsState,
  disconnectEvents,
} = vi.hoisted(() => ({
  localListProjectsMock: vi.fn(),
  remoteListProjectsMock: vi.fn(),
  remoteListProjectSessionsMock: vi.fn(),
  isDeviceConnectedMock: vi.fn(),
  connectionsState: {
    explicitDeviceIds: [] as string[],
    connections: {} as Record<string, { phase: string }>,
  },
  disconnectEvents: [] as string[],
}));

vi.mock("./api", () => ({
  api: { listProjects: localListProjectsMock },
  errorText: (error: unknown) => String((error as { message?: string })?.message ?? error),
}));

vi.mock("./remote/runtime", () => ({
  remoteBackendFor: () => ({
    listProjects: remoteListProjectsMock,
    listProjectSessions: remoteListProjectSessionsMock,
  }),
}));

vi.mock("./deviceConnections", () => ({
  getDeviceConnectionsState: () => connectionsState,
  isDeviceConnected: isDeviceConnectedMock,
  markDeviceDisconnected: (deviceId: string, error?: string) => {
    disconnectEvents.push(`${deviceId}:${error ?? ""}`);
  },
}));

vi.mock("./devicesStore", () => ({
  getDevicesState: () => ({
    devices: [
      { id: "dev_a", name: "Alpha", transport: "ssh" },
      { id: "dev_b", name: "Beta", transport: "relay" },
    ],
  }),
}));

import {
  dropDeviceSnapshot,
  findSessionByKey,
  getDeviceSessionsState,
  patchSessionByKey,
  refreshConnectedDeviceSnapshots,
  refreshDeviceSnapshot,
  resetDeviceSessionsForTests,
} from "./deviceSessions";
import { getState, setState } from "./store";
import type { ProjectView, SessionView } from "./types";

function session(id: string, projectId: string): SessionView {
  return {
    id,
    projectId,
    worktreeId: null,
    title: id,
    adapter: "codex",
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

function project(id: string, sessionId: string): ProjectView {
  return {
    id,
    name: id.toUpperCase(),
    rootPath: `/tmp/${id}`,
    gitRootPath: null,
    pinned: false,
    sessions: [session(sessionId, id)],
    worktrees: [],
  };
}

const remoteActive = {
  kind: "remote" as const,
  deviceId: "dev_a",
  deviceName: "Alpha",
  capabilities: [],
};

describe("deviceSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDeviceSessionsForTests();
    localStorage.clear();
    connectionsState.explicitDeviceIds.length = 0;
    disconnectEvents.length = 0;
    isDeviceConnectedMock.mockReturnValue(true);
    setState({
      activeDevice: { kind: "local" },
      activeSessionId: null,
      projects: [project("prj_local", "ses_local")],
      runtime: {},
    });
  });

  it("fetches the local device directly while a remote device is active", async () => {
    setState({ activeDevice: remoteActive, projects: [project("prj_remote", "ses_remote")] });
    localListProjectsMock.mockResolvedValue([project("prj_local", "ses_local")]);

    await refreshDeviceSnapshot("local");

    expect(localListProjectsMock).toHaveBeenCalledWith(null);
    const snapshot = getDeviceSessionsState().snapshots.local;
    expect(snapshot.projects[0].sessions[0].id).toBe("ses_local");
    expect(snapshot.error).toBeNull();
  });

  it("keeps the previous snapshot and marks the error on a failed refresh", async () => {
    setState({ activeDevice: remoteActive, projects: [] });
    localListProjectsMock
      .mockResolvedValueOnce([project("prj_local", "ses_local")])
      .mockRejectedValueOnce(new Error("db busy"));

    await refreshDeviceSnapshot("local");
    await refreshDeviceSnapshot("local");

    const snapshot = getDeviceSessionsState().snapshots.local;
    expect(snapshot.projects[0].sessions[0].id).toBe("ses_local");
    expect(snapshot.error).toContain("db busy");
  });

  it("ignores a late reply from an older generation", async () => {
    setState({ activeDevice: remoteActive, projects: [] });
    let resolveFirst!: (value: ProjectView[]) => void;
    let resolveSecond!: (value: ProjectView[]) => void;
    localListProjectsMock
      .mockImplementationOnce(
        () => new Promise<ProjectView[]>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<ProjectView[]>((resolve) => (resolveSecond = resolve)),
      );

    const first = refreshDeviceSnapshot("local");
    const second = refreshDeviceSnapshot("local");
    resolveSecond([project("prj_new", "ses_new")]);
    await second;
    resolveFirst([project("prj_old", "ses_old")]);
    await first;

    const snapshot = getDeviceSessionsState().snapshots.local;
    expect(snapshot.projects[0].sessions[0].id).toBe("ses_new");
  });

  it("reads a background remote through its own backend", async () => {
    setState({ activeDevice: { kind: "local" }, projects: [] });
    connectionsState.explicitDeviceIds.push("dev_b");
    remoteListProjectsMock.mockResolvedValue([project("prj_b", "ses_b")]);

    await refreshConnectedDeviceSnapshots();

    expect(remoteListProjectsMock).toHaveBeenCalledWith(null);
    expect(getDeviceSessionsState().snapshots.dev_b.projects[0].sessions[0].id).toBe(
      "ses_b",
    );

    // A follow-up poll inside the metadata window uses the light endpoint and
    // reuses the worktree metadata from the full pass.
    remoteListProjectSessionsMock.mockResolvedValue([project("prj_b", "ses_b")]);
    await refreshDeviceSnapshot("dev_b");
    expect(remoteListProjectSessionsMock).toHaveBeenCalledWith(null);
    expect(remoteListProjectsMock).toHaveBeenCalledTimes(1);
  });

  it("resolves active and background keys without cross-device collision", async () => {
    setState({
      activeDevice: { kind: "local" },
      projects: [project("prj_local", "ses_same")],
    });
    setState({
      activeDevice: remoteActive,
      projects: [project("prj_remote", "ses_same")],
    });
    localListProjectsMock.mockResolvedValue([project("prj_local", "ses_same")]);
    await refreshDeviceSnapshot("local");

    expect(findSessionByKey("dev_a:ses_same")?.session.id).toBe("ses_same");
    expect(findSessionByKey("ses_same")?.deviceId).toBe("local");
    expect(findSessionByKey("dev_a:missing")).toBeNull();
  });

  it("patches a background Session immutably and drops its snapshot", async () => {
    setState({ activeDevice: { kind: "local" }, projects: [] });
    connectionsState.explicitDeviceIds.push("dev_b");
    remoteListProjectsMock.mockResolvedValue([project("prj_b", "ses_b")]);
    await refreshConnectedDeviceSnapshots();

    patchSessionByKey("dev_b:ses_b", { title: "renamed" });
    expect(
      getDeviceSessionsState().snapshots.dev_b.projects[0].sessions[0].title,
    ).toBe("renamed");

    dropDeviceSnapshot("dev_b");
    expect(getDeviceSessionsState().snapshots.dev_b).toBeUndefined();
    expect(findSessionByKey("dev_b:ses_b")).toBeNull();
  });

  it("does not replace the active tree with a background snapshot", async () => {
    setState({ activeDevice: { kind: "local" }, projects: [project("prj_local", "ses_local")] });
    await refreshDeviceSnapshot("local");
    expect(getState().projects[0].sessions[0].id).toBe("ses_local");
    expect(getDeviceSessionsState().snapshots.local).toBeUndefined();
  });
});
