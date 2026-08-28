// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    projectRemovePreflight: vi.fn(),
    deleteProjectArchivedSessions: vi.fn(),
    removeProject: vi.fn(),
    worktreeDeletePreflight: vi.fn(),
    removeWorktree: vi.fn(),
    listProjects: vi.fn(),
  },
}));

vi.mock("./api", () => ({
  api: apiMock,
  copyText: vi.fn(),
  errorText: (error: unknown) => String(error),
}));

vi.mock("./terminals", () => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  attachHandle: vi.fn(),
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  jumpToRecoveryOutput: vi.fn(),
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import { removeProjectFlow, removeWorktreeFlow } from "./actions";
import { getState, resolveConfirm, setState } from "./store";

const project = {
  id: "prj_mock",
  name: "Mock",
  rootPath: "/mock",
  gitRootPath: "/mock",
  pinned: false,
  sessions: [],
  worktrees: [
    {
      id: "wt_mock",
      branch: "agent/mock",
      baseCommit: "a".repeat(40),
      baseRef: null,
      path: "/mock-worktree",
      health: "clean" as const,
    },
  ],
};

const projectPreflight = {
  projectId: "prj_mock",
  sessionCount: 2,
  activeSessionCount: 1,
  archivedSessionCount: 1,
  archivedSessions: [{ id: "ses_1", archiveGeneration: 101 }],
  worktreeCount: 1,
  recoverableOperationCount: 1,
  pendingCommitOperationCount: 1,
  canRemove: true,
};

const worktreePreflight = {
  worktreeId: "wt_mock",
  branch: "agent/mock",
  path: "/mock-worktree",
  health: "dirty" as const,
  modified: 0,
  staged: 0,
  untracked: 0,
  ignored: 1,
  ignoredSample: [".env"],
  sessionCount: 1,
  activeSessionCount: 1,
  repositoryMissing: false,
  canRemove: true,
  blockers: ["ignored_local_files", "session_references"],
};

describe("destructive Git removal flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: [project],
      activeSessionId: null,
      confirm: null,
      toasts: [],
    });
    apiMock.listProjects.mockResolvedValue([]);
  });

  it("confirms and deletes a dirty Worktree instead of blocking on local files or Sessions", async () => {
    apiMock.worktreeDeletePreflight.mockResolvedValue(worktreePreflight);
    apiMock.removeWorktree.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });

    const flow = removeWorktreeFlow("wt_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    expect(getState().confirm?.details?.join("\n")).toContain(".env");
    expect(getState().confirm?.details?.join("\n")).toContain("Session");
    resolveConfirm(true);
    await flow;

    expect(apiMock.removeWorktree).toHaveBeenCalledWith("wt_mock");
    const toasts = getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toContain("Worktree 已删除");
  });

  it("reports incomplete cleanup without treating it as a deletion blocker", async () => {
    apiMock.worktreeDeletePreflight.mockResolvedValue(worktreePreflight);
    apiMock.removeWorktree.mockResolvedValue({
      stopWarnings: 1,
      cleanupWarnings: 1,
    });

    const flow = removeWorktreeFlow("wt_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    resolveConfirm(true);
    await flow;

    const toasts = getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toContain("2 项进程或文件清理无法确认完成");
    expect(apiMock.removeWorktree).toHaveBeenCalledWith("wt_mock");
  });

  it("directly deletes a managed Worktree directory when the repository is gone", async () => {
    apiMock.worktreeDeletePreflight.mockResolvedValue({
      ...worktreePreflight,
      repositoryMissing: true,
      ignored: 0,
      ignoredSample: [],
      sessionCount: 0,
      activeSessionCount: 0,
      blockers: [],
    });
    apiMock.removeWorktree.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });

    const flow = removeWorktreeFlow("wt_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    expect(getState().confirm?.body).toContain("直接删除托管的 Worktree 目录");
    resolveConfirm(true);
    await flow;

    expect(apiMock.removeWorktree).toHaveBeenCalledWith("wt_mock");
  });

  it("confirms once and removes a Project with all dependencies", async () => {
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);
    apiMock.removeProject.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    expect(getState().confirm?.body).toContain("2 个 Session");
    expect(getState().confirm?.body).toContain("1 个托管 Worktree");
    expect(getState().confirm?.body).toContain("2 个未完成 Git 操作");
    resolveConfirm(true);
    await flow;

    expect(apiMock.deleteProjectArchivedSessions).not.toHaveBeenCalled();
    expect(apiMock.removeProject).toHaveBeenCalledWith("prj_mock");
  });

  it("keeps the destructive confirmation cancellable", async () => {
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    resolveConfirm(false);
    await flow;

    expect(apiMock.removeProject).not.toHaveBeenCalled();
  });
});
