// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMock,
  attachHandleMock,
  releaseTerminalMock,
  resetForRestartMock,
} = vi.hoisted(() => ({
  apiMock: {
    archiveSession: vi.fn(),
    deleteArchivedSession: vi.fn(),
    listProjects: vi.fn(),
    markSessionSeen: vi.fn(),
    restartSession: vi.fn(),
    stopSession: vi.fn(),
  },
  attachHandleMock: vi.fn(),
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
  MAX_PERSISTENT_TERMINALS: 1,
  pruneHandles: vi.fn(),
  releaseTerminal: releaseTerminalMock,
  resetForRestart: resetForRestartMock,
}));

import {
  canSplitPaneSize,
  canSplitSessionPane,
  openSplitAgentPicker,
  openSplitSessionDialog,
  removeSessionFlow,
  removeSessionPane,
  restartSessionFlow,
  stopSessionFlow,
  selectSession,
  setPaneSplitRatio,
  splitSessionIntoPane,
  toggleSessionPaneMaximized,
} from "./actions";
import {
  orderedLayoutSessionIds,
  readPersistedTerminalLayout,
  readPersistedTerminalWorkspace,
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
const fourthSession = { ...oldSession, id: "ses_fourth", title: "fourth" };
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
    setState({
      projects: projectWith(oldSession),
      activeSessionId: "ses_old",
      terminalLayout: singletonPaneLayout("ses_old"),
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
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

    selectSession("ses_old", { revealInSidebar: false });

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

  it("keeps ended PTY Sessions in the single xterm renderer", () => {
    const ended = { ...oldSession, id: "ses_ended", lifecycle: "stopped" as const };
    setState({ projects: projectWith(oldSession, ended), attachedIds: [oldSession.id] });

    selectSession(ended.id);

    expect(getState().activeSessionId).toBe(ended.id);
    expect(getState().attachedIds).toEqual([ended.id]);
    expect(releaseTerminalMock).toHaveBeenCalledWith(oldSession.id);
  });

  it("stops directly without confirmation and ignores duplicate in-flight requests", async () => {
    let finish!: () => void;
    apiMock.stopSession.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const stopping = stopSessionFlow(oldSession.id);
    expect(apiMock.stopSession).toHaveBeenCalledWith(oldSession.id);
    expect(getState().confirm).toBeNull();
    await stopSessionFlow(oldSession.id);
    expect(apiMock.stopSession).toHaveBeenCalledTimes(1);
    finish();
    await stopping;
    expect(getState().toasts.slice(-1)[0]?.kind).toBe("success");
  });

  it("leaves the removed active pane before the safe stop completes", async () => {
    let finish!: () => void;
    apiMock.archiveSession.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    apiMock.deleteArchivedSession.mockResolvedValueOnce(undefined);
    apiMock.listProjects.mockResolvedValueOnce(projectWith(newSession));
    setState({ projects: projectWith(oldSession, newSession) });
    const pending = removeSessionFlow(oldSession.id);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(getState().archivingSessionIds).toContain(oldSession.id);
    expect(apiMock.deleteArchivedSession).not.toHaveBeenCalled();
    finish(); await pending;
    expect(apiMock.deleteArchivedSession).toHaveBeenCalledWith(oldSession.id);
  });

  it("restores a removed pane on stop failure without stealing later navigation", async () => {
    let fail!: (error: Error) => void;
    apiMock.archiveSession.mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }));
    setState({ projects: projectWith(oldSession, newSession) });
    const pending = removeSessionFlow(oldSession.id);
    expect(getState().activeSessionId).toBe(newSession.id);
    fail(new Error("stop failed")); await pending;
    expect(getState().activeSessionId).toBe(oldSession.id);
    expect(getState().archivingSessionIds).not.toContain(oldSession.id);

    apiMock.archiveSession.mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }));
    const second = removeSessionFlow(oldSession.id);
    selectSession(newSession.id);
    fail(new Error("stop failed")); await second;
    expect(getState().activeSessionId).toBe(newSession.id);
  });

  it("leaves an empty workspace while its only Session stops and restores on failure", async () => {
    let fail!: (error: Error) => void;
    apiMock.archiveSession.mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }));
    setState({ projects: projectWith(oldSession) });
    const pending = removeSessionFlow(oldSession.id);
    expect(getState().activeSessionId).toBeNull();
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([]);
    fail(new Error("stop failed")); await pending;
    expect(getState().activeSessionId).toBe(oldSession.id);
  });

  it("removes a nonfocused split pane immediately and restores the split on stop failure", async () => {
    let fail!: (error: Error) => void;
    apiMock.archiveSession.mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }));
    setState({ projects: projectWith(oldSession, newSession) });
    splitSessionIntoPane(oldSession.id, newSession.id, "right");
    const layout = getState().terminalLayout;
    const pending = removeSessionFlow(oldSession.id);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([newSession.id]);
    fail(new Error("stop failed")); await pending;
    expect(getState().terminalLayout).toEqual(layout);
  });

  it("does not restore a live pane when archive succeeded but permanent delete failed", async () => {
    apiMock.archiveSession.mockResolvedValueOnce(undefined);
    apiMock.deleteArchivedSession.mockRejectedValueOnce(new Error("delete failed"));
    apiMock.listProjects.mockResolvedValueOnce(projectWith(newSession));
    setState({ projects: projectWith(oldSession, newSession) });
    await removeSessionFlow(oldSession.id);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(getState().toasts.slice(-1)[0]?.kind).toBe("error");
    expect(apiMock.listProjects).toHaveBeenCalled();
  });

  it("permanently removes a Session after the existing row confirmation", async () => {
    apiMock.archiveSession.mockResolvedValueOnce(undefined);
    apiMock.deleteArchivedSession.mockResolvedValueOnce(undefined);
    apiMock.listProjects.mockResolvedValueOnce(projectWith(newSession));

    await removeSessionFlow(oldSession.id);

    expect(getState().confirm).toBeNull();
    expect(apiMock.archiveSession).toHaveBeenCalledWith(oldSession.id);
    expect(apiMock.deleteArchivedSession).toHaveBeenCalledWith(oldSession.id);
  });

  it("reports Stop failure without confirmation or automatic replay and permits an explicit retry", async () => {
    apiMock.stopSession.mockRejectedValueOnce(new Error("stop failed"));
    await stopSessionFlow(oldSession.id);
    expect(getState().confirm).toBeNull();
    expect(getState().toasts.slice(-1)[0]?.kind).toBe("error");
    expect(apiMock.stopSession).toHaveBeenCalledTimes(1);
    apiMock.stopSession.mockResolvedValueOnce({});
    await stopSessionFlow(oldSession.id);
    expect(apiMock.stopSession).toHaveBeenCalledTimes(2);
    expect(getState().toasts.slice(-1)[0]?.kind).toBe("success");
  });

  it("restarts a running Session without opening a confirmation dialog", async () => {
    const restarted = { ...oldSession, lifecycle: "running" as const };
    apiMock.stopSession.mockResolvedValueOnce(undefined);
    apiMock.restartSession.mockResolvedValueOnce({
      resumePrecision: "exact",
      agentSessionId: "native-session",
      notes: [],
      notices: [],
      hostPid: 4242,
    });
    apiMock.listProjects.mockResolvedValue(projectWith(restarted));

    await restartSessionFlow(oldSession.id);

    expect(getState().confirm).toBeNull();
    expect(apiMock.stopSession).toHaveBeenCalledWith(oldSession.id);
    expect(apiMock.restartSession).toHaveBeenCalledWith(oldSession.id, true);
    expect(resetForRestartMock).toHaveBeenCalledWith(oldSession.id);
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

  it("shows an out-of-layout Session temporarily and restores the remembered split", () => {
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
    expect(getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [oldSession.id, newSession.id],
    ]);
    expect(orderedLayoutSessionIds(readPersistedTerminalLayout())).toEqual([
      oldSession.id,
      newSession.id,
    ]);
    expect(getState().activeSessionId).toBe(rpcSession.id);
    expect(getState().attachedIds).toEqual([]);
    expect(releaseTerminalMock).toHaveBeenCalledWith(oldSession.id);
    expect(releaseTerminalMock).toHaveBeenCalledWith(newSession.id);

    releaseTerminalMock.mockClear();
    selectSession(oldSession.id);

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      oldSession.id,
      newSession.id,
    ]);
    expect(getState().activeSessionId).toBe(oldSession.id);
    expect(getState().attachedIds).toEqual([oldSession.id, newSession.id]);
    expect(releaseTerminalMock).not.toHaveBeenCalled();
  });

  it("restores the remembered split when the temporary singleton is removed", () => {
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

    expect(removeSessionPane(rpcSession.id)).toBe(true);

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      oldSession.id,
      newSession.id,
    ]);
    expect(getState().activeSessionId).toBe(newSession.id);
    expect(getState().attachedIds).toEqual([oldSession.id, newSession.id]);
  });

  it("can start a replacement split from the temporary singleton", () => {
    const rememberedLayout = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "remembered",
    );
    setState({
      projects: projectWith(oldSession, newSession, rpcSession),
      terminalLayout: rememberedLayout,
      activeSessionId: newSession.id,
      attachedIds: [oldSession.id, newSession.id],
    });
    selectSession(rpcSession.id);

    expect(openSplitSessionDialog(rpcSession.id, "down")).toBe(true);
    expect(splitSessionIntoPane(rpcSession.id, oldSession.id, "down")).toBe(true);

    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      rpcSession.id,
      oldSession.id,
    ]);
    expect(getState().activeSessionId).toBe(oldSession.id);
    expect(getState().attachedIds).toEqual([oldSession.id]);
  });

  it("restores each split group after creating another independent split", () => {
    const firstGroup = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "first-group",
    );
    setState({
      projects: projectWith(oldSession, newSession, rpcSession, fourthSession),
      terminalLayout: firstGroup,
      activeSessionId: newSession.id,
      attachedIds: [oldSession.id, newSession.id],
    });

    selectSession(rpcSession.id);
    expect(splitSessionIntoPane(rpcSession.id, fourthSession.id, "down")).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      rpcSession.id,
      fourthSession.id,
    ]);

    selectSession(oldSession.id);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      oldSession.id,
      newSession.id,
    ]);

    selectSession(rpcSession.id);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      rpcSession.id,
      fourthSession.id,
    ]);
    expect(getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [rpcSession.id, fourthSession.id],
      [oldSession.id, newSession.id],
    ]);
    expect(readPersistedTerminalWorkspace().groups.map(orderedLayoutSessionIds)).toEqual([
      [rpcSession.id, fourthSession.id],
      [oldSession.id, newSession.id],
    ]);
  });

  it("moves a Session between groups without discarding either remaining group", () => {
    const fifthSession = { ...oldSession, id: "ses_fifth", title: "fifth" };
    const firstGroup = splitPane(
      singletonPaneLayout(oldSession.id),
      oldSession.id,
      newSession.id,
      "right",
      "first-group",
    );
    let secondGroup = splitPane(
      singletonPaneLayout(rpcSession.id),
      rpcSession.id,
      fourthSession.id,
      "down",
      "second-group",
    );
    secondGroup = splitPane(
      secondGroup,
      fourthSession.id,
      fifthSession.id,
      "right",
      "second-group-nested",
    );
    setState({
      projects: projectWith(
        oldSession,
        newSession,
        rpcSession,
        fourthSession,
        fifthSession,
      ),
      terminalLayout: firstGroup,
      terminalLayoutGroups: [firstGroup, secondGroup],
      activeSessionId: newSession.id,
      attachedIds: [oldSession.id, newSession.id],
    });

    expect(splitSessionIntoPane(oldSession.id, rpcSession.id, "down")).toBe(true);

    expect(getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [oldSession.id, rpcSession.id, newSession.id],
      [fourthSession.id, fifthSession.id],
    ]);
    selectSession(fourthSession.id);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      fourthSession.id,
      fifthSession.id,
    ]);
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

  it("opens the lightweight Agent picker for a context-menu split", () => {
    expect(openSplitAgentPicker(oldSession.id, "right")).toBe(true);
    expect(getState().dialog).toEqual({
      kind: "splitAgentPicker",
      targetSessionId: oldSession.id,
      direction: "right",
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
