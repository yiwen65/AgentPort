// @vitest-environment jsdom
// 项目行「＋」按钮的菜单必须与右键菜单同源（projectMenu），
// 只去掉「新建 Session…」——不与新建 Session 弹窗/quick-launch 重复。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  archiveSessionFlowMock,
  listWorktreesMock,
  refreshRepositoryStatusMock,
  quickStartSessionMock,
} = vi.hoisted(() => ({
  archiveSessionFlowMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  refreshRepositoryStatusMock: vi.fn(),
  quickStartSessionMock: vi.fn(),
}));

vi.mock("./actions", () => ({
  ackTimelineFlow: vi.fn(),
  interruptSessionFlow: vi.fn(),
  openNewSessionDialog: vi.fn(),
  removeProjectFlow: vi.fn(),
  removeWorktreeFlow: vi.fn(),
  renameProjectFlow: vi.fn(),
  renameSessionInlineFlow: vi.fn(),
  restartSessionFlow: vi.fn(),
  quickStartSession: quickStartSessionMock,
  archiveSessionFlow: archiveSessionFlowMock,
  addProjectFromPickerFlow: vi.fn(),
  removeSessionFlow: vi.fn(),
  selectSession: vi.fn(),
  stopSessionFlow: vi.fn(),
  refreshRepositoryStatus: refreshRepositoryStatusMock,
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

const project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  gitRootPath: "/tmp/demo",
  pinned: false,
  sessions: [],
  worktrees: [],
};

const runningSession = {
  id: "ses_running",
  projectId: "p1",
  worktreeId: null,
  title: "Running Session",
  adapter: "shell",
  cwd: "/tmp/demo",
  lifecycle: "running" as const,
  agentSessionId: null,
  resumePrecision: "unavailable" as const,
  permissionMode: "native" as const,
  transport: "pty" as const,
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-07-23T00:00:00.000Z",
};

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

const shellAdapter = {
  agentType: "shell" as const,
  executablePath: "/bin/zsh",
  versionText: "zsh",
  capabilityHash: "sha256:test",
  exactResume: false,
  hookStatus: "unavailable" as const,
  approvalModel: "no_builtin_prompts" as const,
  defaultTransport: "pty" as const,
  probedAt: "2026-07-23T00:00:00.000Z",
  candidates: [],
  flags: [],
};

const piAdapter = {
  ...shellAdapter,
  agentType: "pi" as const,
  executablePath: "/usr/local/bin/pi",
  versionText: "pi",
  capabilityHash: "sha256:pi",
};

let capturedPointerTarget: HTMLElement | null = null;

function dispatchPointer(target: HTMLElement, type: "pointerdown" | "pointerup") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: 7 },
    clientX: { value: 50 },
  });
  target.dispatchEvent(event);
}

