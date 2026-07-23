// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn().mockResolvedValue(undefined) }),
}));

import TopBar from "./components/TopBar";
import { setState } from "./store";
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
  createdAt: "2026-07-23T00:00:00.000Z",
});

const project = (currentSession: SessionView): ProjectView => ({
  id: "prj_1",
  name: "Apollo",
  rootPath: "/tmp/project",
  gitRootPath: "/tmp/project",
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
    setState({
      activeSessionId: "ses_1",
      repositoryStatuses: { prj_1: repositoryStatus },
    });
  });

  afterEach(cleanup);

  it("shows the current branch for a Session in the project checkout", () => {
    setState({ projects: [project(session(null))] });

    render(<TopBar />);

    expect(screen.getByText("Apollo")).toBeTruthy();
    expect(screen.getByText("dev/system-time-domain")).toBeTruthy();
  });

  it("shows the project branch instead of the Worktree branch", () => {
    setState({ projects: [project(session("wt_1"))] });

    render(<TopBar />);

    expect(screen.getByText("dev/system-time-domain")).toBeTruthy();
    expect(screen.queryByText("worktree/branch")).toBeNull();
  });
});
