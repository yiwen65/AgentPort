// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, jumpToRecoveryOutputMock, releaseTerminalMock } = vi.hoisted(() => ({
  apiMock: {
    listProjects: vi.fn(),
    markSessionSeen: vi.fn(),
  },
  jumpToRecoveryOutputMock: vi.fn(),
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
  jumpToRecoveryOutput: jumpToRecoveryOutputMock,
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: releaseTerminalMock,
  resetForRestart: vi.fn(),
}));

import { selectSession } from "./actions";
import { getState, setState } from "./store";
import type { SessionView } from "./types";

const oldSession = {
  id: "ses_old",
  projectId: "prj_1",
  worktreeId: null,
  title: "old",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running" as const,
  agentSessionId: null,
  resumePrecision: "unavailable" as const,
  permissionMode: "native" as const,
  transport: "pty" as const,
  logPath: "/tmp/old.log",
  unread: false,
  status: null,
  createdAt: "2026-07-23T00:00:00.000Z",
};

const newSession = { ...oldSession, id: "ses_new", title: "new" };
const rpcSession = {
  ...oldSession,
  id: "ses_rpc",
  title: "structured",
  adapter: "pi",
  transport: "json_rpc" as const,
};
const projectWith = (...sessions: SessionView[]) => ([{
  id: "prj_1",
  name: "Project",
  rootPath: "/tmp/project",
  gitRootPath: null,
  sessions,
  worktrees: [],
}]);

describe("selectSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Selection persistence refreshes projects after completion. Keep that
    // unrelated background request pending so each test owns every snapshot
    // it resolves and cannot leak work into the next case.
    apiMock.markSessionSeen.mockReturnValue(new Promise(() => undefined));
    jumpToRecoveryOutputMock.mockResolvedValue(undefined);
    setState({
      projects: projectWith(oldSession),
      activeSessionId: "ses_old",
      attachedIds: ["ses_old"],
      activeWorktreeStatus: null,
    });
  });

  it("waits for a fresh project snapshot before selecting a newly created Session", async () => {
    apiMock.listProjects.mockResolvedValue(projectWith(oldSession, newSession));

    selectSession("ses_new");
    expect(getState().activeSessionId).toBe("ses_old");

    await vi.waitFor(() => expect(getState().activeSessionId).toBe("ses_new"));
    expect(getState().attachedIds).toEqual(["ses_old", "ses_new"]);
  });

  it("never adds a JSON-RPC Session to the persistent xterm LRU", () => {
    setState({
      projects: projectWith(oldSession, rpcSession),
      attachedIds: ["ses_rpc", "ses_old"],
    });

    selectSession("ses_rpc");

    expect(getState().activeSessionId).toBe("ses_rpc");
    expect(getState().attachedIds).toEqual(["ses_old"]);
    expect(releaseTerminalMock).toHaveBeenCalledWith("ses_rpc");
  });

  it("keeps structured recovery on the JSON-RPC renderer instead of opening xterm", () => {
    const recoveryTarget = {
      runId: "run_1",
      runOrdinal: 1,
      generation: 0,
      offset: 128,
    };
    setState({ projects: projectWith(oldSession, rpcSession) });

    selectSession("ses_rpc", recoveryTarget);

    expect(getState().activeSessionId).toBe("ses_rpc");
    expect(jumpToRecoveryOutputMock).not.toHaveBeenCalled();
  });

  it("still opens xterm recovery for PTY Sessions", () => {
    const recoveryTarget = {
      runId: "run_1",
      runOrdinal: 1,
      generation: 0,
      offset: 128,
    };

    selectSession("ses_old", recoveryTarget);

    expect(jumpToRecoveryOutputMock).toHaveBeenCalledWith("ses_old", recoveryTarget);
  });

  it("does not let a missing-session refresh override a newer selection intent", async () => {
    let resolveProjects!: (projects: ReturnType<typeof projectWith>) => void;
    apiMock.listProjects.mockReturnValueOnce(new Promise((resolve) => {
      resolveProjects = resolve;
    }));
    setState({ projects: projectWith(oldSession, rpcSession) });

    selectSession("ses_new");
    selectSession("ses_rpc");
    resolveProjects(projectWith(oldSession, rpcSession, newSession));

    await vi.waitFor(() => expect(apiMock.listProjects).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(getState().activeSessionId).toBe("ses_rpc");
  });
});
