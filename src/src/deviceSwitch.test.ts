// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  boot: vi.fn(),
  getSettings: vi.fn(),
}));
const actionsMock = vi.hoisted(() => ({
  applyThemeSettings: vi.fn(),
  readLastSelectedSessionId: vi.fn(),
  selectSession: vi.fn(),
}));
const terminalsMock = vi.hoisted(() => ({
  releaseTerminal: vi.fn(),
  applyTerminalLanguage: vi.fn(),
}));
const runtimeMock = vi.hoisted(() => ({
  remoteBackendFor: vi.fn(),
  dropRemoteBackend: vi.fn(),
}));
const remoteSyncMock = vi.hoisted(() => ({
  startRemoteSync: vi.fn(),
  stopRemoteSync: vi.fn(),
}));
const hoverCardMock = vi.hoisted(() => ({
  clearCommitPreviewCache: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));
vi.mock("./actions", () => actionsMock);
vi.mock("./terminals", () => terminalsMock);
vi.mock("./remote/runtime", () => runtimeMock);
vi.mock("./remote/remoteSync", () => remoteSyncMock);
vi.mock("./components/GitCommitHoverCard", () => hoverCardMock);

import {
  LOCAL_DEVICE_CONTEXT,
  resetDeviceContextForTests,
  setDeviceContext,
  ACTIVE_DEVICE_STORAGE_KEY,
  type DeviceContext,
} from "./deviceContext";
import {
  resetDeviceSwitchForTests,
  startupRestoreTarget,
  switchDevice,
} from "./deviceSwitch";
import { cacheLocalBootBase, resetLocalBootBaseForTests } from "./remoteBoot";
import {
  getState,
  emptyGitCenterState,
  setActiveDevice,
  setState,
  shouldApplyLocalBackendEvent,
  type GitCheckoutUiState,
} from "./store";
import { emptyPaneLayout } from "./paneLayout";
import type { BootInfo, ProjectView, SessionView, Settings } from "./types";

const settings: Settings = {
  logLimitMib: 100,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "dark",
  terminalTheme: "one",
  terminalFontFamily: "monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: [],
  agentHidden: [],
  telemetryEnabled: false,
};

const localSession: SessionView = {
  id: "ses_local",
  projectId: "prj_local",
  worktreeId: null,
  title: "local",
  adapter: "shell",
  cwd: "/tmp/local",
  lifecycle: "running",
  hostAlive: true,
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-09-23T00:00:00.000Z",
};
const remoteSession: SessionView = {
  ...localSession,
  id: "ses_remote",
  projectId: "prj_remote",
  title: "remote",
  cwd: "/srv/linux",
};

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
  rootPath: "/srv/linux",
  gitRootPath: null,
  pinned: false,
  sessions: [remoteSession],
  worktrees: [],
};

const emptyTimeline = {
  completed: 0,
  waiting: 0,
  failed: 0,
  entries: [],
  ackSnapshots: [],
};

const localBoot: BootInfo = {
  platform: {
    os: "macos",
    osVersion: "26.0",
    arch: "aarch64",
    webview: "wkwebview",
    appVersion: "0.1.2",
    windowDecorated: true,
  },
  settings,
  adapters: [],
  projects: [localProject],
  timeline: emptyTimeline,
  timelineError: null,
  timelineMessage: null,
  secretBackend: "Keychain",
  indexState: "native_on_demand",
  webview: "system",
  exportsDir: "/tmp/exports",
};

function makeBackend(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      connect: vi.fn(async () => ({
        protocolVersion: { major: 1, minor: 1 },
        capabilities: ["session.event_push"],
        deviceName: "Linux Box",
      })),
      disconnect: vi.fn(async () => undefined),
    },
    boot: vi.fn(async () => ({})),
    probeAgents: vi.fn(async () => []),
    listProjects: vi.fn(async () => [remoteProject]),
    getTimeline: vi.fn(async () => emptyTimeline),
    secretStatus: vi.fn(async () => "RemoteKeyring"),
    ...overrides,
  };
}

