// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getHandleMock,
  loadOlderNativeHistoryMock,
  locateTerminalBufferMatchMock,
  noteTerminalScrollIntentMock,
  scrollTerminalViewportMock,
  searchTerminalBuffersMock,
} = vi.hoisted(() => ({
  getHandleMock: vi.fn(),
  loadOlderNativeHistoryMock: vi.fn().mockResolvedValue(false),
  locateTerminalBufferMatchMock: vi.fn(),
  noteTerminalScrollIntentMock: vi.fn(),
  scrollTerminalViewportMock: vi.fn(),
  searchTerminalBuffersMock: vi.fn(
    (): Array<{ buffer: "normal" | "alternate"; row: number; snippet: string }> => [],
  ),
}));

vi.mock("../actions", () => ({
  copyTextWithToast: vi.fn(),
  openNewSessionDialog: vi.fn(),
  restartSessionFlow: vi.fn(),
}));

vi.mock("../terminals", () => ({
  attachHandle: vi.fn(),
  fitSession: vi.fn(),
  focusSession: vi.fn(),
  getHandle: getHandleMock,
  loadOlderNativeHistory: loadOlderNativeHistoryMock,
  locateTerminalBufferMatch: locateTerminalBufferMatchMock,
  mountTerminal: vi.fn(),
  noteTerminalScrollIntent: noteTerminalScrollIntentMock,
  scrollTerminalViewport: scrollTerminalViewportMock,
  scrollToBottom: vi.fn(),
  setTerminalActive: vi.fn(),
  searchTerminalBuffers: searchTerminalBuffersMock,
}));

import { patchRuntime, setState } from "../store";
import type { SessionView } from "../types";
import TerminalArea, { TerminalScrollbar } from "./TerminalArea";

const session: SessionView = {
  id: "ses_1",
  projectId: "prj_1",
  worktreeId: "wt_1",
  title: "Task",
  adapter: "codex",
  cwd: "/tmp/worktree",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/session.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-07-25T00:00:00.000Z",
};

describe("terminal workspace Git notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHandleMock.mockReturnValue(undefined);
    setState({
      runtime: {},
    });
  });

  afterEach(cleanup);

  it("does not render an uncommitted Git banner above the terminal", () => {
    setState({
      activeSessionId: session.id,
      attachedIds: [],
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [{
          id: "wt_1",
          branch: "task",
          baseCommit: "a".repeat(40),
          baseRef: "main",
          path: session.cwd,
          health: "dirty",
        }],
        sessions: [session],
      }],
    });

    const { container } = render(<TerminalArea />);

    expect(container.querySelector(".workspace-banners .banner.info")).toBeNull();
  });
});

describe("terminal replay visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHandleMock.mockReturnValue(undefined);
    setState({
      activeSessionId: session.id,
      attachedIds: [session.id],
      runtime: {},
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [session],
      }],
    });
  });

  afterEach(cleanup);

  it("keeps replay covered after attach until the xterm parser boundary drains", () => {
    patchRuntime(session.id, {
      attached: true,
      attaching: false,
      replayDone: false,
    });
    const { container, rerender } = render(<TerminalArea />);

    expect(container.querySelector(".term-overlay .skeleton")).not.toBeNull();

    act(() => patchRuntime(session.id, { replayDone: true }));
    rerender(<TerminalArea />);
    expect(container.querySelector(".term-overlay .skeleton")).toBeNull();
  });

  it("keeps Restart covered after replay until Pi reports a stable startup frame", () => {
    patchRuntime(session.id, {
      attached: true,
      attaching: false,
      replayDone: true,
      startupPending: true,
    });
    const { container, rerender } = render(<TerminalArea />);

    expect(container.querySelector(".term-overlay .skeleton")).not.toBeNull();

    act(() => patchRuntime(session.id, { startupPending: false }));
    rerender(<TerminalArea />);
    expect(container.querySelector(".term-overlay .skeleton")).toBeNull();
  });
});

