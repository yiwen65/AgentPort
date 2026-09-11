// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { selectSessionMock } = vi.hoisted(() => ({
  selectSessionMock: vi.fn(),
}));

vi.mock("./actions", () => ({
  addProjectFromPickerFlow: vi.fn(),
  archiveSessionFlow: vi.fn(),
  copyTextWithToast: vi.fn(),
  interruptSessionFlow: vi.fn(),
  openNewSessionDialog: vi.fn(),
  quickStartSession: vi.fn(),
  refreshRepositoryStatus: vi.fn().mockResolvedValue(null),
  removeProjectFlow: vi.fn(),
  removeSessionFlow: vi.fn(),
  removeWorktreeFlow: vi.fn(),
  renameProjectFlow: vi.fn(),
  renameSessionInlineFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  resumeSessionFlow: vi.fn(),
  saveProjectLayoutFlow: vi.fn(),
  selectSession: selectSessionMock,
  stopSessionFlow: vi.fn(),
  toggleSessionPinFlow: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    listWorktrees: vi.fn().mockResolvedValue([]),
    openInSystemTerminal: vi.fn(),
    revealInFileManager: vi.fn(),
    worktreeStatusText: vi.fn(),
  },
  copyText: vi.fn().mockResolvedValue(true),
  errorText: (error: unknown) => String(error),
}));

vi.mock("./paneLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paneLayout")>();
  return {
    ...actual,
    orderedLayoutSessionIds: vi.fn(actual.orderedLayoutSessionIds),
  };
});

import Sidebar from "./components/Sidebar";
import { SESSION_PANE_DND_MIME } from "./paneSessionDrag";
import {
  orderedLayoutSessionIds,
  singletonPaneLayout,
  splitPane,
} from "./paneLayout";
import { getState, setState } from "./store";
import type { SessionView } from "./types";

const first: SessionView = {
  id: "ses_first",
  projectId: "p1",
  worktreeId: null,
  title: "First",
  adapter: "shell",
  cwd: "/tmp/demo",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/first.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};
const second: SessionView = { ...first, id: "ses_second", title: "Second" };
const third: SessionView = { ...first, id: "ses_third", title: "Third" };
const fourth: SessionView = { ...first, id: "ses_fourth", title: "Fourth" };
const fifth: SessionView = { ...first, id: "ses_fifth", title: "Fifth" };

const settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN" as const,
  theme: "system" as const,
  terminalTheme: "one" as const,
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system" as const,
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["shell"],
  agentHidden: [],
  telemetryEnabled: false,
};

function dataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: vi.fn((type: string) => values.get(type) ?? ""),
    get types() {
      return [...values.keys()];
    },
  } as unknown as DataTransfer;
}

