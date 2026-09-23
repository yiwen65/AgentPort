// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  probeAgents: vi.fn(),
}));
const actionsMock = vi.hoisted(() => ({
  applyThemeSettings: vi.fn(),
  readLastSelectedSessionId: vi.fn(),
  selectSession: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));
vi.mock("./actions", () => actionsMock);
vi.mock("./terminals", () => ({
  applyTerminalLanguage: vi.fn(),
}));

import { applyBootInfo } from "./bootApply";
import { emptyPaneLayout } from "./paneLayout";
import { getState, setState } from "./store";
import type { AdapterInstall, BootInfo, ProjectView, SessionView, Settings } from "./types";

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

const session: SessionView = {
  id: "ses_1",
  projectId: "prj_1",
  worktreeId: null,
  title: "one",
  adapter: "shell",
  cwd: "/tmp/project",
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
const second: SessionView = { ...session, id: "ses_2", title: "two" };

const project: ProjectView = {
  id: "prj_1",
  name: "Project",
  rootPath: "/tmp/project",
  gitRootPath: null,
  pinned: false,
  sessions: [session, second],
  worktrees: [],
};

function makeBoot(overrides: Partial<BootInfo> = {}): BootInfo {
  return {
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
    projects: [project],
    timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
    timelineError: null,
    timelineMessage: null,
    secretBackend: "Keychain",
    indexState: "native_on_demand",
    webview: "system",
    exportsDir: "/tmp/exports",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  actionsMock.readLastSelectedSessionId.mockReturnValue(null);
  apiMock.probeAgents.mockResolvedValue([]);
  window.localStorage.clear();
  setState({
    ready: false,
    projects: [],
    activeSessionId: null,
    adapters: [],
    settings: null,
    platform: null,
    secretBackend: "unknown",
    indexState: "unknown",
    exportsDir: "",
    showOnboarding: false,
    // The store restores selection from the in-memory layout focus; reset it
    // so each test owns its selection expectations.
    terminalLayout: emptyPaneLayout(),
    terminalLayoutGroups: [],
  });
});

describe("applyBootInfo", () => {
  it("applies state slices and selects the first session when nothing is persisted", async () => {
    await applyBootInfo(makeBoot());
    const s = getState();
    expect(s.ready).toBe(true);
    expect(s.settings).toEqual(settings);
    expect(s.platform?.os).toBe("macos");
    expect(s.secretBackend).toBe("Keychain");
    expect(s.indexState).toBe("native_on_demand");
    expect(s.exportsDir).toBe("/tmp/exports");
    expect(s.projects.map((p) => p.id)).toEqual(["prj_1"]);
    expect(actionsMock.selectSession).toHaveBeenCalledWith("ses_1", {
      revealInSidebar: false,
    });
    expect(actionsMock.applyThemeSettings).toHaveBeenCalled();
  });

  it("prefers the notification-routed session over everything else", async () => {
    await applyBootInfo(makeBoot(), { notificationSessionId: "ses_2" });
    expect(actionsMock.selectSession).toHaveBeenCalledWith("ses_2");
  });

  it("selects the remembered session when no notification targets one", async () => {
    actionsMock.readLastSelectedSessionId.mockReturnValue("ses_2");
    await applyBootInfo(makeBoot());
    expect(actionsMock.selectSession).toHaveBeenCalledWith("ses_2", {
      revealInSidebar: false,
    });
  });

  it("does not re-select when a session is already active", async () => {
    setState({ activeSessionId: "ses_2" });
    await applyBootInfo(makeBoot());
    expect(actionsMock.selectSession).not.toHaveBeenCalled();
  });

  it("does not re-select when a terminal layout is persisted", async () => {
    window.localStorage.setItem("agentport-terminal-layout", "{}");
    await applyBootInfo(makeBoot());
    expect(actionsMock.selectSession).not.toHaveBeenCalled();
  });

  it("honors suppressFallbackSelection (notification activation in flight)", async () => {
    await applyBootInfo(makeBoot(), { suppressFallbackSelection: () => true });
    expect(actionsMock.selectSession).not.toHaveBeenCalled();
  });

  it("runs afterStateApplied after the state snapshot and before selection", async () => {
    const order: string[] = [];
    actionsMock.selectSession.mockImplementation(() => {
      order.push("select");
    });
    await applyBootInfo(makeBoot(), {
      afterStateApplied: () => {
        order.push(getState().ready ? "applied" : "not-applied");
      },
    });
    expect(order).toEqual(["applied", "select"]);
  });

  it("aborts between await points when cancelled", async () => {
    await applyBootInfo(makeBoot(), { isCancelled: () => true });
    expect(getState().ready).toBe(false);
    expect(actionsMock.selectSession).not.toHaveBeenCalled();
  });

  it("refreshes adapters in the background unless skipped", async () => {
    const install: AdapterInstall = {
      agentType: "pi",
      executablePath: "/usr/local/bin/pi",
      versionText: "1.0",
      capabilityHash: "hash",
      exactResume: true,
      hookStatus: "supported" as const,
      approvalModel: "native_prompts" as const,
      defaultTransport: "pty" as const,
      probedAt: "2026-09-23T00:00:00.000Z",
      candidates: [],
      flags: [],
    };
    apiMock.probeAgents.mockResolvedValue([{ install }]);
    const boot = makeBoot({
      adapters: [{ ...install, versionText: "0.9" }],
    });
    await applyBootInfo(boot);
    await vi.waitFor(() => {
      expect(getState().adapters[0]?.versionText).toBe("1.0");
    });
    expect(apiMock.probeAgents).toHaveBeenCalledWith(true);

    apiMock.probeAgents.mockClear();
    await applyBootInfo(boot, { skipBackgroundProbeRefresh: true });
    expect(apiMock.probeAgents).not.toHaveBeenCalled();
  });
});
