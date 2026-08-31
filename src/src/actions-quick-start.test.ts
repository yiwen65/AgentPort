// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, releaseTerminalMock } = vi.hoisted(() => ({
  apiMock: {
    createSession: vi.fn(),
    listProjects: vi.fn(),
    markSessionSeen: vi.fn(),
  },
  releaseTerminalMock: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));

vi.mock("./terminals", () => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  attachHandle: vi.fn(),
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  jumpToRecoveryOutput: vi.fn(),
  MAX_PERSISTENT_TERMINALS: 1,
  pruneHandles: vi.fn(),
  releaseTerminal: releaseTerminalMock,
  resetForRestart: vi.fn(),
}));

import { quickStartSession } from "./actions";
import { orderedLayoutSessionIds, singletonPaneLayout } from "./paneLayout";
import { getState, setState } from "./store";
import type { SessionView } from "./types";

const targetSession: SessionView = {
  id: "session-target",
  projectId: "project-1",
  worktreeId: "worktree-1",
  title: "Target",
  adapter: "shell",
  cwd: "/tmp/demo-worktrees/feature",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/target.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};
const createdSession: SessionView = {
  ...targetSession,
  id: "session-created",
  title: "Codex",
  adapter: "codex",
  permissionMode: "bypass",
  logPath: "/tmp/created.log",
};

function projectWith(...sessions: SessionView[]) {
  return [{
    id: "project-1",
    name: "Demo",
    rootPath: "/tmp/demo",
    gitRootPath: "/tmp/demo",
    pinned: false,
    sessions,
    worktrees: [{
      id: "worktree-1",
      branch: "feature/picker",
      baseCommit: "abc123",
      baseRef: "main",
      path: "/tmp/demo-worktrees/feature",
      health: "clean" as const,
    }],
  }];
}

const createResult = {
  id: createdSession.id,
  attach: { hostPid: 42, childAlive: true },
  resumePrecision: "unavailable" as const,
  agentSessionId: null,
  notes: [],
  notices: [],
  command: ["codex"],
};

describe("quickStartSession split intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    apiMock.createSession.mockResolvedValue(createResult);
    apiMock.listProjects.mockResolvedValue(projectWith(targetSession, createdSession));
    apiMock.markSessionSeen.mockReturnValue(new Promise(() => undefined));
    setState({
      projects: projectWith(targetSession),
      activeSessionId: targetSession.id,
      terminalLayout: singletonPaneLayout(targetSession.id),
      maximizedSessionId: null,
      attachedIds: [targetSession.id],
      dialog: null,
      toasts: [],
    });
  });

  it("creates in the inherited Worktree and inserts the Session into the requested pane", async () => {
    await quickStartSession(
      targetSession.projectId,
      "codex",
      targetSession.worktreeId ?? undefined,
      { targetSessionId: targetSession.id, direction: "right" },
    );

    expect(apiMock.createSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: targetSession.projectId,
      worktreeId: targetSession.worktreeId,
      agent: "codex",
      permission: "bypass",
    }));
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      targetSession.id,
      createdSession.id,
    ]);
    expect(getState().activeSessionId).toBe(createdSession.id);
  });

  it("retries a transient project refresh before giving up the requested split", async () => {
    apiMock.listProjects
      .mockRejectedValueOnce(new Error("temporary refresh failure"))
      .mockResolvedValueOnce(projectWith(targetSession, createdSession));

    await quickStartSession(
      targetSession.projectId,
      "codex",
      targetSession.worktreeId ?? undefined,
      { targetSessionId: targetSession.id, direction: "right" },
    );

    expect(apiMock.listProjects).toHaveBeenCalledTimes(2);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      targetSession.id,
      createdSession.id,
    ]);
  });

  it("falls back to a standalone Session when the split target disappears during creation", async () => {
    apiMock.listProjects.mockResolvedValue(projectWith(createdSession));

    await quickStartSession(
      targetSession.projectId,
      "codex",
      targetSession.worktreeId ?? undefined,
      { targetSessionId: targetSession.id, direction: "down" },
    );

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([createdSession.id]);
    expect(getState().activeSessionId).toBe(createdSession.id);
  });

  it("describes Pi quick-start permission accurately", async () => {
    await quickStartSession(
      targetSession.projectId,
      "pi",
      targetSession.worktreeId ?? undefined,
    );

    expect(apiMock.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "pi",
      permission: "native",
    }));
    const successToast = getState().toasts.find((toast) => toast.kind === "success");
    expect(successToast?.text).toMatch(/Local user permissions|本地用户权限/);
  });

  it("does not change the pane layout when creation fails", async () => {
    apiMock.createSession.mockRejectedValue(new Error("create failed"));

    await quickStartSession(
      targetSession.projectId,
      "codex",
      targetSession.worktreeId ?? undefined,
      { targetSessionId: targetSession.id, direction: "right" },
    );

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([targetSession.id]);
    expect(getState().activeSessionId).toBe(targetSession.id);
    expect(apiMock.listProjects).not.toHaveBeenCalled();
  });
});
