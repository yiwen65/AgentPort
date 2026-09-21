// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fitSessionMock,
  focusSessionMock,
  getHandleMock,
  mountTerminalMock,
  insertTextIntoTerminalMock,
  openSplitAgentPickerMock,
  openSplitSessionDialogMock,
  persistLayoutMock,
  removePaneMock,
  removeSessionFlowMock,
  renameSessionFlowMock,
  selectSessionMock,
  setPaneSplitRatioMock,
  setTerminalActiveMock,
  splitSessionIntoPaneMock,
  restartSessionFlowMock,
  stopSessionFlowMock,
  toggleMaximizedMock,
} = vi.hoisted(() => ({
  fitSessionMock: vi.fn(),
  focusSessionMock: vi.fn(),
  getHandleMock: vi.fn(),
  mountTerminalMock: vi.fn(),
  insertTextIntoTerminalMock: vi.fn().mockReturnValue(true),
  openSplitAgentPickerMock: vi.fn(),
  openSplitSessionDialogMock: vi.fn(),
  persistLayoutMock: vi.fn(),
  removePaneMock: vi.fn(),
  removeSessionFlowMock: vi.fn(),
  renameSessionFlowMock: vi.fn(),
  selectSessionMock: vi.fn(),
  setPaneSplitRatioMock: vi.fn().mockReturnValue(true),
  setTerminalActiveMock: vi.fn(),
  splitSessionIntoPaneMock: vi.fn(),
  restartSessionFlowMock: vi.fn(),
  stopSessionFlowMock: vi.fn(),
  toggleMaximizedMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  PANE_SEPARATOR_SIZE: 6,
  canSplitSessionPane: vi.fn(() => true),
  openNewSessionDialog: vi.fn(),
  openSplitAgentPicker: openSplitAgentPickerMock,
  openSplitSessionDialog: openSplitSessionDialogMock,
  persistCurrentPaneLayout: persistLayoutMock,
  removeSessionPane: removePaneMock,
  removeSessionFlow: removeSessionFlowMock,
  renameSessionFlow: renameSessionFlowMock,
  resumeSessionFlow: vi.fn(),
  restartSessionFlow: restartSessionFlowMock,
  selectSession: selectSessionMock,
  setPaneSplitRatio: setPaneSplitRatioMock,
  splitSessionIntoPane: splitSessionIntoPaneMock,
  stopSessionFlow: stopSessionFlowMock,
  toggleSessionPaneMaximized: toggleMaximizedMock,
}));

vi.mock("../api", () => ({
  api: {},
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
  readClipboardText: vi.fn().mockResolvedValue("paste"),
}));

vi.mock("../terminals", () => ({
  attachHandle: vi.fn().mockResolvedValue(undefined),
  fitSession: fitSessionMock,
  restoreDesktopTerminalSize: vi.fn().mockResolvedValue(undefined),
  focusSession: focusSessionMock,
  getHandle: getHandleMock,
  hasWarmTerminalPreview: vi.fn(() => false),
  isTerminalPreviewRendered: vi.fn(() => true),
  loadOlderNativeHistory: vi.fn().mockResolvedValue(false),
  mountTerminal: mountTerminalMock,
  insertTextIntoTerminal: insertTextIntoTerminalMock,
  noteTerminalScrollIntent: vi.fn(),
  scrollTerminalViewport: vi.fn(),
  scrollToBottom: vi.fn(),
  setTerminalActive: setTerminalActiveMock,
}));

vi.mock("./PiStructuredTimeline", () => ({
  default: ({ ses }: { ses: { id: string } }) => (
    <div data-testid={`pi-${ses.id}`}>structured</div>
  ),
}));

vi.mock("./DocumentPanel", () => ({
  default: () => <aside data-testid="shared-document-panel" />,
}));

vi.mock("./StatusDot", () => ({
  default: ({ session }: { session: { id: string } }) => (
    <span data-status-session={session.id} />
  ),
}));

