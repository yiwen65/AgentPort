// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {},
  copyText: vi.fn(),
  errorText: (error: unknown) => String(error),
}));

vi.mock("./terminals", () => ({
  applyTerminalSettings: vi.fn(),
  applyXtermTheme: vi.fn(),
  attachHandle: vi.fn(),
  clearUnreadOutputTracking: vi.fn(),
  disposeHandle: vi.fn(),
  jumpToRecoveryOutput: vi.fn(),
  pruneHandles: vi.fn(),
  releaseTerminal: vi.fn(),
  resetForRestart: vi.fn(),
}));

import {
  toggleActiveAgentsView,
  toggleSidebarCollapsed,
} from "./actions";
import { getState, setState } from "./store";

describe("active-Agent sidebar view toggle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState({
      sidebarViewMode: "projects",
      sidebarCollapsed: false,
      sidebarAnim: null,
      reducedMotion: false,
      sidebarWorktreeProjectId: "project-1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setState({
      sidebarViewMode: "projects",
      sidebarCollapsed: false,
      sidebarAnim: null,
      sidebarWorktreeProjectId: null,
    });
  });

  it("switches both ways without clearing the Worktree context", () => {
    toggleActiveAgentsView();
    expect(getState().sidebarViewMode).toBe("activeAgents");
    expect(getState().sidebarWorktreeProjectId).toBe("project-1");

    toggleActiveAgentsView();
    expect(getState().sidebarViewMode).toBe("projects");
    expect(getState().sidebarCollapsed).toBe(false);
    expect(getState().sidebarWorktreeProjectId).toBe("project-1");
  });

  it("cancels an in-flight collapse when the active view is requested", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    toggleSidebarCollapsed();
    expect(getState().sidebarAnim).toBe("out");

    toggleActiveAgentsView();
    expect(getState().sidebarViewMode).toBe("activeAgents");
    expect(getState().sidebarCollapsed).toBe(false);
    expect(getState().sidebarAnim).toBe("inPrep");

    vi.advanceTimersByTime(180);
    expect(getState().sidebarCollapsed).toBe(false);
    frames.shift()?.(0);
    frames.shift()?.(0);
    vi.advanceTimersByTime(180);
    expect(getState().sidebarAnim).toBeNull();
  });

  it("reuses the existing expand animation when entering from collapsed", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    setState({ sidebarCollapsed: true });

    toggleActiveAgentsView();

    expect(getState().sidebarViewMode).toBe("activeAgents");
    expect(getState().sidebarCollapsed).toBe(false);
    expect(getState().sidebarAnim).toBe("inPrep");
    expect(getState().sidebarWorktreeProjectId).toBe("project-1");

    frames.shift()?.(0);
    frames.shift()?.(0);
    expect(getState().sidebarAnim).toBe("in");
    vi.advanceTimersByTime(180);
    expect(getState().sidebarAnim).toBeNull();

    toggleActiveAgentsView();
    expect(getState().sidebarViewMode).toBe("projects");
    expect(getState().sidebarCollapsed).toBe(false);
  });
});
