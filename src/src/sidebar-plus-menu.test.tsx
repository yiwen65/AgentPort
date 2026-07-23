// @vitest-environment jsdom
// 项目行「＋」按钮的菜单必须与右键菜单同源（projectMenu），
// 只去掉「新建 Session…」——不与新建 Session 弹窗/quick-launch 重复。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { archiveSessionFlowMock, refreshRepositoryStatusMock, quickStartSessionMock } = vi.hoisted(() => ({
  archiveSessionFlowMock: vi.fn(),
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
  logPath: "/tmp/demo/session.log",
  unread: false,
  status: null,
  createdAt: "2026-07-23T00:00:00.000Z",
};

const settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN" as const,
  theme: "system" as const,
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system" as const,
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["shell"],
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
      "新建 Worktree…",
      "管理本地分支…",
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
});