describe("sidebar Session pane drag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const terminalLayout = splitPane(
      singletonPaneLayout(first.id),
      first.id,
      second.id,
      "right",
      "split",
    );
    const rememberedLayout = splitPane(
      singletonPaneLayout(third.id),
      third.id,
      fourth.id,
      "down",
      "remembered-split",
    );
    setState({
      projects: [{
        id: "p1",
        name: "Demo",
        rootPath: "/tmp/demo",
        gitRootPath: null,
        pinned: false,
        sessions: [first, second, third, fourth, fifth],
        worktrees: [],
      }],
      settings,
      adapters: [],
      repositoryStatuses: {},
      expandedProjects: { p1: true },
      sidebarWorktreeProjectId: null,
      highlightedWorktreeId: null,
      activeSessionId: first.id,
      terminalLayout,
      terminalLayoutGroups: [terminalLayout, rememberedLayout],
      contextMenu: null,
    });
  });

  afterEach(cleanup);

  it("switches to saved groups, restores a group, and keeps ungrouped Sessions on the project page", () => {
    const view = render(<Sidebar collapsed={false} width={296} />);
    fireEvent.click(view.getByRole("button", { name: "分屏分组" }));
    expect(view.container.querySelectorAll(".sidebar-pane-group")).toHaveLength(2);
    expect(view.container.querySelectorAll(".tree-row.session")).toHaveLength(4);
    fireEvent.click(view.getAllByRole("button", { name: "未命名分组 2" })[1]);
    expect(selectSessionMock).toHaveBeenCalledWith(getState().terminalLayoutGroups[1].focusedSessionId);
    fireEvent.click(view.getByRole("button", { name: /展开或收起分组：Third/ }));
    expect(view.container.querySelectorAll(".tree-row.session")).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "项目" }));
    expect(view.container.querySelectorAll(".tree-row.session")).toHaveLength(5);
  });

  it("uses horizontal wheel gestures without hijacking vertical scrolling and shows an empty state", () => {
    setState({ terminalLayoutGroups: [] });
    const view = render(<Sidebar collapsed={false} width={296} />);
    const sidebar = view.container.querySelector("aside")!;
    fireEvent.wheel(sidebar, { deltaY: 100, deltaX: 2 });
    expect(view.queryByText("暂无分屏分组")).toBeNull();
    fireEvent.wheel(sidebar, { deltaX: 100, deltaY: 2 });
    expect(view.getByText("暂无分屏分组")).toBeTruthy();
    expect(view.getByRole("button", { name: "分屏分组" }).getAttribute("aria-current")).toBe("page");
    // Momentum belongs to the same gesture and must not bounce to the other page.
    fireEvent.wheel(sidebar, { deltaX: -100 });
    expect(view.getByText("暂无分屏分组")).toBeTruthy();
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    fireEvent.wheel(sidebar, { deltaX: -100 });
    expect(view.queryByText("暂无分屏分组")).toBeNull();
    clock.mockRestore();
  });

  it("renames a group on double click and persists its custom title", async () => {
    const view = render(<Sidebar collapsed={false} width={296} />);
    fireEvent.click(view.getByRole("button", { name: "分屏分组" }));
    fireEvent.doubleClick(view.getAllByRole("button", { name: "未命名分组 2" })[0]);
    expect(getState().prompt?.initial).toBe("");
    await act(async () => { getState().prompt?.resolve("  工作组  "); });
    expect(view.getByRole("button", { name: "工作组 2" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("agentport-terminal-layout")!).groups[0].name).toBe("工作组");
  });

  it("marks remembered pane rows without rendering a trailing badge", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const rows = [...container.querySelectorAll<HTMLElement>(".tree-row.session")];
    const active = rows.find((row) => row.textContent?.includes("First"));
    const member = rows.find((row) => row.textContent?.includes("Second"));
    const rememberedMember = rows.find((row) => row.textContent?.includes("Third"));
    const outside = rows.find((row) => row.textContent?.includes("Fifth"));

    expect(active?.classList.contains("active")).toBe(true);
    expect(member?.classList.contains("in-pane-layout")).toBe(true);
    expect(rememberedMember?.classList.contains("in-pane-layout")).toBe(true);
    expect(outside?.classList.contains("in-pane-layout")).toBe(false);
    expect(container.querySelector(".pane-layout-indicator")).toBeNull();
  });

  it("shares pane membership across rows and invalidates it with new layouts", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const traversalCount = vi.mocked(orderedLayoutSessionIds).mock.calls.length;
    expect(traversalCount).toBe(2);

    act(() => setState({ announcement: "runtime tick" }));
    expect(vi.mocked(orderedLayoutSessionIds)).toHaveBeenCalledTimes(
      traversalCount,
    );

    const replacement = splitPane(
      singletonPaneLayout(fourth.id),
      fourth.id,
      fifth.id,
      "right",
      "replacement-split",
    );
    act(() => {
      setState({
        terminalLayout: singletonPaneLayout(first.id),
        terminalLayoutGroups: [replacement],
      });
    });

    const rows = [...container.querySelectorAll<HTMLElement>(".tree-row.session")];
    const secondRow = rows.find((row) => row.textContent?.includes("Second"));
    const fifthRow = rows.find((row) => row.textContent?.includes("Fifth"));
    expect(secondRow?.classList.contains("in-pane-layout")).toBe(false);
    expect(fifthRow?.classList.contains("in-pane-layout")).toBe(true);
    expect(vi.mocked(orderedLayoutSessionIds)).toHaveBeenCalledTimes(
      traversalCount + 2,
    );
    expect(getState().terminalLayoutGroups).toEqual([replacement]);
  });

  it("writes the dedicated Session MIME while preserving ordinary click", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const row = [...container.querySelectorAll<HTMLElement>(".tree-row.session")]
      .find((candidate) => candidate.textContent?.includes("Second"));
    if (!row) throw new Error("Session row missing");
    const transfer = dataTransfer();

    fireEvent.dragStart(row, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith(
      SESSION_PANE_DND_MIME,
      JSON.stringify({ sessionId: second.id }),
    );
    expect(row.classList.contains("dragging-pane-session")).toBe(true);
    fireEvent.dragEnd(row, { dataTransfer: transfer });
    expect(row.classList.contains("dragging-pane-session")).toBe(false);

    fireEvent.click(row);
    expect(selectSessionMock).toHaveBeenCalledWith(second.id);
  });

  it("disables row dragging while the title editor is open", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const row = [...container.querySelectorAll<HTMLElement>(".tree-row.session")]
      .find((candidate) => candidate.textContent?.includes("Third"));
    if (!row) throw new Error("Session row missing");

    fireEvent.doubleClick(row);

    expect(row.getAttribute("draggable")).toBe("false");
    expect(row.querySelector("input.session-title-input")).not.toBeNull();
  });
});