function remoteContext(deviceId: string): DeviceContext {
  return { kind: "remote", deviceId, deviceName: deviceId, capabilities: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetDeviceContextForTests();
  resetDeviceSwitchForTests();
  resetLocalBootBaseForTests();
  cacheLocalBootBase(localBoot);
  apiMock.boot.mockResolvedValue(localBoot);
  apiMock.getSettings.mockResolvedValue(settings);
  actionsMock.readLastSelectedSessionId.mockReturnValue(null);
  terminalsMock.releaseTerminal.mockResolvedValue(undefined);
  setActiveDevice(LOCAL_DEVICE_CONTEXT);
  setState({
    ready: true,
    projects: [],
    activeSessionId: null,
    attachedIds: [],
    deviceSwitching: false,
    deviceError: null,
    toasts: [],
    // The store restores selection from the in-memory layout focus; reset it.
    terminalLayout: emptyPaneLayout(),
    terminalLayoutGroups: [],
  });
});

describe("switchDevice", () => {
  it("is a no-op when the target is already active", async () => {
    await switchDevice(LOCAL_DEVICE_CONTEXT);
    expect(apiMock.boot).not.toHaveBeenCalled();
    expect(runtimeMock.remoteBackendFor).not.toHaveBeenCalled();
  });

  it("switches local → remote: teardown, connect, remote boot applied", async () => {
    const backend = makeBackend();
    runtimeMock.remoteBackendFor.mockReturnValue(backend);
    setState({ attachedIds: ["ses_local"], activeSessionId: "ses_local" });

    await switchDevice(remoteContext("dev_1"));

    expect(terminalsMock.releaseTerminal).toHaveBeenCalledWith("ses_local");
    expect(remoteSyncMock.stopRemoteSync).toHaveBeenCalled();
    expect(remoteSyncMock.startRemoteSync).toHaveBeenCalledWith("dev_1");
    expect(backend.client.connect).toHaveBeenCalledTimes(1);
    const s = getState();
    expect(s.activeDevice).toEqual({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux Box",
      capabilities: ["session.event_push"],
    });
    expect(s.projects.map((p) => p.id)).toEqual(["prj_remote"]);
    expect(s.ready).toBe(true);
    expect(s.activeSessionId).toBeNull();
    expect(s.deviceSwitching).toBe(false);
    expect(s.deviceError).toBeNull();
    // Settings stayed local even though data came from the remote device.
    expect(apiMock.getSettings).toHaveBeenCalled();
    expect(s.settings).toEqual(settings);
  });

  it("switches remote → local: disconnects, drops the backend, local boot applied", async () => {
    const backend = makeBackend();
    runtimeMock.remoteBackendFor.mockReturnValue(backend);
    const previous = remoteContext("dev_1");
    setDeviceContext(previous);
    setState({ activeDevice: previous });

    await switchDevice(LOCAL_DEVICE_CONTEXT);

    expect(backend.client.disconnect).toHaveBeenCalledTimes(1);
    expect(runtimeMock.dropRemoteBackend).toHaveBeenCalledWith("dev_1");
    expect(apiMock.boot).toHaveBeenCalledTimes(1);
    const s = getState();
    expect(s.activeDevice.kind).toBe("local");
    expect(s.projects.map((p) => p.id)).toEqual(["prj_local"]);
    expect(s.deviceSwitching).toBe(false);
  });

  it("rolls back to local when the remote connect fails", async () => {
    const backend = makeBackend({
      client: {
        connect: vi.fn(async () => {
          throw new Error("ssh down");
        }),
        disconnect: vi.fn(async () => undefined),
      },
    });
    runtimeMock.remoteBackendFor.mockReturnValue(backend);

    await switchDevice(remoteContext("dev_1"));

    const s = getState();
    expect(s.activeDevice.kind).toBe("local");
    expect(remoteSyncMock.startRemoteSync).not.toHaveBeenCalled();
    expect(s.deviceError).toContain("ssh down");
    expect(s.deviceSwitching).toBe(false);
    expect(s.toasts.some((t) => t.kind === "error")).toBe(true);
    expect(apiMock.boot).toHaveBeenCalledTimes(1); // rollback re-boot
    expect(s.projects.map((p) => p.id)).toEqual(["prj_local"]);
  });

  it("rolls back to local when the remote boot composition fails", async () => {
    const backend = makeBackend({
      boot: vi.fn(async () => {
        throw new Error("bridge rejected hello");
      }),
    });
    runtimeMock.remoteBackendFor.mockReturnValue(backend);

    await switchDevice(remoteContext("dev_1"));

    const s = getState();
    expect(s.activeDevice.kind).toBe("local");
    expect(s.deviceError).toContain("bridge rejected hello");
    expect(s.projects.map((p) => p.id)).toEqual(["prj_local"]);
  });

  it("rolls back to the previous REMOTE device when the new target fails", async () => {
    const backendA = makeBackend();
    const backendB = makeBackend({
      client: {
        connect: vi.fn(async () => {
          throw new Error("unreachable");
        }),
        disconnect: vi.fn(async () => undefined),
      },
    });
    runtimeMock.remoteBackendFor.mockImplementation((deviceId: string) =>
      deviceId === "dev_1" ? backendA : backendB,
    );
    const previous = { ...remoteContext("dev_1"), deviceName: "Box A" };
    setDeviceContext(previous);
    setState({ activeDevice: previous });

    await switchDevice(remoteContext("dev_2"));

    const s = getState();
    expect(backendA.client.disconnect).toHaveBeenCalledTimes(1);
    expect(backendA.client.connect).toHaveBeenCalledTimes(1); // reconnected
    expect(s.activeDevice.kind).toBe("remote");
    expect((s.activeDevice as { deviceId: string }).deviceId).toBe("dev_1");
    expect(s.deviceError).toContain("unreachable");
    // The sync engine follows the device we actually ended up on.
    expect(remoteSyncMock.startRemoteSync).toHaveBeenLastCalledWith("dev_1");
  });

  it("resets Git Center when the device actually changes", async () => {
    const backend = makeBackend();
    runtimeMock.remoteBackendFor.mockReturnValue(backend);
    setState({
      gitCenter: {
        ...emptyGitCenterState(),
        open: true,
        locator: { kind: "projectMain", projectId: "prj_local" },
        activeCheckoutId: "checkout-local",
        resolvePhase: "ready",
        caches: {
          "checkout-local": {
            context: { repoKey: "local-repo" },
          } as unknown as GitCheckoutUiState,
        },
      },
    });

    // Selecting the already-active device keeps the open panel (and its cache).
    await switchDevice(LOCAL_DEVICE_CONTEXT);
    expect(getState().gitCenter.open).toBe(true);
    expect(getState().gitCenter.caches["checkout-local"]).toBeTruthy();
    expect(hoverCardMock.clearCommitPreviewCache).not.toHaveBeenCalled();

    await switchDevice(remoteContext("dev_1"));

    const gitCenter = getState().gitCenter;
    expect(gitCenter.open).toBe(false);
    expect(gitCenter.activeCheckoutId).toBeNull();
    expect(gitCenter.locator).toBeNull();
    expect(gitCenter.caches).toEqual({});
    expect(hoverCardMock.clearCommitPreviewCache).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent switches in call order", async () => {
    const order: string[] = [];
    const makeOrdered = (id: string) =>
      makeBackend({
        client: {
          connect: vi.fn(async () => {
            order.push(id);
            return {
              protocolVersion: { major: 1, minor: 1 },
              capabilities: [],
              deviceName: id,
            };
          }),
          disconnect: vi.fn(async () => undefined),
        },
      });
    const backendA = makeOrdered("dev_1");
    const backendB = makeOrdered("dev_2");
    runtimeMock.remoteBackendFor.mockImplementation((deviceId: string) =>
      deviceId === "dev_1" ? backendA : backendB,
    );

    await Promise.all([
      switchDevice(remoteContext("dev_1")),
      switchDevice(remoteContext("dev_2")),
    ]);

    expect(order).toEqual(["dev_1", "dev_2"]);
    const s = getState();
    expect((s.activeDevice as { deviceId: string }).deviceId).toBe("dev_2");
  });
});

