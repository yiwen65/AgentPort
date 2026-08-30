// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
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

import Sidebar from "./components/Sidebar";
import { SESSION_PANE_DND_MIME } from "./paneSessionDrag";
import { singletonPaneLayout, splitPane } from "./paneLayout";
import { setState } from "./store";
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
    setState({
      projects: [{
        id: "p1",
        name: "Demo",
        rootPath: "/tmp/demo",
        gitRootPath: null,
        pinned: false,
        sessions: [first, second, third],
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
      contextMenu: null,
    });
  });

  afterEach(cleanup);

  it("keeps one active row and marks only the other in-layout Session", () => {
    const { container } = render(<Sidebar collapsed={false} width={296} />);
    const rows = [...container.querySelectorAll<HTMLElement>(".tree-row.session")];
    const active = rows.find((row) => row.textContent?.includes("First"));
    const member = rows.find((row) => row.textContent?.includes("Second"));
    const outside = rows.find((row) => row.textContent?.includes("Third"));

    expect(active?.classList.contains("active")).toBe(true);
    expect(active?.querySelector(".pane-layout-indicator")).toBeNull();
    expect(member?.classList.contains("in-pane-layout")).toBe(true);
    expect(member?.querySelector(".pane-layout-indicator")?.getAttribute("aria-label"))
      .toBe("已在分屏中");
    expect(outside?.classList.contains("in-pane-layout")).toBe(false);
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
