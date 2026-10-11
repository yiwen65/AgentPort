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
    pickDirectory: vi.fn(),
    addProject: vi.fn(),
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
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import {
  addProjectFromPickerFlow,
  removeProjectFlow,
  removeWorktreeFlow,
} from "./actions";
import { i18n } from "./i18n";
import { emptyPaneLayout } from "./paneLayout";
import { getState, resolveConfirm, setState } from "./store";
import type { ProjectView, SessionView } from "./types";

const runningSession: SessionView = {
  id: "ses_2",
  projectId: "prj_mock",
  worktreeId: "wt_mock",
  title: "Running Session",
  adapter: "shell",
  cwd: "/mock-worktree",
  lifecycle: "running",
  hostAlive: true,
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-10-11T00:00:00Z",
};

const stoppedSession: SessionView = {
  ...runningSession,
  id: "ses_3",
  worktreeId: null,
  title: "Stopped Session",
  cwd: "/mock",
  lifecycle: "stopped",
  hostAlive: false,
};

const project: ProjectView = {
  id: "prj_mock",
  name: "Mock",
  rootPath: "/mock",
  gitRootPath: "/mock",
  pinned: false,
  sessions: [runningSession, stoppedSession],
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
  revision: "42",
  sessions: [
    { id: "ses_1", archiveGeneration: 101, archived: true },
    { id: "ses_2", archiveGeneration: 0, archived: false },
    { id: "ses_3", archiveGeneration: 0, archived: false },
  ],
  worktreeIds: ["wt_mock"],
  recoverableOperationIds: ["op_branch"],
  pendingCommitOperationIds: ["op_commit"],
  sessionCount: 3,
  activeSessionCount: 2,
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

describe("Project and Worktree removal flows", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
    setState({
      projects: [project],
      activeSessionId: null,
      terminalLayout: emptyPaneLayout(),
      terminalLayoutGroups: [],
      attachedIds: [],
      expandedProjects: {},
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
    expect(getState().confirm?.danger).toBe(true);
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

  it.each([
    {
      language: "zh-CN",
      titleFragment: "从项目列表中移除",
      bodyFragments: [
        "仅移除项目列表入口",
        "所有 Session 数据（包括归档 Session）、Worktree、文件和本地改动都会保留",
        "正在运行的 Session 不会停止",
        "重新添加同一项目路径，即可恢复显示原有 Session",
      ],
    },
    {
      language: "en-US",
      titleFragment: "from the project list",
      bodyFragments: [
        "Only the project list entry will be removed",
        "All Session data (including archived Sessions), Worktrees, files and local changes will be kept",
        "running Sessions will not be stopped",
        "Add the same project path again to restore its Sessions",
      ],
    },
  ])("confirms non-destructive Project removal in $language", async ({
    language,
    titleFragment,
    bodyFragments,
  }) => {
    await i18n.changeLanguage(language);
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);
    apiMock.removeProject.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    expect(getState().confirm?.title).toContain(titleFragment);
    for (const fragment of bodyFragments) {
      expect(getState().confirm?.body).toContain(fragment);
    }
    expect(getState().confirm?.danger).not.toBe(true);
    resolveConfirm(true);
    await flow;

    expect(apiMock.projectRemovePreflight).toHaveBeenCalledWith("prj_mock");
    expect(apiMock.removeProject).toHaveBeenCalledOnce();
    expect(apiMock.removeProject).toHaveBeenCalledWith(projectPreflight);
    expect(apiMock.deleteProjectArchivedSessions).not.toHaveBeenCalled();
    expect(apiMock.removeWorktree).not.toHaveBeenCalled();
    expect(getState().toasts).toEqual([]);
  });

  it("keeps Project removal cancellable without changing the list or selection", async () => {
    setState({ activeSessionId: runningSession.id });
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    resolveConfirm(false);
    await flow;

    expect(apiMock.removeProject).not.toHaveBeenCalled();
    expect(apiMock.deleteProjectArchivedSessions).not.toHaveBeenCalled();
    expect(apiMock.listProjects).not.toHaveBeenCalled();
    expect(getState().projects).toEqual([project]);
    expect(getState().activeSessionId).toBe(runningSession.id);
  });

  it("clears the active Session when it belongs to the removed Project", async () => {
    setState({ activeSessionId: runningSession.id });
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);
    apiMock.removeProject.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    resolveConfirm(true);
    await flow;

    expect(apiMock.listProjects).toHaveBeenCalledWith(null);
    expect(getState().projects).toEqual([]);
    expect(getState().activeSessionId).toBeNull();
  });

  it("retains an unrelated active Session selected while confirmation is open", async () => {
    const otherSession: SessionView = {
      ...runningSession,
      id: "ses_other",
      projectId: "prj_other",
      worktreeId: null,
      cwd: "/other",
    };
    const otherProject: ProjectView = {
      ...project,
      id: "prj_other",
      name: "Other",
      rootPath: "/other",
      gitRootPath: "/other",
      sessions: [otherSession],
      worktrees: [],
    };
    setState({
      projects: [project, otherProject],
      activeSessionId: runningSession.id,
    });
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);
    apiMock.removeProject.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });
    apiMock.listProjects.mockResolvedValue([otherProject]);

    const flow = removeProjectFlow("prj_mock");
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    setState({ activeSessionId: otherSession.id });
    resolveConfirm(true);
    await flow;

    expect(apiMock.listProjects).toHaveBeenCalledWith(otherSession.id);
    expect(getState().activeSessionId).toBe(otherSession.id);
    expect(getState().projects).toEqual([otherProject]);
  });

  it("restores Sessions and Worktrees and expands the same Project when its path is re-added", async () => {
    setState({
      activeSessionId: runningSession.id,
      expandedProjects: { [project.id]: false },
    });
    apiMock.projectRemovePreflight.mockResolvedValue(projectPreflight);
    apiMock.removeProject.mockResolvedValue({
      stopWarnings: 0,
      cleanupWarnings: 0,
    });
    apiMock.listProjects
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    apiMock.pickDirectory.mockResolvedValue(project.rootPath);
    apiMock.addProject.mockResolvedValue({
      id: project.id,
      name: project.name,
      focusedExisting: false,
    });

    const flow = removeProjectFlow(project.id);
    await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
    resolveConfirm(true);
    await flow;
    expect(getState().projects).toEqual([]);

    await addProjectFromPickerFlow();

    expect(apiMock.addProject).toHaveBeenCalledWith(project.rootPath, null);
    expect(getState().projects).toEqual([project]);
    expect(getState().projects[0].sessions).toEqual([
      runningSession,
      stoppedSession,
    ]);
    expect(getState().projects[0].worktrees).toEqual(project.worktrees);
    expect(getState().expandedProjects[project.id]).toBe(true);
    expect(apiMock.deleteProjectArchivedSessions).not.toHaveBeenCalled();
    expect(apiMock.removeWorktree).not.toHaveBeenCalled();
  });
});
