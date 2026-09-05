// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fitSessionMock,
  focusSessionMock,
  getHandleMock,
  mountTerminalMock,
  openSplitAgentPickerMock,
  openSplitSessionDialogMock,
  persistLayoutMock,
  removePaneMock,
  renameSessionFlowMock,
  selectSessionMock,
  setPaneSplitRatioMock,
  setTerminalActiveMock,
  splitSessionIntoPaneMock,
  stopSessionFlowMock,
  toggleMaximizedMock,
} = vi.hoisted(() => ({
  fitSessionMock: vi.fn(),
  focusSessionMock: vi.fn(),
  getHandleMock: vi.fn(),
  mountTerminalMock: vi.fn(),
  openSplitAgentPickerMock: vi.fn(),
  openSplitSessionDialogMock: vi.fn(),
  persistLayoutMock: vi.fn(),
  removePaneMock: vi.fn(),
  renameSessionFlowMock: vi.fn(),
  selectSessionMock: vi.fn(),
  setPaneSplitRatioMock: vi.fn().mockReturnValue(true),
  setTerminalActiveMock: vi.fn(),
  splitSessionIntoPaneMock: vi.fn(),
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
  renameSessionFlow: renameSessionFlowMock,
  resumeSessionFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  selectSession: selectSessionMock,
  setPaneSplitRatio: setPaneSplitRatioMock,
  splitSessionIntoPane: splitSessionIntoPaneMock,
  stopSessionFlow: stopSessionFlowMock,
  toggleSessionPaneMaximized: toggleMaximizedMock,
}));

vi.mock("../api", () => ({
  api: { searchSessionLog: vi.fn() },
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
  readClipboardText: vi.fn().mockResolvedValue("paste"),
}));

vi.mock("../terminals", () => ({
  attachHandle: vi.fn(),
  fitSession: fitSessionMock,
  focusSession: focusSessionMock,
  getHandle: getHandleMock,
  hasWarmTerminalPreview: vi.fn(() => false),
  isTerminalPreviewRendered: vi.fn(() => true),
  loadOlderNativeHistory: vi.fn().mockResolvedValue(false),
  mountTerminal: mountTerminalMock,
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
import { getState, setState } from "../store";
import type { SessionView } from "../types";
import TerminalArea from "./TerminalArea";

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
  logPath: "/tmp/a.log",
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
    terminalLayout,
    terminalLayoutGroups: [terminalLayout],
    maximizedSessionId: null,
    attachedIds: [ptyA.id, ptyB.id],
    runtime: {
      [ptyA.id]: { attached: true, replayDone: true },
      [ptyB.id]: { attached: true, replayDone: true },
    } as never,
    termSearchOpen: false,
    openDocument: null,
    docPanelExpanded: false,
  });
}

describe("TerminalArea recursive panes", () => {
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

  it("keeps clipboard, pane, rename, and stop actions in the PTY context menu", () => {
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
      "最大化分屏",
      "从分屏移除",
      "重命名",
      "停止",
    ]));
    expect(labels).not.toContain("全选");
    expect(labels).not.toContain("查找…");

    getState().contextMenu?.items.find((item) => item.label === "向右分屏")?.action?.();
    expect(openSplitAgentPickerMock).toHaveBeenCalledWith(ptyA.id, "right");
    expect(openSplitSessionDialogMock).not.toHaveBeenCalled();

    getState().contextMenu?.items.find((item) => item.label === "重命名")?.action?.();
    expect(renameSessionFlowMock).toHaveBeenCalledWith(ptyA.id);

    const stopItem = getState().contextMenu?.items.find(
      (item) => item.label === "停止",
    );
    expect(stopItem?.danger).toBe(true);
    stopItem?.action?.();
    expect(stopSessionFlowMock).toHaveBeenCalledWith(ptyA.id);
  });

  it("shows two Session drop zones and routes the chosen direction", () => {
    const { container, getByText } = render(<TerminalArea />);
    const pane = container.querySelector<HTMLElement>(
      `[data-pane-session-id="${ptyA.id}"]`,
    );
    if (!pane) throw new Error("pane missing");
    Object.defineProperty(pane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600 }),
    });
    const dataTransfer = transfer(rpc.id);
    expect(dataTransfer.types).toContain(SESSION_PANE_DND_MIME);

    fireEvent.dragEnter(pane, { dataTransfer });
    const right = getByText("放到右侧").closest<HTMLElement>(".pane-drop-zone");
    expect(right).not.toBeNull();
    if (!right) return;
    fireEvent.drop(right, { dataTransfer });

    expect(splitSessionIntoPaneMock).toHaveBeenCalledWith(
      ptyA.id,
      rpc.id,
      "right",
    );
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
