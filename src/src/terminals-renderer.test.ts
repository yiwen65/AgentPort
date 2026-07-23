// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendererMocks = vi.hoisted(() => {
  const terminals: FakeTerminal[] = [];
  const channels: Array<{ onmessage?: (message: unknown) => void }> = [];
  const apiMock = {
    attachSession: vi.fn().mockResolvedValue({
      attachmentId: 1,
      childAlive: true,
      hostPid: 42,
      logBytes: 0,
      status: null,
      agentSessionId: null,
    }),
    detachSession: vi.fn(),
    markSessionLogRendered: vi.fn().mockResolvedValue(undefined),
    markSessionOutputUnread: vi.fn().mockResolvedValue(undefined),
    resizePty: vi.fn().mockResolvedValue(undefined),
  };
  const config = { canvasShouldFail: false };
  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    element: HTMLDivElement | null = null;
    buffer = { active: { viewportY: 0, baseY: 0, type: "normal" } };
    loadAddon = vi.fn((addon: unknown) => {
      if (addon instanceof FakeCanvasAddon && config.canvasShouldFail) {
        throw new Error("Canvas unavailable");
      }
    });
    onData = vi.fn();
    onScroll = vi.fn();
    open(container: HTMLDivElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
    }
    clearTextureAtlas = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminals.push(this);
    }
  }
  class FakeCanvasAddon {}
  class FakeFitAddon {
    fit = vi.fn();
  }
  class FakeSearchAddon {}
  return {
    apiMock,
    channels,
    config,
    terminals,
    FakeTerminal,
    FakeCanvasAddon,
    FakeFitAddon,
    FakeSearchAddon,
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: rendererMocks.FakeTerminal }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: rendererMocks.FakeCanvasAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: rendererMocks.FakeFitAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: rendererMocks.FakeSearchAddon }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (message: unknown) => void;
    constructor() {
      rendererMocks.channels.push(this);
    }
  },
}));
vi.mock("./api", () => ({
  api: rendererMocks.apiMock,
  b64ToBytes: vi.fn((value: string) =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0))),
  bytesToB64: vi.fn(),
  errorText: (error: unknown) => String(error),
}));

import { disposeHandle, mountTerminal } from "./terminals";
import { getState, setState } from "./store";

describe("terminal renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    rendererMocks.config.canvasShouldFail = false;
    rendererMocks.channels.length = 0;
    vi.clearAllMocks();
    setState({
      activeSessionId: "renderer-test",
      projects: [{
        id: "prj_renderer",
        name: "Renderer",
        rootPath: "/tmp/renderer",
        gitRootPath: null,
        worktrees: [],
        sessions: [{
          id: "renderer-test",
          projectId: "prj_renderer",
          worktreeId: null,
          title: "Renderer test",
          adapter: "shell",
          cwd: "/tmp/renderer",
          lifecycle: "running",
          agentSessionId: null,
          resumePrecision: "unavailable",
          permissionMode: "native",
          transport: "pty",
          logPath: "/tmp/renderer.log",
          unread: false,
          status: null,
          createdAt: "2026-07-23T00:00:00Z",
        }],
      }],
      rendererMode: "dom",
      rendererFallbackReason: null,
    });
  });

  afterEach(() => {
    disposeHandle("renderer-test");
    vi.unstubAllGlobals();
  });

  it("uses CanvasAddon for the default interactive terminal renderer", () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);

    expect(rendererMocks.terminals[rendererMocks.terminals.length - 1]?.loadAddon).toHaveBeenCalledWith(
      expect.any(rendererMocks.FakeCanvasAddon),
    );
    expect(getState().rendererMode).toBe("canvas");
  });

  it("uses the DOM renderer only when CanvasAddon fails to initialize", () => {
    rendererMocks.config.canvasShouldFail = true;
    mountTerminal("renderer-test", document.createElement("div"));

    expect(getState().rendererMode).toBe("dom");
    expect(getState().rendererFallbackReason).toContain("Canvas unavailable");
  });

  it("acknowledges output only after xterm drains the renderer write queue", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 10,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 10 },
    });

    expect(rendererMocks.apiMock.markSessionLogRendered).not.toHaveBeenCalled();
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const callback = terminal.write.mock.calls
      .map((call) => call[1])
      .find((candidate) => typeof candidate === "function");
    expect(callback).toBeTypeOf("function");
    callback?.();

    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenCalledWith(
        "renderer-test",
        1,
        { runId: "run_1", runOrdinal: 1, generation: 0, offset: 11 },
      );
    });
  });

  it("hides Pi's first-session warning when live output starts after replay", async () => {
    const nativeSessionId = "1fd5ff67-01f0-4a8e-8c27-389e5969fd8e";
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "pi",
          agentSessionId: nativeSessionId,
        })),
      })),
    });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "replay_done",
      offset: 0,
      cursor: null,
      partialContext: false,
    });
    const warning = new TextEncoder().encode(
      `\x1b[33mWarning: No project session found with id '${nativeSessionId}'; creating a new session with that id.\x1b[39m\r\n`,
    );
    channel.onmessage?.({
      t: "output",
      data: btoa(String.fromCharCode(...warning)),
      offset: 0,
      cursor: { runId: "run_pi", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const rendered = terminal.write.mock.calls
      .map(([value]) => value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value))
      .join("");
    expect(rendered).not.toContain("No project session found");
  });
});
