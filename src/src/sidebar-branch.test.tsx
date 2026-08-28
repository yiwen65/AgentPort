// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshRepositoryStatusMock } = vi.hoisted(() => ({
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
  },
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
}));

import Sidebar from "./components/Sidebar";
import CommandPalette from "./components/CommandPalette";
import { getState, setState } from "./store";
import type { RepositoryStatus } from "./types";

const project = {
  id: "p1",
  name: "Late Git",
  rootPath: "/tmp/late-git",
  gitRootPath: null,
  pinned: false,
  sessions: [],
  worktrees: [],
};

function repositoryStatus(isGitRepository: boolean): RepositoryStatus {
  return {
    projectId: "p1",
    isGitRepository,
    checkoutRoot: isGitRepository ? "/tmp/late-git" : null,
    repoKey: isGitRepository ? "repo-key" : null,
    head: { kind: isGitRepository ? "branch" : "unborn", branch: isGitRepository ? "main" : null },
    changes: { staged: 1, unstaged: 1, untracked: 0, unmerged: 0, dirtySubmodules: 0 },
    ongoingOperation: null,
    liveSessionIds: isGitRepository ? ["session-1"] : [],
    pendingAutoStashes: isGitRepository ? 1 : 0,
    observedAt: "2026-07-22T00:00:00.000Z",
    snapshotToken: isGitRepository ? "git" : "non-git",
  };
}

describe("sidebar local branch entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshRepositoryStatusMock.mockResolvedValue(null);
    setState({
      projects: [project],
      repositoryStatuses: {},
      expandedProjects: { p1: true },
      sidebarWorktreeProjectId: null,
      highlightedWorktreeId: null,
      contextMenu: null,
    });
  });

  afterEach(cleanup);

  it("probes every project and only renders a backend-confirmed Git checkout", () => {
    render(<Sidebar collapsed={false} width={296} />);
    expect(refreshRepositoryStatusMock).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("button", { name: /当前 checkout/ })).toBeNull();

    act(() => setState({ repositoryStatuses: { p1: repositoryStatus(false) } }));
    expect(screen.queryByRole("button", { name: /当前 checkout/ })).toBeNull();

    act(() => setState({ repositoryStatuses: { p1: repositoryStatus(true) } }));
    expect(screen.getByRole("button", { name: /当前 checkout：main/ }).getAttribute("aria-current")).toBe("page");
    // 分支行不再渲染状态徽标（有改动/运行中/待恢复）和「管理」入口；
    // 点击分支行本身即进入分支管理。
    expect(screen.queryByText(/有改动/)).toBeNull();
    expect(screen.queryByText("运行中")).toBeNull();
    expect(screen.queryByText(/待恢复/)).toBeNull();
    expect(screen.queryByText("管理")).toBeNull();
  });

  it("enables the project menu entry from live repository state", () => {
    render(<Sidebar collapsed={false} width={296} />);
    act(() => setState({ repositoryStatuses: { p1: repositoryStatus(true) } }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Late Git" }));
    const item = getState().contextMenu?.items.find((candidate) => candidate.label === "管理本地分支…");
    expect(item?.disabled).toBe(false);
  });

  it("does not expose branch management from a stale persisted gitRootPath", () => {
    const staleProject = { ...project, gitRootPath: project.rootPath };
    setState({ projects: [staleProject], repositoryStatuses: {} });
    render(<Sidebar collapsed={false} width={296} />);

    expect(screen.queryByRole("button", { name: /当前 checkout/ })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Late Git" }));
    const item = getState().contextMenu?.items.find((candidate) => candidate.label === "管理本地分支…");
    expect(item?.disabled).toBe(true);
  });

  it("only adds branch management to the command palette after a live probe", () => {
    const staleProject = { ...project, gitRootPath: project.rootPath };
    setState({ projects: [staleProject], repositoryStatuses: {} });
    const view = render(<CommandPalette />);
    expect(screen.queryByRole("option", { name: /管理本地分支/ })).toBeNull();

    act(() => setState({ repositoryStatuses: { p1: repositoryStatus(true) } }));
    expect(screen.getByRole("option", { name: /管理本地分支/ })).toBeTruthy();
    view.unmount();
  });

  it("does not list projects in the command palette", () => {
    render(<CommandPalette />);

    expect(screen.getByPlaceholderText("输入以过滤操作…")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Late Git/ })).toBeNull();
  });
});
