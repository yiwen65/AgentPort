// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listWorktreesMock,
  refreshRepositoryStatusMock,
  saveProjectLayoutFlowMock,
} = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(),
  refreshRepositoryStatusMock: vi.fn(),
  saveProjectLayoutFlowMock: vi.fn(),
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
  selectSession: vi.fn(),
  stopSessionFlow: vi.fn(),
  refreshRepositoryStatus: refreshRepositoryStatusMock,
  saveProjectLayoutFlow: saveProjectLayoutFlowMock,
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

import Sidebar from "./components/Sidebar";
import { getState, setState } from "./store";
import type { ProjectView } from "./types";

function project(id: string, pinned = false): ProjectView {
  return {
    id,
    name: id.toUpperCase(),
    rootPath: `/tmp/${id}`,
    gitRootPath: null,
    pinned,
    sessions: [],
    worktrees: [],
  };
}

function pointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: 9 },
    clientX: { value: x },
    clientY: { value: y },
  });
  target.dispatchEvent(event);
}

let captured: HTMLElement | null = null;
let animationFrame: FrameRequestCallback | null = null;

describe("Project drag ordering and pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured = null;
    animationFrame = null;
    listWorktreesMock.mockResolvedValue([]);
    refreshRepositoryStatusMock.mockResolvedValue(null);
    saveProjectLayoutFlowMock.mockResolvedValue(true);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value(this: HTMLElement) {
        captured = this;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value(this: HTMLElement) {
        if (captured === this) captured = null;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value(this: HTMLElement) {
        return captured === this;
      },
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrame = callback;
      return 17;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      animationFrame = null;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("sidebar-scroll")) {
          return {
            top: 0,
            bottom: 300,
            left: 0,
            right: 300,
            width: 300,
            height: 300,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.classList.contains("tree-project-header")) {
          const wrapper = this.closest<HTMLElement>("[data-project-id]");
          const wrappers = Array.from(
            document.querySelectorAll("[data-project-id]"),
          );
          const index = wrapper ? wrappers.indexOf(wrapper) : 0;
          const top = 50 + index * 60;
          return {
            top,
            bottom: top + 30,
            left: 0,
            right: 280,
            width: 280,
            height: 30,
            x: 0,
            y: top,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    window.localStorage.removeItem("agentport-collapsed-project-ids");
    setState({
      projects: [project("a"), project("b"), project("c")],
      adapters: [],
      expandedProjects: { a: true, b: true, c: true },
      repositoryStatuses: {},
      sidebarWorktreeProjectId: null,
      projectLayoutSaving: false,
      contextMenu: null,
      announcement: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("persists an ordinary expand/collapse click without saving Project layout", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "B" });

    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointerup", 20, 115);
      fireEvent.click(row);
    });

    expect(getState().expandedProjects.b).toBe(false);
    expect(
      JSON.parse(
        window.localStorage.getItem("agentport-collapsed-project-ids") ?? "null",
      ),
    ).toEqual(["b"]);
    expect(saveProjectLayoutFlowMock).not.toHaveBeenCalled();
  });

  it("reorders only after crossing the threshold and suppresses the trailing click", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "B" });

    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointermove", 21, 113);
    });
    expect(saveProjectLayoutFlowMock).not.toHaveBeenCalled();
    expect(captured).toBe(row);

    act(() => {
      pointer(row, "pointermove", 20, 35);
      pointer(captured ?? row, "pointerup", 20, 35);
      fireEvent.click(row);
    });

    expect(saveProjectLayoutFlowMock).toHaveBeenCalledWith([
      { id: "b", pinned: false },
      { id: "a", pinned: false },
      { id: "c", pinned: false },
    ]);
    expect(getState().expandedProjects.b).toBe(true);
  });

  it("pins a Project when it is dragged across the boundary", () => {
    setState({ projects: [project("a", true), project("b"), project("c")] });
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "C" });

    act(() => {
      pointer(row, "pointerdown", 20, 175);
      pointer(row, "pointermove", 20, 35);
      pointer(captured ?? row, "pointerup", 20, 35);
    });

    expect(saveProjectLayoutFlowMock).toHaveBeenCalledWith([
      { id: "c", pinned: true },
      { id: "a", pinned: true },
      { id: "b", pinned: false },
    ]);
  });

  it("cancels an active drag with Escape", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "B" });

    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointermove", 20, 35);
    });
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
      pointer(row, "pointerup", 20, 35);
      fireEvent.click(row);
    });

    expect(saveProjectLayoutFlowMock).not.toHaveBeenCalled();
    expect(getState().expandedProjects.b).toBe(true);
    expect(getState().announcement).toContain("已取消移动项目 B");
  });

  it("restores the original order on pointer cancellation", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "B" });

    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointermove", 20, 35);
      pointer(captured ?? row, "pointercancel", 20, 35);
      fireEvent.click(row);
    });

    expect(saveProjectLayoutFlowMock).not.toHaveBeenCalled();
    expect(getState().expandedProjects.b).toBe(true);
    expect(getState().projects.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("auto-scrolls while an active drag stays at the sidebar edge", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const row = screen.getByRole("button", { name: "B" });
    const scroller = document.querySelector<HTMLElement>(".sidebar-scroll");
    expect(scroller).not.toBeNull();
    if (!scroller) throw new Error("sidebar scroller missing");
    scroller.scrollTop = 100;

    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointermove", 20, 295);
    });
    expect(animationFrame).not.toBeNull();

    act(() => animationFrame?.(0));
    expect(scroller.scrollTop).toBe(110);
  });

  it("uses the shared menus for pin and unpin, placing the item first", () => {
    setState({ projects: [project("b", true), project("a")] });
    const view = render(<Sidebar collapsed={false} width={296} />);
    fireEvent.click(screen.getByRole("button", { name: "项目 A 的更多操作" }));
    let item = getState().contextMenu?.items.find(
      (candidate) => candidate.label === "置顶项目",
    );
    act(() => item?.action?.());
    expect(saveProjectLayoutFlowMock).toHaveBeenLastCalledWith([
      { id: "a", pinned: true },
      { id: "b", pinned: true },
    ]);

    act(() => {
      setState({
        projects: [project("a", true), project("b", true)],
        contextMenu: null,
      });
    });
    view.rerender(<Sidebar collapsed={false} width={296} />);
    expect(screen.getAllByLabelText("已置顶")).toHaveLength(2);
    fireEvent.contextMenu(screen.getByRole("button", { name: "A 已置顶" }), {
      clientX: 10,
      clientY: 10,
    });
    item = getState().contextMenu?.items.find(
      (candidate) => candidate.label === "取消置顶",
    );
    act(() => item?.action?.());
    expect(saveProjectLayoutFlowMock).toHaveBeenLastCalledWith([
      { id: "b", pinned: true },
      { id: "a", pinned: false },
    ]);
  });

  it("disables layout changes while a save is active", () => {
    setState({ projectLayoutSaving: true });
    render(<Sidebar collapsed={false} width={296} />);
    fireEvent.click(screen.getByRole("button", { name: "项目 A 的更多操作" }));
    const item = getState().contextMenu?.items.find(
      (candidate) => candidate.label === "置顶项目",
    );
    expect(item?.disabled).toBe(true);

    const row = screen.getByRole("button", { name: "B" });
    act(() => {
      pointer(row, "pointerdown", 20, 115);
      pointer(row, "pointermove", 20, 35);
      pointer(row, "pointerup", 20, 35);
    });
    expect(saveProjectLayoutFlowMock).not.toHaveBeenCalled();
  });
});
