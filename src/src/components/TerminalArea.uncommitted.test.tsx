// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getHandleMock } = vi.hoisted(() => ({
  getHandleMock: vi.fn(),
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
  loadHistoryTail: vi.fn(),
  locateTerminalBufferMatch: vi.fn(),
  mountTerminal: vi.fn(),
  scrollToBottom: vi.fn(),
  searchTerminalBuffers: vi.fn(() => []),
}));

import { setState } from "../store";
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
