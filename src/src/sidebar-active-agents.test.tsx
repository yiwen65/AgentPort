// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listWorktreesMock,
  refreshRepositoryStatusMock,
  selectSessionMock,
} = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(),
  refreshRepositoryStatusMock: vi.fn(),
  selectSessionMock: vi.fn(),
}));

vi.mock("./actions", () => ({
  archiveSessionFlow: vi.fn(),
  interruptSessionFlow: vi.fn(),
  openNewSessionDialog: vi.fn(),
  removeProjectFlow: vi.fn(),
  removeWorktreeFlow: vi.fn(),
  renameProjectFlow: vi.fn(),
  renameSessionInlineFlow: vi.fn(),
  resumeSessionFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  quickStartSession: vi.fn(),
  addProjectFromPickerFlow: vi.fn(),
  removeSessionFlow: vi.fn(),
  selectSession: selectSessionMock,
  stopSessionFlow: vi.fn(),
  refreshRepositoryStatus: refreshRepositoryStatusMock,
  saveProjectLayoutFlow: vi.fn(),
  toggleSessionPinFlow: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    revealInFileManager: vi.fn(),
    openInSystemTerminal: vi.fn(),
    worktreeStatusText: vi.fn(),
    listWorktrees: listWorktreesMock,
  },
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
}));

import Sidebar, {
  orderActiveAgentSessionsForSidebar,
} from "./components/Sidebar";
import { emptyRuntime, setState } from "./store";
import type {
  AgentStateStr,
  ProjectView,
  RepositoryStatus,
  SessionView,
} from "./types";