import {
  SESSION_PANE_DND_MIME,
  writeSessionPaneDragPayload,
} from "../paneSessionDrag";
import { singletonPaneLayout, splitPane } from "../paneLayout";
import { getState, patchSession, setState } from "../store";
import { i18n } from "../i18n";
import { beginNativeTreeDrag, forwardNativeDrag } from "../nativeDrag";
import type { SessionView } from "../types";
import TerminalArea from "./TerminalArea";
import { attachHandle, restoreDesktopTerminalSize } from "../terminals";

const ptyA: SessionView = {
  id: "pty-a",
  projectId: "project",
  worktreeId: null,
  title: "PTY A",
  adapter: "shell",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};
const ptyB: SessionView = { ...ptyA, id: "pty-b", title: "PTY B" };
const ptyOutside: SessionView = { ...ptyA, id: "pty-outside", title: "PTY Outside" };
const rpc: SessionView = {
  ...ptyA,
  id: "rpc-c",
  title: "RPC C",
  adapter: "pi",
  transport: "json_rpc",
};

function handle() {
  return {
    term: {
      buffer: { active: { type: "normal", viewportY: 0, baseY: 0 } },
      focus: vi.fn(),
      getSelection: vi.fn(() => ""),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      paste: vi.fn(),
      selectAll: vi.fn(),
    },
  };
}

function transfer(sessionId: string): DataTransfer {
  const values = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    get types() {
      return [...values.keys()];
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  } as unknown as DataTransfer;
  writeSessionPaneDragPayload(dataTransfer, sessionId);
  return dataTransfer;
}

function installLayout() {
  let terminalLayout = splitPane(
    singletonPaneLayout(ptyA.id),
    ptyA.id,
    ptyB.id,
    "right",
    "outer",
  );
  terminalLayout = splitPane(
    terminalLayout,
    ptyB.id,
    rpc.id,
    "down",
    "inner",
  );
  setState({
    projects: [{
      id: "project",
      name: "Project",
      rootPath: "/tmp/project",
      gitRootPath: null,
      pinned: false,
      sessions: [ptyA, ptyB, rpc, ptyOutside],
      worktrees: [],
    }],
    activeSessionId: ptyB.id,
    deviceSwitching: false,
    terminalLayout,
    terminalLayoutGroups: [terminalLayout],
    maximizedSessionId: null,
    attachedIds: [ptyA.id, ptyB.id],
    runtime: {
      [ptyA.id]: { attached: true, replayDone: true },
      [ptyB.id]: { attached: true, replayDone: true },
    } as never,
    termSearchOpen: false,
    docGroups: [],
    docPanelExpanded: false,
  });
}

function paneLeaf(container: HTMLElement, sessionId: string): HTMLElement {
  const pane = container.querySelector<HTMLElement>(
    `[data-pane-session-id="${sessionId}"]`,
  );
  if (!pane) throw new Error(`pane ${sessionId} missing`);
  return pane;
}

function stubPaneRect(
  pane: HTMLElement,
  width = 900,
  height = 600,
  left = 0,
  top = 0,
): void {
  Object.defineProperty(pane, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }),
  });
}

/**
 * jsdom has no DragEvent, so `fireEvent.dragEnter/dragLeave/drop` fall back to
 * a plain Event that silently drops the pointer coordinates the pane drop
 * logic reads (clientX/clientY). Build the MouseEvent explicitly.
 */
function paneDragEvent(
  type: "dragenter" | "dragleave" | "drop",
  init: {
    dataTransfer: DataTransfer;
    clientX?: number;
    clientY?: number;
    relatedTarget?: EventTarget | null;
  },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    relatedTarget: init.relatedTarget ?? null,
  });
  Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
  return event;
}

