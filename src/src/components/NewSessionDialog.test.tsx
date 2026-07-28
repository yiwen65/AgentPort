// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSessionMock, listPresetsMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  listPresetsMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  refreshProjects: vi.fn().mockResolvedValue(undefined),
  selectSession: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    createSession: createSessionMock,
    listPresets: listPresetsMock,
  },
  errorText: (error: unknown) => String(error),
}));

import { setState } from "../store";
import NewSessionDialog from "./NewSessionDialog";

describe("NewSessionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPresetsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue({
      id: "session-1",
      attach: { hostPid: 42, childAlive: true },
      resumePrecision: "unavailable",
      agentSessionId: null,
      notes: [],
      notices: [],
      command: ["/bin/zsh"],
    });
    setState({
      projects: [{
        id: "project-1",
        name: "Demo",
        rootPath: "/tmp/demo",
        gitRootPath: null,
        sessions: [],
        worktrees: [],
      }],
      adapters: [{
        agentType: "shell",
        executablePath: "/bin/zsh",
        versionText: "zsh",
        capabilityHash: "sha256:test",
        exactResume: false,
        hookStatus: "unavailable",
        approvalModel: "no_builtin_prompts",
        defaultTransport: "pty",
        probedAt: "2026-07-23T00:00:00.000Z",
        candidates: [],
        flags: [],
      }],
      dialog: { kind: "newSession", projectId: "project-1", agent: "shell" },
    });
  });

  afterEach(() => cleanup());

  it("centers over the workspace and omits custom argument controls", async () => {
    render(<NewSessionDialog projectId="project-1" agent="shell" />);

    const dialog = screen.getByRole("dialog", { name: "新建 Session" });
    expect(dialog.parentElement?.classList.contains("workspace-centered")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "高级设置 展开" }));
    expect(screen.getByLabelText("预设")).toBeTruthy();
    expect(document.querySelector("#ns-args")).toBeNull();
    expect(screen.queryByText("参数（可选，空格分隔）")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ extraArgs: null }),
    ));
  });

  it("restores native permission when switching away from a bypass preset", async () => {
    setState({
      adapters: [{
        agentType: "qoder",
        executablePath: "/usr/local/bin/qoder",
        versionText: "qoder",
        capabilityHash: "sha256:qoder",
        exactResume: true,
        hookStatus: "supported",
        approvalModel: "native_prompts",
        defaultTransport: "pty",
        probedAt: "2026-07-23T00:00:00.000Z",
        candidates: [],
        flags: [],
      }],
    });
    listPresetsMock.mockResolvedValue([
      {
        id: "qoder-bypass",
        agentType: "qoder",
        name: "Bypass",
        executablePath: "/usr/local/bin/qoder",
        args: [],
        permissionMode: "bypass",
        envNames: [],
        secretRefIds: [],
        builtIn: false,
      },
      {
        id: "qoder-native",
        agentType: "qoder",
        name: "Native",
        executablePath: "/usr/local/bin/qoder",
        args: [],
        permissionMode: "native",
        envNames: [],
        secretRefIds: [],
        builtIn: false,
      },
    ]);

    render(<NewSessionDialog projectId="project-1" agent="qoder" />);
    fireEvent.click(screen.getByRole("button", { name: "高级设置 展开" }));
    const preset = await screen.findByLabelText("预设");
    fireEvent.change(preset, { target: { value: "qoder-bypass" } });
    expect((screen.getByLabelText("权限") as HTMLSelectElement).value).toBe("bypass");
    fireEvent.change(preset, { target: { value: "qoder-native" } });
    expect((screen.getByLabelText("权限") as HTMLSelectElement).value).toBe("native");

    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "qoder-native",
        permission: "native",
      }),
    ));
  });
});
