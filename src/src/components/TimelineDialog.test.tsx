// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dismissTimelineEntryMock, selectSessionMock } = vi.hoisted(() => ({
  dismissTimelineEntryMock: vi.fn(),
  selectSessionMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  ackTimelineFlow: vi.fn(),
  dismissTimelineEntry: dismissTimelineEntryMock,
  refreshTimeline: vi.fn(),
  selectSession: selectSessionMock,
}));

import { setState } from "../store";
import type { SessionView, TimelineEntry } from "../types";
import TimelineDialog from "./TimelineDialog";

const session: SessionView = {
  id: "ses_timeline",
  projectId: "prj_1",
  worktreeId: null,
  title: "Timeline Session",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: true,
  status: null,
  pinnedAt: null,
  createdAt: "2026-09-14T00:00:00Z",
};

const entry: TimelineEntry = {
  sessionId: session.id,
  sessionTitle: session.title,
  projectName: "Project",
  adapterType: "shell",
  state: "idle",
  source: "process",
  confidence: "high",
  evidence: "hook:Stop",
  occurredAt: "2026-09-14T00:00:00Z",
  statusCursor: { runId: "run_1", runOrdinal: 1, sequence: 3 },
  logCursor: {
    runId: "run_1",
    runOrdinal: 1,
    generation: 0,
    offset: 128,
  },
  logOffset: 128,
  rotatedAway: false,
  locationUnavailableReason: null,
};

const waitingEntry: TimelineEntry = {
  ...entry,
  state: "needs_input",
  evidence: "hook:PermissionRequest",
  statusCursor: { runId: "run_1", runOrdinal: 1, sequence: 4 },
};

const failedEntry: TimelineEntry = {
  ...entry,
  state: "exited",
  evidence: "process:signal:9",
  statusCursor: { runId: "run_1", runOrdinal: 1, sequence: 5 },
};

const outputOnlyEntry: TimelineEntry = {
  ...entry,
  state: "working",
  evidence: "recovery:output-during-gui-closed",
  statusCursor: null,
  logCursor: null,
};

describe("TimelineDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: null,
        pinned: false,
        sessions: [session],
        worktrees: [],
      }],
      timeline: {
        completed: 1,
        waiting: 1,
        failed: 1,
        entries: [entry, waitingEntry, failedEntry, outputOnlyEntry],
        ackSnapshots: [],
      },
      timelineError: null,
      timelineMessage: null,
      dialog: { kind: "timeline" },
      toasts: [],
    });
  });

  afterEach(cleanup);

  it("lists only completed and waiting entries without technical labels", () => {
    const view = render(<TimelineDialog />);

    expect(view.container.querySelectorAll(".timeline-row")).toHaveLength(2);
    expect(
      Array.from(view.container.querySelectorAll(".timeline-kind")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["已完成", "等待批准"]);
    expect(screen.queryByText(/置信度/)).toBeNull();
    expect(screen.queryByText(/空闲|Hook|PTY/)).toBeNull();
  });

  it("opens the Session and dismisses the clicked entry", () => {
    const view = render(<TimelineDialog />);

    fireEvent.click(view.container.querySelector(".timeline-row")!);

    expect(dismissTimelineEntryMock).toHaveBeenCalledWith(entry);
    expect(selectSessionMock).toHaveBeenCalledWith(session.id);
    expect(selectSessionMock).toHaveBeenCalledTimes(1);
  });
});
