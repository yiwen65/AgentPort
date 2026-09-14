// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { selectSessionMock } = vi.hoisted(() => ({
  selectSessionMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  ackTimelineFlow: vi.fn(),
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
  logPath: "/tmp/output.log",
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
  evidence: "recovery:output-during-gui-closed",
  occurredAt: "2026-09-14T00:00:00Z",
  statusCursor: null,
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
        waiting: 0,
        failed: 0,
        entries: [entry],
        ackSnapshots: [],
      },
      timelineError: null,
      timelineMessage: null,
      dialog: { kind: "timeline" },
      toasts: [],
    });
  });

  afterEach(cleanup);

  it("opens the Session at latest output without forwarding its historical cursor", () => {
    const view = render(<TimelineDialog />);

    fireEvent.click(view.container.querySelector(".timeline-row")!);

    expect(selectSessionMock).toHaveBeenCalledWith(session.id);
    expect(selectSessionMock).toHaveBeenCalledTimes(1);
  });
});
