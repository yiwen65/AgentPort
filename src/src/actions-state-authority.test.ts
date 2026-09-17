// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    archiveSession: vi.fn(),
    getRepositoryStatus: vi.fn(),
    listProjects: vi.fn(),
    setProjectLayout: vi.fn(),
  },
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
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import {
  archiveSessionFlow,
  refreshProjects,
  refreshRepositoryStatus,
  saveProjectLayoutFlow,
} from "./actions";
import Sidebar from "./components/Sidebar";
import {
  applyProjectsSnapshot,
  applyRepositoryStatusSnapshot,
  getState,
  invalidateProjectsSnapshotRequests,
  patchSession,
  setState,
} from "./store";
import type { ProjectView, RepositoryStatus, SessionView, StatusEventView } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const status = (sequence: number): StatusEventView => ({
  sessionId: "ses_1",
  runId: "run_1",
  runOrdinal: 1,
  sequence,
  state: "working",
  source: "hook",
  confidence: "high",
  evidence: "test",
  logCursor: null,
  occurredAt: `2026-07-23T00:00:0${sequence}.000Z`,
});

const session = (overrides: Partial<SessionView> = {}): SessionView => ({
  id: "ses_1",
  projectId: "prj_1",
  worktreeId: null,
  title: "Session",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  ...overrides,
});

const projects = (...sessions: SessionView[]): ProjectView[] => [{
  id: "prj_1",
  name: "Project",
  rootPath: "/tmp/project",
  gitRootPath: "/tmp/project",
  pinned: false,
  sessions,
  worktrees: [],
}];

const repositoryStatus = (snapshotToken: string, branch: string): RepositoryStatus => ({
  projectId: "prj_1",
  isGitRepository: true,
  checkoutRoot: "/tmp/project",
  repoKey: "repo",
  head: { kind: "branch", branch, oid: "a".repeat(40), shortOid: "a".repeat(12) },
  changes: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 },
  ongoingOperation: null,
  liveSessionIds: [],
  pendingAutoStashes: 0,
  observedAt: "2026-07-23T00:00:00.000Z",
  snapshotToken,
});