const occurredAt = (minute: number) =>
  `2026-09-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

function session(
  id: string,
  state: AgentStateStr | null,
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    id,
    projectId: "prj_apollo",
    worktreeId: null,
    title: id,
    adapter: "codex",
    cwd: "/tmp/apollo",
    lifecycle: "running",
    hostAlive: true,
    agentSessionId: null,
    resumePrecision: "unavailable",
    permissionMode: "native",
    transport: "pty",
    logPath: `/tmp/${id}.log`,
    unread: false,
    status: state
      ? {
          sessionId: id,
          runId: `run_${id}`,
          runOrdinal: 1,
          sequence: 1,
          state,
          source: "adapter",
          confidence: "high",
          evidence: null,
          logCursor: null,
          occurredAt: occurredAt(10),
        }
      : null,
    pinnedAt: null,
    createdAt: occurredAt(1),
    ...overrides,
  };
}

const repositoryStatus: RepositoryStatus = {
  projectId: "prj_apollo",
  isGitRepository: true,
  checkoutRoot: "/tmp/apollo",
  repoKey: "repo-apollo",
  head: { kind: "branch", branch: "main" },
  changes: {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    unmerged: 0,
    dirtySubmodules: 0,
  },
  ongoingOperation: null,
  liveSessionIds: [],
  pendingAutoStashes: 0,
  observedAt: occurredAt(9),
  snapshotToken: "snapshot",
};

function projects(): ProjectView[] {
  return [
    {
      id: "prj_apollo",
      name: "Apollo",
      rootPath: "/tmp/apollo",
      gitRootPath: "/tmp/apollo",
      pinned: false,
      worktrees: [
        {
          id: "wt_feature",
          branch: "feature/live-view",
          baseCommit: "a".repeat(40),
          baseRef: "main",
          path: "/tmp/apollo-feature",
          health: "clean",
        },
      ],
      sessions: [
        session("Needs review", "needs_input"),
        session("Worktree idle", "idle", {
          adapter: "claude",
          worktreeId: "wt_feature",
        }),
        session("Shell terminal", "working", { adapter: "shell" }),
        session("Dead agent", "working", { hostAlive: false }),
      ],
    },
    {
      id: "prj_notes",
      name: "Notes",
      rootPath: "/tmp/notes",
      gitRootPath: null,
      pinned: false,
      worktrees: [],
      sessions: [
        session("Unknown agent", null, {
          projectId: "prj_notes",
          cwd: "/tmp/notes",
          createdAt: occurredAt(20),
        }),
      ],
    },
    {
      id: "prj_inactive",
      name: "Inactive",
      rootPath: "/tmp/inactive",
      gitRootPath: "/tmp/inactive",
      pinned: false,
      worktrees: [],
      sessions: [
        session("Inactive shell", "working", {
          projectId: "prj_inactive",
          adapter: "shell",
          hostAlive: false,
          cwd: "/tmp/inactive",
        }),
      ],
    },
  ];
}

describe("active Agent sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorktreesMock.mockResolvedValue([]);
    refreshRepositoryStatusMock.mockResolvedValue(null);
    setState({
      projects: projects(),
      adapters: [],
      activeSessionId: null,
      attachedIds: [],
      runtime: {},
      archivingSessionIds: [],
      repositoryStatuses: { prj_apollo: repositoryStatus },
      sidebarViewMode: "activeAgents",
      sidebarWorktreeProjectId: "prj_apollo",
      highlightedWorktreeId: null,
      expandedProjects: {},
      collapsedWorktrees: {},
      projectLayoutSaving: false,
      contextMenu: null,
    });
  });

  afterEach(cleanup);

  it("orders attention, working, idle and unknown with pinning inside a bucket", () => {
    const pinnedAttention = session("pinned-attention", "needs_input", {
      pinnedAt: occurredAt(2),
      status: {
        ...session("template", "needs_input").status!,
        sessionId: "pinned-attention",
        occurredAt: occurredAt(2),
      },
    });
    const suspended = session("suspended", null, {
      createdAt: occurredAt(19),
    });
    const unread = session("unread", "idle", {
      unread: true,
      status: {
        ...session("template", "idle").status!,
        sessionId: "unread",
        occurredAt: occurredAt(18),
      },
    });
    const working = session("working", "working");
    const creating = session("creating", null, { lifecycle: "creating" });
    const idle = session("idle", "idle");
    const unknown = session("unknown", null);

    expect(
      orderActiveAgentSessionsForSidebar(
        [unknown, idle, creating, working, unread, suspended, pinnedAttention],
        new Set(["suspended"]),
      ).map((item) => item.id),
    ).toEqual([
      "pinned-attention",
      "suspended",
      "unread",
      "working",
      "creating",
      "idle",
      "unknown",
    ]);
  });

  it("renders one global flat list with compact project and branch sources", () => {
    render(<Sidebar collapsed={false} width={296} />);

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Needs review"),
      expect.stringContaining("Shell terminal"),
      expect.stringContaining("Worktree idle"),
      expect.stringContaining("Unknown agent"),
    ]);
    expect(screen.queryByText("Inactive shell")).toBeNull();
    expect(screen.queryByText("Dead agent")).toBeNull();
    expect(screen.getAllByText("Apollo · main")).toHaveLength(2);
    expect(screen.getByText("Apollo · feature/live-view")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apollo" })).toBeNull();
    expect(screen.queryByLabelText("折叠所有项目与 Session")).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加项目" })).toBeTruthy();
    expect(refreshRepositoryStatusMock).toHaveBeenCalledWith("prj_apollo");
    expect(refreshRepositoryStatusMock).toHaveBeenCalledWith("prj_notes");
    expect(refreshRepositoryStatusMock).not.toHaveBeenCalledWith("prj_inactive");

    refreshRepositoryStatusMock.mockClear();
    act(() => setState({ archivingSessionIds: ["Unknown agent"] }));
    expect(refreshRepositoryStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshRepositoryStatusMock).toHaveBeenCalledWith("prj_apollo");

    refreshRepositoryStatusMock.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(refreshRepositoryStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshRepositoryStatusMock).toHaveBeenCalledWith("prj_apollo");
  });

  it("keeps the active view selected when a Session row is activated", () => {
    render(<Sidebar collapsed={false} width={296} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Needs review，Codex，来源 Apollo · main",
      }),
    );

    expect(selectSessionMock).toHaveBeenCalledWith("Needs review");
    fireEvent.click(screen.getByRole("button", { name: /^Shell terminal，/ }));
    expect(selectSessionMock).toHaveBeenCalledWith("Shell terminal");
  });

  it("excludes dead and archiving shells from the active list", () => {
    setState({
      archivingSessionIds: ["Archiving shell"],
      projects: [
        {
          ...projects()[0],
          sessions: [
            session("Dead shell", "working", { adapter: "shell", hostAlive: false }),
            session("Archiving shell", "working", { adapter: "shell" }),
            session("Dead only", "idle", { hostAlive: false }),
          ],
        },
      ],
    });

    render(<Sidebar collapsed={false} width={296} />);

    expect(screen.getByRole("status").textContent).toBe(
      "暂无活跃 Agent Session",
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("promotes a suspended Host without subscribing to unrelated runtime fields", () => {
    setState({
      runtime: {
        "Unknown agent": {
          ...emptyRuntime(),
          suspended: true,
          logBytes: 99,
        },
      },
    });

    render(<Sidebar collapsed={false} width={296} />);

    expect(screen.getAllByRole("listitem")[0].textContent).toContain(
      "Unknown agent",
    );
  });
});
