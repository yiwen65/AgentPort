// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listProjects: vi.fn(),
    setSessionPinned: vi.fn(),
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

import { toggleSessionPinFlow } from "./actions";
import { orderSessionsForSidebar } from "./components/Sidebar";
import { applyProjectsSnapshot, getState, setState } from "./store";
import type { ProjectView, SessionView } from "./types";

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
  pinnedAt: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  ...overrides,
});

const project = (sessions: SessionView[]): ProjectView => ({
  id: "prj_1",
  name: "Project",
  rootPath: "/tmp/project",
  gitRootPath: null,
  pinned: false,
  sessions,
  worktrees: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  setState({ projects: [project([session()])], activeSessionId: null });
});

describe("toggleSessionPinFlow", () => {
  it("patches the pin optimistically and persists it through the backend", async () => {
    apiMock.setSessionPinned.mockResolvedValue(undefined);

    await toggleSessionPinFlow("ses_1");

    expect(apiMock.setSessionPinned).toHaveBeenCalledWith("ses_1", true);
    const pinned = getState().projects[0].sessions[0].pinnedAt;
    expect(pinned).not.toBeNull();
    expect(Number.isNaN(Date.parse(pinned!))).toBe(false);
  });

  it("unpins a pinned session", async () => {
    setState({
      projects: [
        project([session({ pinnedAt: "2026-07-24T00:00:00.000Z" })]),
      ],
    });
    apiMock.setSessionPinned.mockResolvedValue(undefined);

    await toggleSessionPinFlow("ses_1");

    expect(apiMock.setSessionPinned).toHaveBeenCalledWith("ses_1", false);
    expect(getState().projects[0].sessions[0].pinnedAt).toBeNull();
  });

  it("keeps the backend timestamp once the authoritative snapshot arrives", async () => {
    apiMock.setSessionPinned.mockResolvedValue(undefined);

    await toggleSessionPinFlow("ses_1");
    applyProjectsSnapshot([
      project([session({ pinnedAt: "2026-07-24T10:00:00.000Z" })]),
    ]);

    expect(getState().projects[0].sessions[0].pinnedAt).toBe(
      "2026-07-24T10:00:00.000Z",
    );
  });

  it("rolls the optimistic pin back when the backend write fails", async () => {
    apiMock.setSessionPinned.mockRejectedValue(new Error("SQLITE_FULL"));
    apiMock.listProjects.mockResolvedValue([project([session()])]);

    await toggleSessionPinFlow("ses_1");

    expect(getState().projects[0].sessions[0].pinnedAt).toBeNull();
  });
});

describe("orderSessionsForSidebar", () => {
  it("orders pinned sessions by latest pin, then unpinned by newest first", () => {
    const ordered = orderSessionsForSidebar([
      session({ id: "new", createdAt: "2026-07-25T00:00:00.000Z" }),
      session({
        id: "pinned-old",
        createdAt: "2026-07-20T00:00:00.000Z",
        pinnedAt: "2026-07-24T09:00:00.000Z",
      }),
      session({ id: "old", createdAt: "2026-07-21T00:00:00.000Z" }),
      session({
        id: "pinned-new",
        createdAt: "2026-07-19T00:00:00.000Z",
        pinnedAt: "2026-07-24T10:00:00.000Z",
      }),
    ]);

    expect(ordered.map((s) => s.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "new",
      "old",
    ]);
  });
});