describe("frontend state authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: projects(session()),
      activeSessionId: null,
      archivingSessionIds: [],
      attachedIds: [],
      repositoryStatuses: {},
      runtime: {},
      projectLayoutSaving: false,
      announcement: "",
      toasts: [],
    });
  });

  afterEach(cleanup);

  it("ignores a project response invalidated by a newer session event", async () => {
    const stale = deferred<ProjectView[]>();
    apiMock.listProjects.mockReturnValueOnce(stale.promise);

    const pending = refreshProjects();
    patchSession("ses_1", { lifecycle: "exited", status: status(3) });
    stale.resolve(projects(session({ lifecycle: "running", status: null })));
    await pending;

    expect(getState().projects[0].sessions[0]).toMatchObject({
      lifecycle: "exited",
      status: { sequence: 3 },
    });
  });

  it("does not resurrect a Session removed by a newer project event", async () => {
    const stale = deferred<ProjectView[]>();
    apiMock.listProjects.mockReturnValueOnce(stale.promise);

    const pending = refreshProjects();
    invalidateProjectsSnapshotRequests();
    applyProjectsSnapshot(projects());
    stale.resolve(projects(session()));
    await pending;

    expect(getState().projects[0].sessions).toEqual([]);
  });

  it("keeps a known event status when a later tree snapshot contains null", () => {
    setState({ projects: projects(session({ status: status(4) })) });

    applyProjectsSnapshot(projects(session({ status: null })));

    expect(getState().projects[0].sessions[0].status?.sequence).toBe(4);
  });

  it("keeps lifecycle and liveness with the newer run when a stale tree arrives", () => {
    const next = { ...status(1), runId: "run_2", runOrdinal: 2 };
    setState({ projects: projects(session({ lifecycle: "running", hostAlive: true, status: next })) });
    applyProjectsSnapshot(projects(session({ lifecycle: "stopped", hostAlive: false, status: status(9) })));
    expect(getState().projects[0].sessions[0]).toMatchObject({ lifecycle: "running", hostAlive: true, status: next });
  });

  it("rejects delayed exits from an old or conflicting run but accepts the current exit", () => {
    const next = { ...status(1), runId: "run_2", runOrdinal: 2 };
    setState({ projects: projects(session({ hostAlive: true, status: next })) });
    for (const run of [{ runId: "run_1", runOrdinal: 1 }, { runId: "foreign", runOrdinal: 2 }]) {
      patchSession("ses_1", { lifecycle: "stopped", hostAlive: false }, run);
      expect(getState().projects[0].sessions[0].lifecycle).toBe("running");
    }
    patchSession("ses_1", { lifecycle: "exited", hostAlive: false }, next);
    expect(getState().projects[0].sessions[0]).toMatchObject({ lifecycle: "exited", hostAlive: false });
  });

  it("does not let an old repository probe overwrite a newer event", async () => {
    const stale = deferred<RepositoryStatus>();
    apiMock.getRepositoryStatus.mockReturnValueOnce(stale.promise);
    const pending = refreshRepositoryStatus("prj_1");

    applyRepositoryStatusSnapshot(repositoryStatus("event", "feature/new"));
    stale.resolve(repositoryStatus("old-probe", "main"));
    await pending;

    expect(getState().repositoryStatuses.prj_1).toMatchObject({
      snapshotToken: "event",
      head: { branch: "feature/new" },
    });
  });

  it("optimistically applies one Project layout write and blocks overlap", async () => {
    const first = projects()[0];
    const second = { ...first, id: "prj_2", name: "Second", rootPath: "/tmp/second" };
    const original = [first, second];
    const authoritative = [
      { ...second, pinned: true },
      { ...first, pinned: false },
    ];
    setState({ projects: original });
    const write = deferred<ProjectView[]>();
    apiMock.setProjectLayout.mockReturnValueOnce(write.promise);

    const pending = saveProjectLayoutFlow([
      { id: "prj_2", pinned: true },
      { id: "prj_1", pinned: false },
    ]);

    expect(getState().projects.map((project) => project.id)).toEqual(["prj_2", "prj_1"]);
    expect(getState().projectLayoutSaving).toBe(true);
    await expect(saveProjectLayoutFlow([
      { id: "prj_1", pinned: false },
      { id: "prj_2", pinned: false },
    ])).resolves.toBe(false);
    expect(apiMock.setProjectLayout).toHaveBeenCalledTimes(1);

    write.resolve(authoritative);
    await expect(pending).resolves.toBe(true);
    expect(getState().projects).toEqual(authoritative);
    expect(getState().projectLayoutSaving).toBe(false);
  });

  it("restores the backend Project layout after a persistence failure", async () => {
    const first = projects()[0];
    const second = { ...first, id: "prj_2", name: "Second", rootPath: "/tmp/second" };
    const original = [first, second];
    setState({ projects: original });
    apiMock.setProjectLayout.mockRejectedValueOnce(new Error("write failed"));
    apiMock.listProjects.mockResolvedValueOnce(original);

    await expect(saveProjectLayoutFlow([
      { id: "prj_2", pinned: true },
      { id: "prj_1", pinned: false },
    ])).resolves.toBe(false);

    expect(getState().projects).toEqual(original);
    expect(getState().projectLayoutSaving).toBe(false);
    expect(getState().announcement).toContain("保存项目顺序失败");
    expect(getState().toasts[getState().toasts.length - 1]?.text).toContain("write failed");
  });

  it("merges a successful layout onto a newer Project snapshot", async () => {
    const first = projects(session())[0];
    const second = { ...first, id: "prj_2", name: "Second", rootPath: "/tmp/second", sessions: [] };
    const newerFirst = projects(session({ lifecycle: "exited" }))[0];
    setState({ projects: [first, second] });
    const write = deferred<ProjectView[]>();
    apiMock.setProjectLayout.mockReturnValueOnce(write.promise);

    const pending = saveProjectLayoutFlow([
      { id: "prj_2", pinned: true },
      { id: "prj_1", pinned: false },
    ]);
    applyProjectsSnapshot([newerFirst, second]);
    write.resolve([
      { ...second, pinned: true },
      { ...first, pinned: false },
    ]);
    await pending;

    expect(getState().projects.map((project) => project.id)).toEqual(["prj_2", "prj_1"]);
    expect(getState().projects[1].sessions[0].lifecycle).toBe("exited");
  });

  it("does not restore a stale pre-write snapshot over a newer event", async () => {
    const first = projects(session())[0];
    const second = { ...first, id: "prj_2", name: "Second", rootPath: "/tmp/second", sessions: [] };
    const original = [first, second];
    const newer = [projects(session({ lifecycle: "exited" }))[0], second];
    const write = deferred<ProjectView[]>();
    const refresh = deferred<ProjectView[]>();
    setState({ projects: original });
    apiMock.setProjectLayout.mockReturnValueOnce(write.promise);
    apiMock.listProjects.mockReturnValueOnce(refresh.promise);

    const pending = saveProjectLayoutFlow([
      { id: "prj_2", pinned: true },
      { id: "prj_1", pinned: false },
    ]);
    write.reject(new Error("write failed"));
    await vi.waitFor(() => expect(apiMock.listProjects).toHaveBeenCalledTimes(1));
    invalidateProjectsSnapshotRequests();
    applyProjectsSnapshot(newer);
    refresh.resolve(original);
    await pending;

    expect(getState().projects).toEqual(newer);
    expect(getState().projectLayoutSaving).toBe(false);
  });

  it("archives a running Session without opening a second confirmation dialog", async () => {
    apiMock.archiveSession.mockResolvedValueOnce(undefined);
    apiMock.listProjects.mockResolvedValueOnce(projects());

    await archiveSessionFlow("ses_1");

    expect(getState().confirm).toBeNull();
    expect(apiMock.archiveSession).toHaveBeenCalledWith("ses_1");
  });

  it("hides a Session immediately while the backend archive is still pending", async () => {
    const archive = deferred<void>();
    apiMock.archiveSession.mockReturnValueOnce(archive.promise);
    apiMock.listProjects.mockResolvedValueOnce(projects());
    await act(async () => {
      render(createElement(Sidebar, { collapsed: false, width: 296 }));
    });

    let pending!: Promise<void>;
    act(() => {
      pending = archiveSessionFlow("ses_1");
    });

    expect(screen.queryByRole("button", { name: "Session，Shell" })).toBeNull();
    await act(async () => {
      archive.resolve();
      await pending;
    });
    await waitFor(() => expect(getState().archivingSessionIds).toEqual([]));
  });

  it("restores the Session row when the backend archive fails", async () => {
    apiMock.archiveSession.mockRejectedValueOnce(new Error("stop failed"));
    await act(async () => {
      render(createElement(Sidebar, { collapsed: false, width: 296 }));
    });

    await act(async () => {
      await archiveSessionFlow("ses_1");
    });

    expect(screen.getByRole("button", { name: "Session，Shell" })).toBeTruthy();
  });
});