describe("TerminalArea recursive panes", () => {
  it("attaches when an external snapshot changes a visible ended pane to running", async () => {
    act(() => setState({ projects: getState().projects.map(project => ({ ...project, sessions: project.sessions.map(session => session.id === ptyA.id ? { ...session, lifecycle: "stopped" as const } : session) })) }));
    render(<TerminalArea />);
    expect(attachHandle).not.toHaveBeenCalledWith(ptyA.id);
    act(() => setState({ projects: getState().projects.map(project => ({ ...project, sessions: project.sessions.map(session => session.id === ptyA.id ? { ...session, lifecycle: "running" as const } : session) })) }));
    await waitFor(() => expect(attachHandle).toHaveBeenCalledWith(ptyA.id));
  });
  it("updates the overlay and dimming together for a non-focused split pane", () => {
    const view = render(<TerminalArea />);
    const pane = () => view.container.querySelector(`[data-pane-session-id="${ptyA.id}"]`)!;
    act(() => patchSession(ptyA.id, { lifecycle: "stopped", hostAlive: false }));
    expect(pane().querySelector(".term-pane")?.classList.contains("ended")).toBe(true);
    expect(pane().querySelector(".session-state-card")).not.toBeNull();
    act(() => patchSession(ptyA.id, { lifecycle: "running", hostAlive: true }));
    expect(pane().querySelector(".term-pane")?.classList.contains("ended")).toBe(false);
    expect(pane().querySelector(".session-state-card")).toBeNull();
  });

  it("reattaches a new run even when a rapid external restart skipped the stopped snapshot", async () => {
    render(<TerminalArea />);
    vi.mocked(attachHandle).mockClear();
    act(() => patchSession(ptyA.id, { status: { sessionId: ptyA.id, runId: "new-run", runOrdinal: 2, sequence: 1,
      state: "idle", source: "process", confidence: "high", evidence: null, logCursor: null, occurredAt: "2026-09-08T00:00:00Z" } }));
    await waitFor(() => expect(attachHandle).toHaveBeenCalledWith(ptyA.id));
  });

  it("shows only a laptop restore button for phone geometry", async () => {
    setState({ runtime: {
      ...getState().runtime,
      [ptyA.id]: { attached: true, replayDone: true, terminalGeometry: {
        runId: "run-1", runOrdinal: 1, cols: 43, rows: 48,
        sourceKind: "mobile", sourceDeviceId: "private-phone-id",
        attachmentId: 7, orientation: "portrait", revision: 3,
        updatedAt: "2026-09-02T10:00:00Z",
      } },
    } } as never);
    const view = render(<TerminalArea />);
    const prompt = view.container.querySelector(".phone-geometry-banner")!;
    expect(prompt.textContent).toBe("💻");
    expect(prompt.querySelectorAll("button")).toHaveLength(1);
    const button = prompt.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBeTruthy();
    expect(button.title).toBe(button.getAttribute("aria-label"));
    fireEvent.click(button);
    await waitFor(() => expect(restoreDesktopTerminalSize).toHaveBeenCalledWith(ptyA.id, 3));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    getHandleMock.mockImplementation(() => handle());
    installLayout();
  });

  afterEach(cleanup);

  it("renders nested right/down panes, both PTYs live, one focused, and one shared document panel", async () => {
    const { container, getByTestId } = render(<TerminalArea />);

    expect(container.querySelectorAll(".session-pane-leaf")).toHaveLength(3);
    expect(container.querySelectorAll(".pane-header")).toHaveLength(3);
    expect(container.querySelector('[data-pane-split-id="outer"].right')).not.toBeNull();
    expect(container.querySelector('[data-pane-split-id="inner"].down')).not.toBeNull();
    expect(getByTestId(`pi-${rpc.id}`)).toBeTruthy();
    expect(getByTestId("shared-document-panel")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid='shared-document-panel']")).toHaveLength(1);

    await waitFor(() => {
      expect(setTerminalActiveMock).toHaveBeenCalledWith(ptyA.id, true);
      expect(setTerminalActiveMock).toHaveBeenCalledWith(ptyB.id, true);
    });
    expect(container.querySelector(`[data-pane-session-id="${ptyB.id}"]`)?.classList.contains("focused"))
      .toBe(true);
  });

  it("synchronizes pane focus for keyboard navigation as well as pointer input", () => {
    const { container } = render(<TerminalArea />);
    const pane = container.querySelector<HTMLElement>(
      `[data-pane-session-id="${ptyA.id}"]`,
    );
    const button = pane?.querySelector<HTMLElement>(".pane-header-action");
    if (!button) throw new Error("pane action missing");

    fireEvent.focus(button);

    expect(selectSessionMock).toHaveBeenCalledWith(ptyA.id);
  });

  it("temporarily renders an outside Session alone without forgetting the split", () => {
    const view = render(<TerminalArea />);

    act(() => setState({
      activeSessionId: ptyOutside.id,
      attachedIds: [ptyOutside.id],
    }));
    view.rerender(<TerminalArea />);

    expect(view.container.querySelectorAll(".session-pane-leaf")).toHaveLength(1);
    expect(view.container.querySelector(
      `[data-pane-session-id="${ptyOutside.id}"]`,
    )).not.toBeNull();
    expect(view.container.querySelector(".pane-header")).toBeNull();

    act(() => setState({ activeSessionId: ptyA.id }));
    view.rerender(<TerminalArea />);

    expect(view.container.querySelectorAll(".session-pane-leaf")).toHaveLength(3);
    expect(view.container.querySelector(
      `[data-pane-session-id="${ptyOutside.id}"]`,
    )).toBeNull();
  });

  it("keeps every pane mounted while maximizing and hides only non-target branches", () => {
    const view = render(<TerminalArea />);
    act(() => setState({ maximizedSessionId: rpc.id, activeSessionId: rpc.id }));
    view.rerender(<TerminalArea />);

    expect(view.container.querySelectorAll(".session-pane-leaf")).toHaveLength(3);
    expect(view.getByTestId(`pi-${rpc.id}`)).toBeTruthy();
    expect(view.container.querySelectorAll(".session-pane-leaf.max-hidden")).toHaveLength(2);
    expect(view.container.querySelectorAll(".pane-split.maximized-path")).toHaveLength(2);
  });

  it("keeps clipboard, split, rename, restart, stop, and remove actions in the PTY context menu", () => {
    const { container } = render(<TerminalArea />);
    const pane = container.querySelector<HTMLElement>(
      `[data-pane-session-id="${ptyA.id}"]`,
    );
    if (!pane) throw new Error("pane missing");
    Object.defineProperty(pane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600 }),
    });

    fireEvent.contextMenu(pane, { clientX: 20, clientY: 30 });

    const labels = getState().contextMenu?.items
      .filter((item) => !item.separator)
      .map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining([
      "复制",
      "粘贴",
      "向右分屏",
      "向下分屏",
      "重命名",
      "重启",
      "停止",
      "移除",
    ]));
    expect(labels).not.toContain("最大化分屏");
    expect(labels).not.toContain("从分屏移除");
    expect(labels).not.toContain("全选");
    expect(labels).not.toContain("查找…");

    getState().contextMenu?.items.find((item) => item.label === "向右分屏")?.action?.();
    expect(openSplitAgentPickerMock).toHaveBeenCalledWith(ptyA.id, "right");
    expect(openSplitSessionDialogMock).not.toHaveBeenCalled();

    getState().contextMenu?.items.find((item) => item.label === "重命名")?.action?.();
    expect(renameSessionFlowMock).toHaveBeenCalledWith(ptyA.id);

    getState().contextMenu?.items.find((item) => item.label === "重启")?.action?.();
    expect(restartSessionFlowMock).toHaveBeenCalledWith(ptyA.id);

    const stopItem = getState().contextMenu?.items.find(
      (item) => item.label === "停止",
    );
    expect(stopItem?.danger).toBe(true);
    stopItem?.action?.();
    expect(stopSessionFlowMock).toHaveBeenCalledWith(ptyA.id);

    const removeItem = getState().contextMenu?.items.find(
      (item) => item.label === "移除",
    );
    expect(removeItem?.danger).toBe(true);
    removeItem?.action?.();
    expect(removeSessionFlowMock).toHaveBeenCalledWith(ptyA.id, { confirm: true });
  });

  it.each([
    ["shell", "'/tmp/My Docs/报告.md' "],
    ["pi", "'@/tmp/My Docs/报告.md' "],
  ])("inserts a native tree drop once into the hit %s pane, not the focused pane", (adapter, expected) => {
    act(() => patchSession(ptyA.id, { adapter }));
    const { container } = render(<TerminalArea />);
    const target = container.querySelector(`[data-terminal-session-id="${ptyA.id}"] .term-host`)!;
    const crossed = container.querySelector(`[data-terminal-session-id="${ptyB.id}"] .term-host`)!;
    let hitTarget: Element | null = crossed;
    const hitDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hitTarget });
    class Transfer {
      values = new Map<string, string>();
      setData(key: string, value: string) { this.values.set(key, value); }
      getData(key: string) { return this.values.get(key) ?? ""; }
      get types() { return [...this.values.keys()]; }
    }
    class Drag extends MouseEvent {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: DragEventInit) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    vi.stubGlobal("DataTransfer", Transfer);
    vi.stubGlobal("DragEvent", Drag);
    try {
      beginNativeTreeDrag({ path: "/tmp/My Docs/报告.md", isDir: false });
      const move = () => act(() => { forwardNativeDrag({ type: "over", position: { x: 400, y: 300 } }); });
      move();
      expect(crossed.closest(".term-pane")?.classList.contains("drop-target")).toBe(true);
      hitTarget = target;
      move();
      expect(crossed.closest(".term-pane")?.classList.contains("drop-target")).toBe(false);
      expect(container.querySelectorAll(".term-pane.drop-target")).toHaveLength(1);
      // Moving between xterm descendants must keep the current pane highlighted.
      const child = document.createElement("span");
      target.append(child);
      hitTarget = child;
      move();
      expect(target.closest(".term-pane")?.classList.contains("drop-target")).toBe(true);
      // Moving outside all panes clears the last highlight too.
      hitTarget = container;
      move();
      expect(container.querySelectorAll(".term-pane.drop-target")).toHaveLength(0);
      hitTarget = target;
      move();
      act(() => { forwardNativeDrag({ type: "leave" }); });
      expect(container.querySelectorAll(".term-pane.drop-target")).toHaveLength(0);
      move();
      expect(target.closest(".term-pane")?.classList.contains("drop-target")).toBe(true);
      window.dispatchEvent(new Event("dragend"));
      act(() => { forwardNativeDrag({ type: "drop", position: { x: 400, y: 300 } }); });
      expect(insertTextIntoTerminalMock).toHaveBeenCalledOnce();
      expect(insertTextIntoTerminalMock).toHaveBeenCalledWith(ptyA.id, expected);
      expect(container.querySelectorAll(".term-pane.drop-target")).toHaveLength(0);
      expect(splitSessionIntoPaneMock).not.toHaveBeenCalled();
      expect(forwardNativeDrag({ type: "drop", position: { x: 400, y: 300 } })).toBe(false);
    } finally {
      act(() => { forwardNativeDrag({ type: "leave" }); });
      window.dispatchEvent(new Event("dragend"));
      if (hitDescriptor) Object.defineProperty(document, "elementFromPoint", hitDescriptor);
      else Reflect.deleteProperty(document, "elementFromPoint");
      vi.unstubAllGlobals();
    }
  });

  it("keeps the Session drop indicator while WebKit reports a dragleave inside the pane", () => {
    // WebKit fires dragleave with a null relatedTarget whenever the element
    // under the cursor is replaced mid-drag (the overlay mounting, a banner
    // appearing, …). Treating that as a real leave strobed the overlay on
    // Linux and let the drop fall through to the terminal surface.
    const { container } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane);

    fireEvent(pane, paneDragEvent("dragenter", { dataTransfer: transfer(rpc.id), clientX: 400, clientY: 300 }));
    expect(pane.querySelector(".pane-drop-overlay")).not.toBeNull();

    fireEvent(pane, paneDragEvent("dragleave", {
      dataTransfer: transfer(rpc.id),
      clientX: 400,
      clientY: 300,
      relatedTarget: null,
    }));
    expect(pane.querySelector(".pane-drop-overlay")).not.toBeNull();
  });

  it("drops the indicator once the pointer really left the pane", () => {
    const { container } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane, 900, 600, 100, 50);

    fireEvent(pane, paneDragEvent("dragenter", { dataTransfer: transfer(rpc.id), clientX: 400, clientY: 300 }));
    expect(pane.querySelector(".pane-drop-overlay")).not.toBeNull();

    fireEvent(pane, paneDragEvent("dragleave", {
      dataTransfer: transfer(rpc.id),
      clientX: 20,
      clientY: 40,
      relatedTarget: null,
    }));
    expect(pane.querySelector(".pane-drop-overlay")).toBeNull();
  });

  it("splits by drop position when a Session lands on the pane surface", () => {
    // The drop arrives on the terminal surface, not on the indicator, because
    // the indicator is inert (`pointer-events: none`) and the pane leaf owns
    // the stable drop surface on every platform.
    const { container } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane);

    const dataTransfer = transfer(rpc.id);
    expect(dataTransfer.types).toContain(SESSION_PANE_DND_MIME);

    fireEvent(pane, paneDragEvent("drop", { dataTransfer, clientX: 100, clientY: 300 }));
    expect(splitSessionIntoPaneMock).toHaveBeenCalledWith(ptyB.id, rpc.id, "right");

    fireEvent(pane, paneDragEvent("drop", { dataTransfer: transfer(rpc.id), clientX: 800, clientY: 300 }));
    expect(splitSessionIntoPaneMock).toHaveBeenLastCalledWith(ptyB.id, rpc.id, "down");
  });

  it("clears the indicator when the drag gesture ends without a drop", () => {
    const { container } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane);

    fireEvent(pane, paneDragEvent("dragenter", { dataTransfer: transfer(rpc.id), clientX: 400, clientY: 300 }));
    expect(pane.querySelector(".pane-drop-overlay")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
    expect(pane.querySelector(".pane-drop-overlay")).toBeNull();
  });

  it("clears the indicator once the drag enters another element", () => {
    // WebKit reports entering the sidebar or a neighbouring pane but often no
    // leave for this pane, so entering outside the leaf ends the hover.
    const { container } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane);

    fireEvent(pane, paneDragEvent("dragenter", { dataTransfer: transfer(rpc.id), clientX: 400, clientY: 300 }));
    expect(pane.querySelector(".pane-drop-overlay")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        paneDragEvent("dragenter", { dataTransfer: transfer(rpc.id), clientX: 10, clientY: 10 }),
      );
    });
    expect(pane.querySelector(".pane-drop-overlay")).toBeNull();
  });

  it("renders both Session drop directions as an inert overlay", () => {
    const { container, getByText } = render(<TerminalArea />);
    const pane = paneLeaf(container, ptyB.id);
    stubPaneRect(pane);

    fireEvent.dragEnter(pane, { dataTransfer: transfer(rpc.id) });
    const right = getByText("放到右侧").closest<HTMLElement>(".pane-drop-zone");
    const down = getByText("放到下方").closest<HTMLElement>(".pane-drop-zone");

    expect(right).not.toBeNull();
    expect(down).not.toBeNull();
    expect(right?.getAttribute("aria-disabled")).toBe("false");
    expect(down?.getAttribute("aria-disabled")).toBe("false");
  });

  it("exposes keyboard-operable split separators", () => {
    const { container } = render(<TerminalArea />);
    const separator = container.querySelector<HTMLElement>(
      '[data-pane-split-id="outer"] > .pane-divider',
    );
    expect(separator?.getAttribute("role")).toBe("separator");
    expect(separator?.getAttribute("aria-orientation")).toBe("vertical");
    if (!separator) return;

    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(setPaneSplitRatioMock).toHaveBeenCalledWith(
      "outer",
      expect.any(Number),
    );
  });

  it("unmounts old PTY and structured panes before intentional device detach can show a disconnect warning", () => {
    const view = render(<TerminalArea />);
    const layoutBeforeSwitch = getState().terminalLayout;
    expect(view.container.querySelectorAll(".session-pane-leaf")).toHaveLength(3);

    // switchTeardown clears activeSessionId, but the remembered layout still
    // contains the old device's panes. releaseTerminal then marks them detached.
    act(() => setState({ deviceSwitching: true, activeSessionId: null }));
    expect(view.container.querySelector(".session-pane-leaf")).toBeNull();
    expect(view.queryByTestId(`pi-${rpc.id}`)).toBeNull();
    expect(view.queryByTestId("shared-document-panel")).toBeNull();
    act(() => setState({ runtime: {
      [ptyA.id]: { attached: false, detached: true },
      [ptyB.id]: { attached: false, detached: true },
    } as never }));

    expect(view.queryByText(i18n.t("session:ui.disconnected.checking"))).toBeNull();
    expect(view.getByRole("status").textContent).toBe(i18n.t("shell:ui.topBar.devices.switching"));
    expect(getState().terminalLayout).toBe(layoutBeforeSwitch);
    expect(getState().terminalLayoutGroups).toEqual([layoutBeforeSwitch]);
  });

  it("does not mount target panes until device boot completes, then mounts and attaches them", async () => {
    setState({ deviceSwitching: true });
    const view = render(<TerminalArea />);
    expect(mountTerminalMock).not.toHaveBeenCalled();
    act(() => setState({
      activeSessionId: ptyOutside.id,
      terminalLayout: singletonPaneLayout(ptyOutside.id),
      runtime: {},
    }));
    expect(view.container.querySelector(".session-pane-leaf")).toBeNull();
    expect(attachHandle).not.toHaveBeenCalled();

    act(() => setState({ deviceSwitching: false }));
    expect(view.container.querySelector(`[data-pane-session-id="${ptyOutside.id}"]`)).not.toBeNull();
    await waitFor(() => expect(attachHandle).toHaveBeenCalledWith(ptyOutside.id));
    expect(view.queryByText(i18n.t("shell:ui.topBar.devices.switching"))).toBeNull();
    expect(view.queryByText(i18n.t("session:ui.disconnected.checking"))).toBeNull();
  });

  it("still warns about a real disconnect after switching or rollback finishes", () => {
    setState({
      deviceSwitching: true,
      activeSessionId: ptyA.id,
      terminalLayout: singletonPaneLayout(ptyA.id),
      runtime: { [ptyA.id]: { attached: false, detached: true } } as never,
    });
    const view = render(<TerminalArea />);
    expect(view.queryByText(i18n.t("session:ui.disconnected.checking"))).toBeNull();
    act(() => setState({ deviceSwitching: false }));
    expect(view.getByText(i18n.t("session:ui.disconnected.checking"))).toBeTruthy();
  });

  it("keeps the legacy single-pane surface chrome-free", () => {
    setState({
      terminalLayout: singletonPaneLayout(ptyA.id),
      activeSessionId: ptyA.id,
      maximizedSessionId: null,
      attachedIds: [ptyA.id],
    });
    const { container } = render(<TerminalArea />);

    expect(container.querySelectorAll(".session-pane-leaf")).toHaveLength(1);
    expect(container.querySelector(".pane-header")).toBeNull();
    expect(container.querySelector(".term-host")).not.toBeNull();
  });
});