describe("PTY Session native history stays inside xterm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHandleMock.mockReturnValue(undefined);
    setState({
      activeSessionId: session.id,
      attachedIds: [],
      runtime: {},
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [{ ...session, lifecycle: "interrupted" }],
      }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts interrupted history behind the recovery card in the same xterm", () => {
    setState({ attachedIds: [session.id] });
    const { container } = render(<TerminalArea />);

    expect(container.querySelector(".session-state-card")).not.toBeNull();
    expect(container.querySelector(".term-host")).not.toBeNull();
    expect(container.querySelector(".native-history-pane")).toBeNull();
  });

  it("mounts stopped history in xterm instead of switching to a history page", () => {
    const ended = { ...session, lifecycle: "stopped" as const };
    setState({
      activeSessionId: ended.id,
      attachedIds: [ended.id],
      runtime: {},
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [ended],
      }],
    });
    const { container } = render(<TerminalArea />);
    expect(container.querySelector(".term-host")).not.toBeNull();
    expect(container.querySelector(".session-state-card")).not.toBeNull();
    expect(container.querySelector(".native-history-pane")).toBeNull();
  });

  it("loads the previous native page directly into xterm at the normal-buffer top", () => {
    setState({
      activeSessionId: session.id,
      attachedIds: [session.id],
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [session],
      }],
    });
    getHandleMock.mockReturnValue({
      term: {
        onScroll: vi.fn(() => ({ dispose: vi.fn() })),
        onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
        buffer: {
          active: { type: "normal", viewportY: 0, baseY: 10_000 },
        },
      },
    });
    const { container } = render(<TerminalArea />);
    const pane = container.querySelector<HTMLElement>(".term-pane:not(.hidden)");
    expect(pane).not.toBeNull();
    if (!pane) return;

    fireEvent.wheel(pane, { deltaY: -48 });

    expect(loadOlderNativeHistoryMock).toHaveBeenCalledWith(session.id);
    expect(container.querySelector(".native-history-pane.live")).toBeNull();
  });

  it("does not steal upward wheel input from an alternate-screen TUI", () => {
    setState({
      activeSessionId: session.id,
      attachedIds: [session.id],
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [session],
      }],
    });
    getHandleMock.mockReturnValue({
      term: {
        onScroll: vi.fn(() => ({ dispose: vi.fn() })),
        onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
        buffer: {
          active: { type: "alternate", viewportY: 0, baseY: 0 },
        },
      },
    });
    const { container } = render(<TerminalArea />);
    const pane = container.querySelector<HTMLElement>(".term-pane:not(.hidden)");
    expect(pane).not.toBeNull();
    if (!pane) return;

    fireEvent.wheel(pane, { deltaY: -48 });

    expect(loadOlderNativeHistoryMock).not.toHaveBeenCalled();
    expect(container.querySelector(".native-history-pane.live")).toBeNull();
  });
});

describe("terminal search navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchTerminalBuffersMock.mockReturnValue([
      { buffer: "normal", row: 10, snippet: "first x" },
      { buffer: "normal", row: 20, snippet: "second x" },
    ]);
  });

  afterEach(() => {
    cleanup();
    setState({ termSearchOpen: false });
  });

  it("uses SearchAddon as the only viewport authority and follows its result index", () => {
    let resultListener:
      | ((result: { resultIndex: number; resultCount: number }) => void)
      | undefined;
    let nextIndex = 0;
    const search = {
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => {
        resultListener?.({ resultIndex: nextIndex, resultCount: 2 });
        nextIndex = (nextIndex + 1) % 2;
        return true;
      }),
      findPrevious: vi.fn(() => true),
      onDidChangeResults: vi.fn(
        (listener: (result: { resultIndex: number; resultCount: number }) => void) => {
          resultListener = listener;
          return { dispose: vi.fn() };
        },
      ),
    };
    getHandleMock.mockReturnValue({
      search,
      term: {
        buffer: { active: { type: "normal" } },
        onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      },
    });
    setState({
      activeSessionId: session.id,
      attachedIds: [],
      termSearchOpen: true,
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/tmp/project",
        gitRootPath: "/tmp/project",
        pinned: false,
        worktrees: [],
        sessions: [session],
      }],
    });
    const { container } = render(<TerminalArea />);
    const input = screen.getByRole("textbox", { name: "搜索终端历史" });

    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(search.findNext).toHaveBeenCalledTimes(2);
    expect(noteTerminalScrollIntentMock).toHaveBeenCalledTimes(2);
    expect(searchTerminalBuffersMock).not.toHaveBeenCalled();
    expect(locateTerminalBufferMatchMock).not.toHaveBeenCalled();
    expect(container.querySelector(".term-search .count")?.textContent).toContain("2/2");
  });
});

