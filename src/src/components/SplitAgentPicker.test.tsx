// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { quickStartSessionMock } = vi.hoisted(() => ({
  quickStartSessionMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  quickStartSession: quickStartSessionMock,
}));

import { getState, setState } from "../store";
import type { AdapterInstall, SessionView } from "../types";
import SplitAgentPicker from "./SplitAgentPicker";
import { ADDED_AGENT_IDS } from "../agentCapabilities";
import { agentDisplay } from "../format";

const targetSession: SessionView = {
  id: "session-target",
  projectId: "project-1",
  worktreeId: "worktree-1",
  title: "Build logs",
  adapter: "shell",
  cwd: "/tmp/demo-worktrees/feature",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  logPath: "/tmp/session.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

function adapter(agentType: AdapterInstall["agentType"]): AdapterInstall {
  return {
    agentType,
    executablePath: `/usr/local/bin/${agentType}`,
    versionText: agentType,
    capabilityHash: `sha256:${agentType}`,
    exactResume: false,
    hookStatus: "unavailable",
    approvalModel: "no_builtin_prompts",
    defaultTransport: "pty",
    probedAt: "2026-08-30T00:00:00.000Z",
    candidates: [],
    flags: [],
  };
}

describe("SplitAgentPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: [{
        id: "project-1",
        name: "Demo",
        rootPath: "/tmp/demo",
        gitRootPath: "/tmp/demo",
        pinned: false,
        sessions: [targetSession],
        worktrees: [{
          id: "worktree-1",
          branch: "feature/picker",
          baseCommit: "abc123",
          baseRef: "main",
          path: "/tmp/demo-worktrees/feature",
          health: "clean",
        }],
      }],
      adapters: [adapter("shell"), adapter("codex"), adapter("pi"), adapter("claude"), adapter("qoder")],
      settings: {
        logLimitMib: 200,
        notificationsEnabled: true,
        uiLanguage: "zh-CN",
        theme: "system",
        terminalTheme: "one",
        terminalFontFamily: "system-monospace",
        terminalFontSize: 13,
        terminalCommand: "",
        reducedMotion: "system",
        screenReaderMode: false,
        searchIndexEnabled: true,
        agentOrder: ["claude", "shell"],
        agentHidden: ["pi"],
        telemetryEnabled: false,
      },
      dialog: {
        kind: "splitAgentPicker",
        targetSessionId: targetSession.id,
        direction: "right",
      },
      themeEffective: "dark",
    });
  });

  afterEach(cleanup);

  it("shows every visible installed Agent in the saved order", () => {
    render(
      <SplitAgentPicker
        targetSessionId={targetSession.id}
        direction="right"
      />,
    );

    const picker = screen.getByRole("group");
    expect(within(picker).getAllByRole("button").map((button) => button.dataset.agent))
      .toEqual(["claude", "shell", "codex", "qoder"]);
    expect(screen.queryByText("Pi")).toBeNull();
  });

  it("shows Pi without a permission-mode suffix", () => {
    setState({ settings: { ...getState().settings!, agentHidden: [] } });
    render(
      <SplitAgentPicker
        targetSessionId={targetSession.id}
        direction="right"
      />,
    );

    const piButton = screen.getByRole("button", { name: /Pi/ });
    expect(piButton.getAttribute("aria-label")).not.toMatch(/permission|权限/i);
    expect(within(piButton).queryByText(/permission|权限/i)).toBeNull();
  });

  it.each(["light", "dark"] as const)("shows all nine new brands with native defaults in %s theme", (theme) => {
    setState({
      adapters: ADDED_AGENT_IDS.map(adapter),
      settings: { ...getState().settings!, agentHidden: [], agentOrder: [] },
      themeEffective: theme,
    });
    render(<SplitAgentPicker targetSessionId={targetSession.id} direction="down" />);
    const buttons = within(screen.getByRole("group")).getAllByRole("button");
    expect(buttons.map((button) => button.dataset.agent)).toEqual([...ADDED_AGENT_IDS]);
    for (const agent of ADDED_AGENT_IDS) {
      const button = buttons.find((item) => item.dataset.agent === agent)!;
      expect(button.textContent).toContain(agentDisplay(agent));
      expect(button.getAttribute("aria-label")).toMatch(/原生默认|Native defaults/);
      expect(button.getAttribute("aria-label")).not.toMatch(/绕过|Bypass/);
      expect(button.querySelector(".themed-agent-icon svg")).toBeTruthy();
      fireEvent.click(button);
      expect(quickStartSessionMock).toHaveBeenLastCalledWith(
        targetSession.projectId, agent, targetSession.worktreeId,
        { targetSessionId: targetSession.id, direction: "down" },
      );
    }
  });

  it("closes immediately and quick-starts in the target Worktree and direction", () => {
    render(
      <SplitAgentPicker
        targetSessionId={targetSession.id}
        direction="right"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));

    expect(getState().dialog).toBeNull();
    expect(quickStartSessionMock).toHaveBeenCalledWith(
      targetSession.projectId,
      "codex",
      targetSession.worktreeId,
      { targetSessionId: targetSession.id, direction: "right" },
    );
  });
});