describe("project row plus button menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorktreesMock.mockResolvedValue([]);
    refreshRepositoryStatusMock.mockResolvedValue(null);
    capturedPointerTarget = null;
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value(this: HTMLElement) { capturedPointerTarget = this; },
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value(this: HTMLElement) { return capturedPointerTarget === this; },
    });
    setState({
      projects: [project],
      adapters: [shellAdapter],
      settings,
      repositoryStatuses: {},
      expandedProjects: { p1: true },
      sidebarWorktreeProjectId: null,
      highlightedWorktreeId: null,
      contextMenu: null,
    });
  });

  afterEach(() => cleanup());

  it("shows Pi quick launch without a permission suffix", () => {
    setState({ adapters: [shellAdapter, piAdapter] });
    render(<Sidebar collapsed={false} width={296} />);

    const piButton = screen.getByRole("button", { name: /Pi/ });
    expect(piButton.getAttribute("aria-label")).not.toMatch(/permission|权限/i);
    expect(piButton.getAttribute("data-tip")).toMatch(/^启动 Pi$|^Launch Pi$/);
  });

  it("lets vertical wheel scrolling escape the quick-agent strip at its edge", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const strip = container.querySelector<HTMLElement>(".quick-agent-strip");
    expect(strip).not.toBeNull();
    if (!strip) throw new Error("quick agent strip missing");
    let scrollLeft = 200;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = Math.max(0, Math.min(200, value));
        },
      },
    });
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    act(() => strip.dispatchEvent(event));

    expect(scrollLeft).toBe(200);
    expect(preventDefault).not.toHaveBeenCalled();

    scrollLeft = 100;
    const movableEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    const preventMovableDefault = vi.spyOn(movableEvent, "preventDefault");
    act(() => strip.dispatchEvent(movableEvent));

    expect(scrollLeft).toBe(140);
    expect(preventMovableDefault).toHaveBeenCalledOnce();
  });

  it("opens project context-menu items without 新建 Session / quick-launch agents", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const plus = screen.getByRole("button", { name: "项目 Demo 的更多操作" });
    act(() => {
      fireEvent.click(plus);
    });
    const menu = getState().contextMenu;
    expect(menu).not.toBeNull();
    const labels = menu!.items.map((i) => i.label).filter((l) => l !== "");
    expect(labels).toEqual([
      "打开 Git Center",
      "新建 Worktree…",
      "管理本地分支…",
      "置顶项目",
      "在系统文件管理器中显示",
      "重命名项目…",
      "从 AgentPort 移除（不删除目录）",
    ]);
    expect(labels).not.toContain("新建 Session…");
    for (const agent of ["Claude Code", "Codex", "Kimi Code", "Generic Shell", "详细配置…"]) {
      expect(labels).not.toContain(agent);
    }
  });

  it("keeps a plain icon click on the icon instead of stealing it for dragging", () => {
    render(<Sidebar collapsed={false} width={296} />);
    const shell = screen.getByRole("button", { name: "在项目 Demo启动 Shell（终端）" });
    const strip = screen.getByLabelText("在项目 Demo快速启动 Agent；拖动查看全部");

    act(() => {
      dispatchPointer(shell, "pointerdown");
      const captureTarget = capturedPointerTarget ?? shell;
      dispatchPointer(captureTarget, "pointerup");
      fireEvent.click(captureTarget);
    });

    expect(quickStartSessionMock).toHaveBeenCalledWith("p1", "shell", undefined);
    expect(strip).toBeTruthy();
  });

  it("routes a running Session hover archive through the confirmed flow", () => {
    setState({ projects: [{ ...project, sessions: [runningSession] }] });
    render(<Sidebar collapsed={false} width={296} />);

    fireEvent.click(screen.getByRole("button", { name: "归档" }));

    expect(archiveSessionFlowMock).toHaveBeenCalledWith("ses_running");
  });

  it("keeps the unread dot visible for the active Session until it is acknowledged", () => {
    setState({
      activeSessionId: runningSession.id,
      projects: [{ ...project, sessions: [{ ...runningSession, unread: true }] }],
    });

    render(<Sidebar collapsed={false} width={296} />);

    expect(screen.getByLabelText("有未读更新")).toBeTruthy();
  });

  it("refreshes health only for the project shown in the Worktree view", async () => {
    const cachedWorktree = {
      id: "wt1",
      branch: "agent/task",
      baseCommit: "abc123",
      baseRef: "main",
      path: "/tmp/demo-worktrees/task",
      health: "clean" as const,
    };
    listWorktreesMock.mockResolvedValue([{ ...cachedWorktree, health: "dirty" }]);
    setState({
      projects: [{ ...project, worktrees: [cachedWorktree] }],
      sidebarWorktreeProjectId: project.id,
    });

    render(<Sidebar collapsed={false} width={296} />);

    await waitFor(() => expect(screen.getByText("有本地文件改动")).toBeTruthy());
    expect(listWorktreesMock).toHaveBeenCalledTimes(1);
    expect(listWorktreesMock).toHaveBeenCalledWith(project.id);
  });
});
