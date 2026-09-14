// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getTimeline: vi.fn(), ackTimeline: vi.fn(), listProjects: vi.fn() },
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

import { ackTimelineFlow, refreshTimeline } from "./actions";
import { getState, setState } from "./store";

const timeline = (id: string) => ({
  completed: 0,
  waiting: 0,
  failed: 0,
  entries: [{ sessionId: id }],
  ackSnapshots: [],
});

describe("refreshTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({ timeline: timeline("initial") as never, timelineError: null, timelineMessage: null });
  });

  it("does not let an older response overwrite a newer refresh", async () => {
    let firstResolve!: (value: ReturnType<typeof timeline>) => void;
    const first = new Promise<ReturnType<typeof timeline>>((resolve) => { firstResolve = resolve; });
    apiMock.getTimeline.mockReturnValueOnce(first).mockResolvedValueOnce(timeline("new"));

    const pending = refreshTimeline();
    await refreshTimeline();
    firstResolve(timeline("old"));
    await pending;

    expect(getState().timeline.entries[0]?.sessionId).toBe("new");
  });

  it("keeps the last usable timeline and exposes IPC failure", async () => {
    apiMock.getTimeline.mockRejectedValueOnce(new Error("IPC offline"));
    const ok = await refreshTimeline();
    expect(ok).toBe(false);
    expect(getState().timeline.entries[0]?.sessionId).toBe("initial");
    expect(getState().timelineMessage?.technicalDetail).toContain("IPC offline");
  });

  it("acks exactly the boot-rendered snapshot instead of refreshing live facts", async () => {
    const snapshots = [{
      sessionId: "ses_1",
      statusCursor: { runId: "run_1", runOrdinal: 1, sequence: 4 },
      logCursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 80 },
    }];
    apiMock.ackTimeline.mockResolvedValueOnce(undefined);
    apiMock.listProjects.mockResolvedValueOnce([]);
    setState({ timeline: { ...timeline("shown"), ackSnapshots: snapshots } as never });

    await ackTimelineFlow();

    expect(apiMock.ackTimeline).toHaveBeenCalledWith(snapshots);
    expect(getState().timeline.entries).toEqual([]);
    expect(getState().timeline.ackSnapshots).toEqual([]);
  });

  it("does not let a refresh started before acknowledgement restore read entries", async () => {
    let resolveRefresh!: (value: ReturnType<typeof timeline>) => void;
    const staleRefresh = new Promise<ReturnType<typeof timeline>>((resolve) => {
      resolveRefresh = resolve;
    });
    apiMock.getTimeline.mockReturnValueOnce(staleRefresh);
    apiMock.ackTimeline.mockResolvedValueOnce(undefined);
    apiMock.listProjects.mockResolvedValueOnce([]);

    const pendingRefresh = refreshTimeline();
    await ackTimelineFlow();
    resolveRefresh(timeline("already-read"));
    await pendingRefresh;

    expect(getState().timeline.entries).toEqual([]);
  });
});
