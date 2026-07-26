// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getHandleMock, refreshMock } = vi.hoisted(() => ({
  getHandleMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  copyTextWithToast: vi.fn(),
  openNewSessionDialog: vi.fn(),
  refreshActiveWorktreeStatus: refreshMock,
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

import { patchRuntime, setState } from "../store";
import type { SessionView, StatusEventView } from "../types";
import { TerminalScrollbar, UncommittedBanner } from "./TerminalArea";

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

function status(sequence: number, state: StatusEventView["state"]): StatusEventView {
  return {
    sessionId: session.id,
    runId: "run_1",
    runOrdinal: 1,
    sequence,
    state,
    source: "pty",
    confidence: "medium",
    evidence: `pty:${state}`,
    logCursor: null,
    occurredAt: `2026-07-25T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
  };
}

describe("uncommitted worktree notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHandleMock.mockReturnValue(undefined);
    setState({
      activeWorktreeStatus: {
        health: "dirty",
        modified: 1,
        staged: 0,
        untracked: 0,
        raw: " M src/example.ts",
      },
      uncommittedNotices: {},
      runtime: {},
    });
    patchRuntime(session.id, { status: status(1, "idle") });
  });

  afterEach(cleanup);

  it("stays dismissed when PTY status sequence churns for the same dirty result", () => {
    const { container } = render(<UncommittedBanner ses={session} />);
    const dismiss = container.querySelector<HTMLButtonElement>(".banner button.ghost");
    expect(dismiss).not.toBeNull();

    fireEvent.click(dismiss!);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => patchRuntime(session.id, { status: status(2, "working") }));
    act(() => patchRuntime(session.id, { status: status(3, "idle") }));

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays mounted while PTY activity briefly changes idle back to working", () => {
    render(<UncommittedBanner ses={session} />);
    expect(screen.getByRole("status")).not.toBeNull();

    act(() => patchRuntime(session.id, { status: status(2, "working") }));

    expect(screen.getByRole("status")).not.toBeNull();
  });

  it("keeps dismissal while Worktree status is temporarily unknown during Session switching", () => {
    const { container } = render(<UncommittedBanner ses={session} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>(".banner button.ghost")!);

    act(() => setState({ activeWorktreeStatus: null }));
    act(() => setState({
      activeWorktreeStatus: {
        health: "dirty",
        modified: 1,
        staged: 0,
        untracked: 0,
        raw: " M src/example.ts",
      },
    }));

    expect(screen.queryByRole("status")).toBeNull();
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
