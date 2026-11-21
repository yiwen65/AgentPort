// @vitest-environment jsdom
// An external process (the AgentPort MCP server) can only ask the renderer to
// show a Session. These regressions pin the two behaviours that matter: it must
// not steal a multi-pane workspace, and it must not drop the request when the
// sidebar snapshot is still catching up.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    archiveSession: vi.fn(),
    deleteArchivedSession: vi.fn(),
    listProjects: vi.fn(),
    markSessionSeen: vi.fn(),
    restartSession: vi.fn(),
    stopSession: vi.fn(),
  },
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));

vi.mock("./terminals", () => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  attachHandle: vi.fn().mockResolvedValue(undefined),
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  MAX_PERSISTENT_TERMINALS: 1,
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import {
  applyExternalPaneCommand,
  closeSessionPaneForExternalAgent,
  openSessionForExternalAgent,
  splitSessionForExternalAgent,
} from "./actions";
import {
  orderedLayoutSessionIds,
  singletonPaneLayout,
  splitPane,
} from "./paneLayout";
import { getState, setState } from "./store";
import type { SessionView } from "./types";

const baseSession = {
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
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-11-20T00:00:00.000Z",
};

const watchingSession = { ...baseSession, id: "ses_watching", title: "watching" };
const agentSession = { ...baseSession, id: "ses_agent", title: "agent" };
const secondAgentSession = { ...baseSession, id: "ses_agent_2", title: "agent 2" };

const projectWith = (...sessions: SessionView[]) => [
  {
    id: "prj_1",
    name: "Project",
    rootPath: "/tmp/project",
    gitRootPath: null,
    pinned: false,
    sessions,
    worktrees: [],
  },
];

describe("openSessionForExternalAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    // Selection acknowledges the Session; keep that unrelated write pending so
    // each case owns the snapshots it resolves.
    apiMock.markSessionSeen.mockReturnValue(new Promise(() => undefined));
  });

  it("selects the Session in a single-pane workspace", () => {
    setState({
      projects: projectWith(baseSession, agentSession),
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

    expect(openSessionForExternalAgent("ses_agent")).toBe(true);
    expect(getState().activeSessionId).toBe("ses_agent");
  });

  it("adds a pane beside the focused one instead of replacing a split workspace", () => {
    const layout = splitPane(
      singletonPaneLayout("ses_watching"),
      "ses_watching",
      "ses_old",
      "right",
    );
    setState({
      projects: projectWith(baseSession, watchingSession, agentSession),
      activeSessionId: "ses_old",
      terminalLayout: layout,
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_watching", "ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });

    expect(openSessionForExternalAgent("ses_agent")).toBe(true);
    const ids = orderedLayoutSessionIds(getState().terminalLayout);
    expect(ids).toContain("ses_watching");
    expect(ids).toContain("ses_old");
    expect(ids).toContain("ses_agent");
    expect(getState().activeSessionId).toBe("ses_agent");
  });

  it("keeps the previous focus when the caller does not ask for it", () => {
    // `splitPane` focuses the newly split pane, so the workspace focus is the
    // second Session here; that is what must survive a focus=false request.
    const layout = splitPane(
      singletonPaneLayout("ses_watching"),
      "ses_watching",
      "ses_old",
      "right",
    );
    setState({
      projects: projectWith(baseSession, watchingSession, agentSession),
      activeSessionId: "ses_old",
      terminalLayout: layout,
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_watching", "ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });

    expect(openSessionForExternalAgent("ses_agent", false)).toBe(true);
    expect(getState().activeSessionId).toBe("ses_old");
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toContain(
      "ses_agent",
    );
  });

  it("splits a pane in either direction and focuses the new one", () => {
    for (const direction of ["right", "down"] as const) {
      setState({
        projects: projectWith(baseSession, agentSession),
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
      expect(splitSessionForExternalAgent(direction, "ses_agent", null)).toBe(true);
      const ids = orderedLayoutSessionIds(getState().terminalLayout);
      expect(ids).toContain("ses_old");
      expect(ids).toContain("ses_agent");
      expect(getState().activeSessionId).toBe("ses_agent");
    }
  });

  it("splits beside an explicit target pane", () => {
    const layout = splitPane(
      singletonPaneLayout("ses_watching"),
      "ses_watching",
      "ses_old",
      "right",
    );
    setState({
      projects: projectWith(baseSession, watchingSession, agentSession),
      // `splitPane` focuses the new pane, so the workspace focus is `ses_old`.
      activeSessionId: "ses_old",
      terminalLayout: layout,
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_watching", "ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });
    expect(
      splitSessionForExternalAgent("down", "ses_agent", "ses_old", false),
    ).toBe(true);
    const ids = orderedLayoutSessionIds(getState().terminalLayout);
    expect(ids).toHaveLength(3);
    // focus=false keeps the user's focus where it was, not on the new pane.
    expect(getState().activeSessionId).toBe("ses_old");
  });

  it("focuses instead of duplicating a Session already on screen", () => {
    const layout = splitPane(
      singletonPaneLayout("ses_watching"),
      "ses_watching",
      "ses_old",
      "right",
    );
    setState({
      projects: projectWith(baseSession, watchingSession),
      activeSessionId: "ses_watching",
      terminalLayout: layout,
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_watching", "ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });
    expect(splitSessionForExternalAgent("down", "ses_old", null)).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toHaveLength(2);
    expect(getState().activeSessionId).toBe("ses_old");
  });

  it("closes a pane without touching the Session", () => {
    const layout = splitPane(
      singletonPaneLayout("ses_watching"),
      "ses_watching",
      "ses_old",
      "right",
    );
    setState({
      projects: projectWith(baseSession, watchingSession),
      activeSessionId: "ses_old",
      terminalLayout: layout,
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: ["ses_watching", "ses_old"],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });
    expect(closeSessionPaneForExternalAgent("ses_old")).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      "ses_watching",
    ]);
  });

  it("applies a batch pane intent in one balanced layout update", () => {
    const layoutElement = document.createElement("div");
    layoutElement.className = "pane-layout";
    Object.defineProperty(layoutElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width: 1200,
        height: 800,
        left: 0,
        top: 0,
        right: 1200,
        bottom: 800,
      }),
    });
    document.body.append(layoutElement);
    setState({
      projects: projectWith(baseSession, agentSession, secondAgentSession),
      activeSessionId: baseSession.id,
      terminalLayout: singletonPaneLayout(baseSession.id),
      terminalLayoutGroups: [],
      maximizedSessionId: null,
      attachedIds: [baseSession.id],
      dialog: null,
      confirm: null,
      toasts: [],
      archivingSessionIds: [],
    });

    expect(
      applyExternalPaneCommand({
        kind: "batch_pane",
        sessionId: agentSession.id,
        sessionIds: [agentSession.id, secondAgentSession.id],
      }),
    ).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toEqual([
      baseSession.id,
      agentSession.id,
      secondAgentSession.id,
    ]);
    expect(getState().activeSessionId).toBe(secondAgentSession.id);
  });

  it("routes queued intents and ignores unknown kinds", () => {
    setState({
      projects: projectWith(baseSession, agentSession),
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
    expect(
      applyExternalPaneCommand({
        kind: "split_pane",
        sessionId: "ses_agent",
        direction: "right",
      }),
    ).toBe(true);
    expect(orderedLayoutSessionIds(getState().terminalLayout)).toContain("ses_agent");
    expect(
      applyExternalPaneCommand({ kind: "nonsense", sessionId: "ses_agent" }),
    ).toBe(false);
  });

  it("retries after a refresh when the Session is not in the tree yet", async () => {
    apiMock.listProjects.mockResolvedValue(
      projectWith(baseSession, agentSession),
    );
    setState({
      projects: projectWith(baseSession),
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

    expect(openSessionForExternalAgent("ses_agent")).toBe(false);
    await vi.waitFor(() =>
      expect(getState().activeSessionId).toBe("ses_agent"),
    );
  });
});
