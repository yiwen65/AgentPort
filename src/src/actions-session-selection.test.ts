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

import {
  canSplitPaneSize,
  canSplitSessionPane,
  openSplitSessionDialog,
  removeSessionPane,
  restartSessionFlow,
  selectSession,
  setPaneSplitRatio,
  splitSessionIntoPane,
  toggleSessionPaneMaximized,
} from "./actions";
import {
  orderedLayoutSessionIds,
  singletonPaneLayout,
  splitPane,
} from "./paneLayout";
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
    document.body.innerHTML = "";
    // Selection persistence refreshes projects after completion. Keep that
    // unrelated background request pending so each test owns every snapshot
    // it resolves and cannot leak work into the next case.
    apiMock.markSessionSeen.mockReturnValue(new Promise(() => undefined));
    jumpToRecoveryOutputMock.mockResolvedValue(undefined);
    setState({
      projects: projectWith(oldSession),
      activeSessionId: "ses_old",
      terminalLayout: singletonPaneLayout("ses_old"),
      maximizedSessionId: null,
      attachedIds: ["ses_old"],
      dialog: null,
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

  it("focuses a Session already in the layout and retains every layout PTY", () => {
    let terminalLayout = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "outer",
    );
    terminalLayout = splitPane(
      terminalLayout,
      newSession.id,
      rpcSession.id,
      "down",
      "inner",
    );
    setState({
      projects: projectWith(oldSession, newSession, rpcSession),
      terminalLayout,
      activeSessionId: oldSession.id,
      attachedIds: [oldSession.id, newSession.id],
    });

    selectSession(newSession.id);

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      oldSession.id,
      newSession.id,
      rpcSession.id,
    ]);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(getState().attachedIds).toEqual([oldSession.id, newSession.id]);
    expect(releaseTerminalMock).not.toHaveBeenCalled();
  });

  it("turns an out-of-layout selection into a singleton and releases old panes", () => {
    const terminalLayout = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "outer",
    );
    setState({
      projects: projectWith(oldSession, newSession, rpcSession),
      terminalLayout,
      activeSessionId: newSession.id,
      attachedIds: [oldSession.id, newSession.id],
    });

    selectSession(rpcSession.id);

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      rpcSession.id,
    ]);
    expect(getState().attachedIds).toEqual([]);
    expect(releaseTerminalMock).toHaveBeenCalledWith(oldSession.id);
    expect(releaseTerminalMock).toHaveBeenCalledWith(newSession.id);
  });

  it("splits, moves, maximizes, resizes, and removes panes without duplication", () => {
    setState({ projects: projectWith(oldSession, newSession, rpcSession) });

    expect(splitSessionIntoPane(oldSession.id, newSession.id, "right")).toBe(true);
    expect(splitSessionIntoPane(oldSession.id, rpcSession.id, "down")).toBe(true);
    expect(splitSessionIntoPane(rpcSession.id, newSession.id, "down")).toBe(true);
    const ids = orderedLayoutSessionIds(getState().terminalLayout);
    expect(ids).toEqual([oldSession.id, rpcSession.id, newSession.id]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(getState().attachedIds).toEqual([oldSession.id, newSession.id]);

    expect(toggleSessionPaneMaximized(newSession.id)).toBe(true);
    expect(getState().maximizedSessionId).toBe(newSession.id);
    expect(toggleSessionPaneMaximized(rpcSession.id)).toBe(true);
    expect(getState().maximizedSessionId).toBe(rpcSession.id);
    expect(toggleSessionPaneMaximized(rpcSession.id)).toBe(true);
    expect(getState().maximizedSessionId).toBeNull();

    const root = getState().terminalLayout.root;
    if (root?.type !== "split") throw new Error("expected split root");
    expect(setPaneSplitRatio(root.id, 0.63)).toBe(true);
    expect(getState().terminalLayout.root).toMatchObject({ ratio: 0.63 });

    expect(removeSessionPane(rpcSession.id)).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      oldSession.id,
      newSession.id,
    ]);
    expect(getState().attachedIds).toEqual([oldSession.id, newSession.id]);
  });

  it("enforces the confirmed split minimum and opens a typed split dialog", () => {
    expect(canSplitPaneSize("right", 646, 180)).toBe(true);
    expect(canSplitPaneSize("right", 645, 500)).toBe(false);
    expect(canSplitPaneSize("right", 646, 179)).toBe(false);
    expect(canSplitPaneSize("down", 320, 366)).toBe(true);
    expect(canSplitPaneSize("down", 800, 365)).toBe(false);
    expect(canSplitPaneSize("down", 319, 366)).toBe(false);

    expect(openSplitSessionDialog(oldSession.id, "down")).toBe(true);
    expect(getState().dialog).toMatchObject({
      kind: "newSession",
      projectId: oldSession.projectId,
      splitTargetSessionId: oldSession.id,
      splitDirection: "down",
    });
  });

  it("rejects a late split when the pane no longer has the minimum size", () => {
    setState({ projects: projectWith(oldSession, newSession) });
    const layoutElement = document.createElement("div");
    layoutElement.className = "pane-layout";
    Object.defineProperty(layoutElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 645, height: 500 }),
    });
    document.body.append(layoutElement);

    expect(splitSessionIntoPane(oldSession.id, newSession.id, "right")).toBe(false);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([oldSession.id]);
  });

  it("checks a maximized pane against its restored layout size", () => {
    const terminalLayout = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "outer",
    );
    setState({
      projects: projectWith(oldSession, newSession),
      terminalLayout,
      activeSessionId: oldSession.id,
      maximizedSessionId: oldSession.id,
    });
    const layoutElement = document.createElement("div");
    layoutElement.className = "pane-layout";
    Object.defineProperty(layoutElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1_000, height: 800 }),
    });
    const paneElement = document.createElement("div");
    paneElement.dataset.paneSessionId = oldSession.id;
    Object.defineProperty(paneElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1_000, height: 800 }),
    });
    document.body.append(layoutElement, paneElement);

    // The maximized DOM surface is wide enough, but after restore each leaf
    // gets only 497px, so another right split must be rejected.
    expect(canSplitSessionPane(oldSession.id, "right")).toBe(false);
    expect(canSplitSessionPane(oldSession.id, "down")).toBe(true);
  });
});
