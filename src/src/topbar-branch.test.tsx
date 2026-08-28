// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("./actions", () => ({ toggleSidebarCollapsed: vi.fn() }));
vi.mock("./documents", () => ({ toggleExplorer: vi.fn() }));
vi.mock("./gitCenter", () => ({
  closeGitCenter: vi.fn(),
  openGitCenter: vi.fn(),
}));

import TopBar from "./components/TopBar";
import { closeGitCenter, openGitCenter } from "./gitCenter";
import { emptyGitCenterState, setState } from "./store";
import type { ProjectView, RepositoryStatus, SessionView } from "./types";

const session = (worktreeId: string | null): SessionView => ({
  id: "ses_1",
  projectId: "prj_1",
  worktreeId,
  title: "Current Session",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/session.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-07-23T00:00:00.000Z",
});

const project = (currentSession: SessionView): ProjectView => ({
  id: "prj_1",
  name: "Apollo",
  rootPath: "/tmp/project",
  gitRootPath: "/tmp/project",
  pinned: false,
  sessions: [currentSession],
  worktrees: [{
    id: "wt_1",
    branch: "worktree/branch",
    baseCommit: "a".repeat(40),
    baseRef: "main",
    path: "/tmp/project-worktree",
    health: "clean",
  }],
});

const repositoryStatus: RepositoryStatus = {
  projectId: "prj_1",
  isGitRepository: true,
  checkoutRoot: "/tmp/project",
  repoKey: "repo-key",
  head: { kind: "branch", branch: "dev/system-time-domain" },
  changes: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 },
  ongoingOperation: null,
  liveSessionIds: [],
  pendingAutoStashes: 0,
  observedAt: "2026-07-23T00:00:00.000Z",
  snapshotToken: "snapshot",
};

describe("topbar project branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      activeSessionId: "ses_1",
      repositoryStatuses: { prj_1: repositoryStatus },
      gitCenter: emptyGitCenterState(),
    });
  });

  afterEach(cleanup);

  it("shows the current branch for a Session in the project checkout", () => {
    setState({ projects: [project(session(null))] });

    render(<TopBar />);

    expect(screen.getByText("Apollo")).toBeTruthy();
    expect(screen.getByText("dev/system-time-domain")).toBeTruthy();
  });

  it("shows the exact Worktree branch for a Worktree Session", () => {
    setState({ projects: [project(session("wt_1"))] });

    render(<TopBar />);

    expect(screen.getByText("worktree/branch")).toBeTruthy();
    expect(screen.queryByText("dev/system-time-domain")).toBeNull();
  });

  it("keeps Git Center available when Git was initialized after Project creation", () => {
    const current = session(null);
    setState({
      projects: [{ ...project(current), gitRootPath: null }],
    });

    render(<TopBar />);

    const button = screen.getByRole("button", { name: "打开 Git Center" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    button.click();
    expect(openGitCenter).toHaveBeenCalledWith({
      kind: "session",
      sessionId: current.id,
    });
  });

  it("closes Git Center when its active top-bar button is clicked again", () => {
    const current = session(null);
    setState({
      projects: [project(current)],
      gitCenter: {
        ...emptyGitCenterState(),
        open: true,
      },
    });

    render(<TopBar />);

    const button = screen.getByRole("button", { name: "关闭 Git Center" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    expect(closeGitCenter).toHaveBeenCalledTimes(1);
    expect(openGitCenter).not.toHaveBeenCalled();
  });
});
