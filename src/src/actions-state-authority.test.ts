// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    archiveSession: vi.fn(),
    getRepositoryStatus: vi.fn(),
    listProjects: vi.fn(),
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
  jumpToRecoveryOutput: vi.fn(),
  MAX_PERSISTENT_TERMINALS: 3,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import { archiveSessionFlow, refreshProjects, refreshRepositoryStatus } from "./actions";
import {
  applyProjectsSnapshot,
  applyRepositoryStatusSnapshot,
  getState,
  invalidateProjectsSnapshotRequests,
  patchSession,
  resolveConfirm,
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
  logPath: "/tmp/session.log",
  unread: false,
  status: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  ...overrides,
});

const projects = (...sessions: SessionView[]): ProjectView[] => [{
  id: "prj_1",
  name: "Project",
  rootPath: "/tmp/project",
  gitRootPath: "/tmp/project",
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
      attachedIds: [],
      repositoryStatuses: {},
      runtime: {},
    });
  });

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

  it("requires confirmation before archiving a running Session", async () => {
    const pending = archiveSessionFlow("ses_1");

    expect(getState().confirm?.body).toContain("停止运行");
    expect(apiMock.archiveSession).not.toHaveBeenCalled();
    resolveConfirm(false);
    await pending;

    expect(apiMock.archiveSession).not.toHaveBeenCalled();
  });
});
