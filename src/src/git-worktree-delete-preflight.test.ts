// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
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
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import { removeWorktreeFlow } from "./actions";
import { i18n } from "./i18n";
import { emptyPaneLayout } from "./paneLayout";
import { getState, resolveConfirm, setState } from "./store";
import type { ProjectView, WorktreeDeletePreflight } from "./types";

const project: ProjectView = {
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
      health: "clean",
    },
  ],
};

const cleanPreflight: WorktreeDeletePreflight = {
  worktreeId: "wt_mock",
  branch: "agent/mock",
  path: "/mock-worktree",
  health: "clean",
  modified: 0,
  staged: 0,
  untracked: 0,
  ignored: 0,
  ignoredSample: [],
  sessionCount: 0,
  activeSessionCount: 0,
  repositoryMissing: false,
  canRemove: true,
  blockers: [],
  summaryError: null,
};

const probeFailure = "git status produced more than 10000 entries";

async function openDeleteConfirmation(
  preflight: WorktreeDeletePreflight,
): Promise<string> {
  apiMock.worktreeDeletePreflight.mockResolvedValue(preflight);
  apiMock.removeWorktree.mockResolvedValue({
    stopWarnings: 0,
    cleanupWarnings: 0,
  });

  const flow = removeWorktreeFlow("wt_mock");
  await vi.waitFor(() => expect(getState().confirm).not.toBeNull());
  const details = getState().confirm?.details?.join("\n") ?? "";
  resolveConfirm(true);
  await flow;
  return details;
}

describe("Worktree deletion with an unverifiable local-change probe", () => {
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

  it("surfaces the failed probe instead of claiming nothing needs cleanup", async () => {
    const details = await openDeleteConfirmation({
      ...cleanPreflight,
      blockers: ["local_changes_unknown"],
      summaryError: probeFailure,
    });

    expect(details).toContain("无法核实本地文件");
    expect(details).toContain(probeFailure);
    expect(details).not.toContain(
      "没有需要额外清理的本地文件或 Session 引用",
    );
    // The explicit destructive confirmation still decides the deletion.
    expect(apiMock.removeWorktree).toHaveBeenCalledWith("wt_mock");
  });

  it("surfaces the failed probe in English too", async () => {
    await i18n.changeLanguage("en-US");
    const details = await openDeleteConfirmation({
      ...cleanPreflight,
      blockers: ["local_changes_unknown"],
      summaryError: probeFailure,
    });

    expect(details).toContain("Local files could not be verified");
    expect(details).toContain(probeFailure);
    expect(details).not.toContain(
      "No local files or Session references need additional cleanup",
    );
  });

  it("still reports a verified clean Worktree when the probe succeeded", async () => {
    await i18n.changeLanguage("en-US");
    const details = await openDeleteConfirmation(cleanPreflight);

    expect(details).toContain(
      "No local files or Session references need additional cleanup",
    );
    expect(details).not.toContain("Local files could not be verified");
  });
});
