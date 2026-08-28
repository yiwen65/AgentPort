// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMock,
  attachHandleMock,
  jumpToRecoveryOutputMock,
  releaseTerminalMock,
  resetForRestartMock,
} = vi.hoisted(() => ({
  apiMock: {
    listProjects: vi.fn(),
    markSessionSeen: vi.fn(),
    restartSession: vi.fn(),
  },
  attachHandleMock: vi.fn(),
  jumpToRecoveryOutputMock: vi.fn(),
  releaseTerminalMock: vi.fn(),
  resetForRestartMock: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));

vi.mock("./terminals", () => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  attachHandle: attachHandleMock,
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  jumpToRecoveryOutput: jumpToRecoveryOutputMock,
  MAX_PERSISTENT_TERMINALS: 1,
  pruneHandles: vi.fn(),
  releaseTerminal: releaseTerminalMock,
  resetForRestart: resetForRestartMock,
}));

import { restartSessionFlow, selectSession } from "./actions";
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
  pinnedAt: null,
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
  pinned: false,
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
    });
  });

  it("waits for a fresh project snapshot before selecting a newly created Session", async () => {
    apiMock.listProjects.mockResolvedValue(projectWith(oldSession, newSession));

    selectSession("ses_new");
    expect(getState().activeSessionId).toBe("ses_old");

    await vi.waitFor(() => expect(getState().activeSessionId).toBe("ses_new"));
    expect(getState().attachedIds).toEqual(["ses_new"]);
    expect(releaseTerminalMock).toHaveBeenCalledWith("ses_old");
  });

  it("preserves a collapsed Project during automatic startup selection", () => {
    window.localStorage.setItem(
      "agentport-collapsed-project-ids",
      JSON.stringify(["prj_1"]),
    );
    setState({ expandedProjects: { prj_1: false } });

    selectSession("ses_old", null, { revealInSidebar: false });

    expect(getState().activeSessionId).toBe("ses_old");
    expect(getState().expandedProjects.prj_1).toBe(false);
    expect(
      JSON.parse(
        window.localStorage.getItem("agentport-collapsed-project-ids") ?? "null",
      ),
    ).toEqual(["prj_1"]);
  });

  it("never adds a JSON-RPC Session to the persistent xterm LRU", () => {
    setState({
      projects: projectWith(oldSession, rpcSession),
      attachedIds: ["ses_rpc", "ses_old"],
    });

    selectSession("ses_rpc");

    expect(getState().activeSessionId).toBe("ses_rpc");
    expect(getState().attachedIds).toEqual([]);
    expect(releaseTerminalMock).toHaveBeenCalledWith("ses_rpc");
    expect(releaseTerminalMock).toHaveBeenCalledWith("ses_old");
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

  it("keeps ended PTY Sessions in the single xterm renderer", () => {
    const ended = { ...oldSession, id: "ses_ended", lifecycle: "stopped" as const };
    const recoveryTarget = {
      runId: "run_1",
      runOrdinal: 1,
      generation: 0,
      offset: 128,
    };
    setState({ projects: projectWith(oldSession, ended), attachedIds: [oldSession.id] });

    selectSession(ended.id, recoveryTarget);

    expect(getState().activeSessionId).toBe(ended.id);
    expect(getState().attachedIds).toEqual([ended.id]);
    expect(releaseTerminalMock).toHaveBeenCalledWith(oldSession.id);
    expect(jumpToRecoveryOutputMock).not.toHaveBeenCalled();
  });

  it("re-mounts an interrupted PTY after restart publishes it as running", async () => {
    const interrupted = {
      ...oldSession,
      id: "ses_interrupted",
      lifecycle: "interrupted" as const,
    };
    const restarted = { ...interrupted, lifecycle: "running" as const };
    setState({
      projects: projectWith(interrupted),
      activeSessionId: interrupted.id,
      attachedIds: [],
    });
    apiMock.restartSession.mockResolvedValue({
      resumePrecision: "exact",
      agentSessionId: "native-session",
      notes: [],
      notices: [],
      hostPid: 4242,
    });
    apiMock.listProjects.mockResolvedValue(projectWith(restarted));

    await restartSessionFlow(interrupted.id);

    expect(resetForRestartMock).toHaveBeenCalledWith(interrupted.id);
    expect(getState().activeSessionId).toBe(interrupted.id);
    expect(getState().attachedIds).toEqual([interrupted.id]);
    expect(attachHandleMock).toHaveBeenCalledWith(interrupted.id);
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