describe("terminal scrollbar", () => {
  let animationFrames: FrameRequestCallback[];
  let scrollListener: ((position: number) => void) | undefined;
  let writeListener: (() => void) | undefined;
  let viewportY: number;
  let viewportReadCount: number;
  let activeBuffer: { baseY: number; readonly viewportY: number };
  let normalBuffer: { baseY: number; readonly viewportY: number };

  beforeEach(() => {
    vi.clearAllMocks();
    animationFrames = [];
    scrollListener = undefined;
    writeListener = undefined;
    viewportY = 500;
    viewportReadCount = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    normalBuffer = {
      baseY: 1_000,
      get viewportY() {
        viewportReadCount += 1;
        return viewportY;
      },
    };
    activeBuffer = normalBuffer;
    getHandleMock.mockReturnValue({
      term: {
        buffer: {
          get active() {
            return activeBuffer;
          },
        },
        onScroll: vi.fn((listener: (position: number) => void) => {
          scrollListener = listener;
          return { dispose: vi.fn() };
        }),
        onWriteParsed: vi.fn((listener: () => void) => {
          writeListener = listener;
          return { dispose: vi.fn() };
        }),
        scrollLines: vi.fn(),
        scrollPages: vi.fn(),
        scrollToBottom: vi.fn(),
        scrollToLine: vi.fn(),
        scrollToTop: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function flushAnimationFrame() {
    const callbacks = animationFrames.splice(0);
    act(() => {
      for (const callback of callbacks) callback(performance.now());
    });
  }

  it("does not subscribe hidden panes to scrollbar updates", () => {
    const handle = getHandleMock();
    render(<TerminalScrollbar sessionId="ses_scroll" active={false} />);
    flushAnimationFrame();

    expect(handle.term.onScroll).not.toHaveBeenCalled();
    expect(handle.term.onWriteParsed).not.toHaveBeenCalled();
  });

  it("uses xterm's canonical scroll position while the buffer getter is stale", () => {
    render(<TerminalScrollbar sessionId="ses_scroll" />);
    flushAnimationFrame();

    act(() => scrollListener?.(250));
    flushAnimationFrame();

    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("250");
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuetext")).toBe("25%");
  });

  it("coalesces a burst of xterm scroll events to one position read per frame", () => {
    render(<TerminalScrollbar sessionId="ses_scroll" />);
    flushAnimationFrame();
    const readsBeforeBurst = viewportReadCount;

    act(() => {
      for (let position = 1; position <= 500; position += 1) {
        scrollListener?.(position);
      }
    });

    expect(viewportReadCount).toBe(readsBeforeBurst);
    flushAnimationFrame();
    expect(viewportReadCount - readsBeforeBurst).toBeLessThanOrEqual(1);
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("500");
  });

  it("refreshes the scrollback limit after parsed output", () => {
    render(<TerminalScrollbar sessionId="ses_scroll" />);
    flushAnimationFrame();
    viewportY = 650;

    act(() => writeListener?.());
    flushAnimationFrame();

    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("650");
  });

  it("routes keyboard viewport commands through the centralized authority", () => {
    render(<TerminalScrollbar sessionId="ses_scroll" />);
    flushAnimationFrame();
    const scrollbar = screen.getByRole("scrollbar");

    fireEvent.keyDown(scrollbar, { key: "PageUp" });
    fireEvent.keyDown(scrollbar, { key: "End" });

    expect(scrollTerminalViewportMock).toHaveBeenNthCalledWith(1, "ses_scroll", {
      type: "pages",
      amount: -1,
    });
    expect(scrollTerminalViewportMock).toHaveBeenNthCalledWith(2, "ses_scroll", {
      type: "bottom",
    });
  });

  it("does not reuse an alternate-buffer scroll position after returning to normal", () => {
    viewportY = 700;
    render(<TerminalScrollbar sessionId="ses_scroll" />);
    flushAnimationFrame();
    flushAnimationFrame();

    activeBuffer = { baseY: 0, viewportY: 0 };
    act(() => scrollListener?.(0));
    activeBuffer = normalBuffer;
    act(() => writeListener?.());
    flushAnimationFrame();

    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("700");
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuetext")).toBe("70%");
  });
});
