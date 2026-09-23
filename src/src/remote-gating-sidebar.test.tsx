// @vitest-environment jsdom
// Remote-mode gating (T-010) for Sidebar context menus: OS-integration items
// (reveal in file manager / open in system terminal) are disabled with an
// explanatory tip while a remote device is active, and untouched locally.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listWorktreesMock, refreshRepositoryStatusMock } = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(),
  refreshRepositoryStatusMock: vi.fn(),
}));

vi.mock("./actions", () => ({
  ackTimelineFlow: vi.fn(),
  interruptSessionFlow: vi.fn(),
  openNewSessionDialog: vi.fn(),
  removeProjectFlow: vi.fn(),
  removeWorktreeFlow: vi.fn(),
  renameProjectFlow: vi.fn(),
  renameSessionInlineFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  quickStartSession: vi.fn(),
  archiveSessionFlow: vi.fn(),
  addProjectFromPickerFlow: vi.fn(),
  removeSessionFlow: vi.fn(),
  selectSession: vi.fn(),
  stopSessionFlow: vi.fn(),
  refreshRepositoryStatus: refreshRepositoryStatusMock,
}));

vi.mock("./api", () => ({
  api: {
    revealInFileManager: vi.fn(),
    openInSystemTerminal: vi.fn(),
    worktreeStatusText: vi.fn(),
    listWorktrees: listWorktreesMock,
  },
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
}));

import Sidebar from "./components/Sidebar";
import { applyUiLanguage } from "./i18n";
import { getState, setActiveDevice, setState } from "./store";

const REMOTE_CONTEXT = {
  kind: "remote" as const,
  deviceId: "dev_1",
  deviceName: "Linux box",
  capabilities: [],
};

const project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  gitRootPath: "/tmp/demo",
  pinned: false,
  sessions: [],
  worktrees: [
    {
      id: "w1",
      branch: "wt-branch",
      baseCommit: "deadbeef",
      baseRef: "main",
      path: "/tmp/demo-wt",
      health: "clean" as const,
    },
  ],
};

const settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN" as const,
  theme: "system" as const,
  terminalTheme: "one" as const,
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system" as const,
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["shell"],
  agentHidden: [],
  telemetryEnabled: false,
};

const shellAdapter = {
  agentType: "shell" as const,
  executablePath: "/bin/zsh",
  versionText: "zsh",
  capabilityHash: "sha256:test",
  exactResume: false,
  hookStatus: "unavailable" as const,
  approvalModel: "no_builtin_prompts" as const,
  defaultTransport: "pty" as const,
  probedAt: "2026-07-23T00:00:00.000Z",
  candidates: [],
  flags: [],
};

function menuItem(label: string) {
  return getState().contextMenu?.items.find((item) => item.label === label);
}

describe("Sidebar remote-mode OS-integration gating", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await applyUiLanguage("en-US", { persistHint: false });
    listWorktreesMock.mockResolvedValue([]);
    refreshRepositoryStatusMock.mockResolvedValue(null);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    setActiveDevice({ kind: "local" });
    setState({
      projects: [project],
      adapters: [shellAdapter],
      settings,
      repositoryStatuses: {},
      expandedProjects: { p1: true },
      sidebarWorktreeProjectId: null,
      highlightedWorktreeId: null,
      contextMenu: null,
    });
  });

  afterEach(async () => {
    cleanup();
    setActiveDevice({ kind: "local" });
    await applyUiLanguage("zh-CN", { persistHint: false });
  });

  it("disables the project reveal item with a tip while remote", async () => {
    act(() => setActiveDevice(REMOTE_CONTEXT));
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Demo" }));
    const item = menuItem("Show in system file manager");
    expect(item?.disabled).toBe(true);
    expect(item?.tip).toBe("Only available on this computer (a remote device is active)");
  });

  it("keeps the project reveal item enabled locally", async () => {
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Demo" }));
    const item = menuItem("Show in system file manager");
    expect(item).toBeTruthy();
    expect(item?.disabled).toBeFalsy();
    expect(item?.tip).toBeUndefined();
  });

  it("disables the worktree terminal item with a tip while remote", async () => {
    act(() => setActiveDevice(REMOTE_CONTEXT));
    setState({ sidebarWorktreeProjectId: "p1" });
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.contextMenu(await screen.findByText(/wt-branch/));
    const item = menuItem("Open in system terminal");
    expect(item?.disabled).toBe(true);
    expect(item?.tip).toBe("Only available on this computer (a remote device is active)");
  });

  it("keeps the worktree terminal item enabled locally", async () => {
    setState({ sidebarWorktreeProjectId: "p1" });
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.contextMenu(await screen.findByText(/wt-branch/));
    const item = menuItem("Open in system terminal");
    expect(item).toBeTruthy();
    expect(item?.disabled).toBeFalsy();
    expect(item?.tip).toBeUndefined();
  });
});
