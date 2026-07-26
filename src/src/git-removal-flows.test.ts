// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    projectRemovePreflight: vi.fn(),
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
import { getState, setState } from "./store";

const project = {
  id: "prj_mock",
  name: "Mock",
  rootPath: "/mock",
  gitRootPath: "/mock",
  sessions: [],
  worktrees: [{
    id: "wt_mock",
    branch: "agent/mock",
    baseCommit: "a".repeat(40),
    baseRef: null,
    path: "/mock-worktree",
    health: "clean" as const,
  }],
};

describe("Git removal interaction preflights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: [project],
      activeSessionId: null,
      confirm: null,
      toasts: [],
    });
  });

  it("surfaces ignored local files and never asks the backend to delete", async () => {
    apiMock.worktreeDeletePreflight.mockResolvedValue({
      worktreeId: "wt_mock",
      branch: "agent/mock",
      path: "/mock-worktree",
      health: "dirty",
      modified: 0,
      staged: 0,
      untracked: 0,
      ignored: 1,
      ignoredSample: [".env"],
      sessionCount: 0,
      activeSessionCount: 0,
      canRemove: false,
      blockers: ["ignored_local_files"],
    });

    await removeWorktreeFlow("wt_mock");

    expect(apiMock.worktreeDeletePreflight).toHaveBeenCalledWith("wt_mock");
    expect(apiMock.removeWorktree).not.toHaveBeenCalled();
    expect(getState().confirm).toBeNull();
    const toasts = getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toContain(".env");
  });

  it("blocks project removal before confirmation when dependencies remain", async () => {
    apiMock.projectRemovePreflight.mockResolvedValue({
      projectId: "prj_mock",
      sessionCount: 2,
      worktreeCount: 1,
      recoverableOperationCount: 0,
      canRemove: false,
    });

    await removeProjectFlow("prj_mock");

    expect(apiMock.removeProject).not.toHaveBeenCalled();
    expect(getState().confirm).toBeNull();
    const toasts = getState().toasts;
    expect(toasts[toasts.length - 1]?.text).toContain("2 个 Session");
    expect(toasts[toasts.length - 1]?.text).toContain("1 个 Worktree");
  });
});