describe("cold startup restore", () => {
  it.each(["connected", "connect-failed", "boot-failed"])(
    "boots a persisted remote instead of treating it as connected: %s",
    async (outcome) => {
      window.localStorage.setItem(ACTIVE_DEVICE_STORAGE_KEY, "dev_restore");
      vi.resetModules();
      const context = await import("./deviceContext");
      const store = await import("./store");
      const remoteBoot = await import("./remoteBoot");
      const switching = await import("./deviceSwitch");
      expect(context.activeDeviceContext()).toEqual(remoteContext("dev_restore"));
      expect(store.getState().ready).toBe(false);
      // App caches native boot before attempting the persisted device restore.
      remoteBoot.cacheLocalBootBase(localBoot);
      const backend = makeBackend();
      if (outcome === "connect-failed") {
        backend.client.connect.mockRejectedValue(new Error("restore unavailable"));
      } else if (outcome === "boot-failed") {
        backend.boot.mockRejectedValue(new Error("restore unavailable"));
      }
      runtimeMock.remoteBackendFor.mockReturnValue(backend);

      await switching.switchDevice(switching.startupRestoreTarget()!);

      expect(backend.client.connect).toHaveBeenCalledTimes(1);
      expect(backend.client.disconnect).not.toHaveBeenCalled();
      expect(terminalsMock.releaseTerminal).not.toHaveBeenCalled();
      expect(store.getState().ready).toBe(true);
      expect(store.getState().deviceSwitching).toBe(false);
      if (outcome === "connected") {
        expect(store.getState().projects.map((p) => p.id)).toEqual(["prj_remote"]);
        expect(store.getState().activeDevice).toMatchObject({
          kind: "remote", deviceId: "dev_restore", deviceName: "Linux Box",
        });
        expect(remoteSyncMock.startRemoteSync).toHaveBeenCalledWith("dev_restore");
        expect(apiMock.boot).not.toHaveBeenCalled();
        // Once actually booted, a repeat selection remains a no-op.
        await switching.switchDevice(switching.startupRestoreTarget()!);
        expect(backend.client.connect).toHaveBeenCalledTimes(1);
      } else {
        expect(store.getState().activeDevice).toEqual(LOCAL_DEVICE_CONTEXT);
        expect(store.getState().projects.map((p) => p.id)).toEqual(["prj_local"]);
        expect(store.getState().deviceError).toContain("restore unavailable");
        expect(apiMock.boot).toHaveBeenCalledTimes(1);
        expect(remoteSyncMock.startRemoteSync).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY)).toBe("local");
      }
    },
  );
});

describe("startupRestoreTarget", () => {
  it("returns null without a persisted choice or for the local sentinel", () => {
    expect(startupRestoreTarget()).toBeNull();
    window.localStorage.setItem(ACTIVE_DEVICE_STORAGE_KEY, "local");
    expect(startupRestoreTarget()).toBeNull();
  });

  it("returns a remote context for a persisted device id", () => {
    window.localStorage.setItem(ACTIVE_DEVICE_STORAGE_KEY, "dev_9");
    expect(startupRestoreTarget()).toEqual({
      kind: "remote",
      deviceId: "dev_9",
      deviceName: "dev_9",
      capabilities: [],
    });
  });
});

describe("shouldApplyLocalBackendEvent", () => {
  it("applies only while the local device is active", () => {
    expect(shouldApplyLocalBackendEvent({ activeDevice: LOCAL_DEVICE_CONTEXT })).toBe(true);
    expect(shouldApplyLocalBackendEvent({ activeDevice: remoteContext("dev_1") })).toBe(false);
  });
});
