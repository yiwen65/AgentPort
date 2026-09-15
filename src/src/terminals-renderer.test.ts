// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendererMocks = vi.hoisted(() => {
  const terminals: FakeTerminal[] = [];
  const channels: Array<{ onmessage?: (message: unknown) => void }> = [];
  const offscreenCanvasDuringCanvasLoad: unknown[] = [];
  const offscreenCanvasDuringOpen: unknown[] = [];
  const defaultClipboardCopies: string[] = [];
  const apiMock = {
    attachSession: vi.fn().mockResolvedValue({
      attachmentId: 1,
      childAlive: true,
      hostPid: 42,
      logBytes: 0,
      status: null,
      agentSessionId: null,
    }),
    detachSession: vi.fn().mockResolvedValue(undefined),
    markSessionLogRendered: vi.fn().mockResolvedValue(undefined),
    markSessionOutputUnread: vi.fn().mockResolvedValue(undefined),
    autoRenameSessionFromFirstInput: vi.fn().mockResolvedValue(true),
    clipboardHasImage: vi.fn().mockResolvedValue(false),
    copyText: vi.fn().mockResolvedValue(true),
    getNativeHistory: vi.fn(),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    resizePty: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn(),
  };
  const config = { canvasShouldFail: false, openShouldFail: false };
  class FakeTerminal {
    static strings = { promptLabel: "", tooMuchOutput: "" };
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private readonly bellListeners = new Set<() => void>();
    private readonly renderListeners = new Set<() => void>();
    private readonly oscHandlers = new Map<
      number,
      (data: string) => boolean | Promise<boolean>
    >();
    private readonly csiHandlers = new Map<
      string,
      Array<(params: (number | number[])[]) => boolean | Promise<boolean>>
    >();
    private readonly escHandlers = new Map<
      string,
      Array<() => boolean | Promise<boolean>>
    >();
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    element: HTMLDivElement | null = null;
    textarea: HTMLTextAreaElement | undefined;
    bufferLines: string[] = [];
    unicode = { activeVersion: "6" };
    selectionText = "";
    linkProviders: Array<{
      provideLinks: (
        line: number,
        callback: (
          links:
            | Array<{ text: string; activate(e: unknown, t: string): void }>
            | undefined,
        ) => void,
      ) => void;
    }> = [];
    registerLinkProvider = vi.fn(
      (provider: (typeof this.linkProviders)[number]) => {
        this.linkProviders.push(provider);
      },
    );
    parser = {
      registerOscHandler: vi.fn(
        (ident: number, handler: (data: string) => boolean | Promise<boolean>) => {
          this.oscHandlers.set(ident, handler);
          return { dispose: () => this.oscHandlers.delete(ident) };
        },
      ),
      registerCsiHandler: vi.fn(
        (
          ident: { prefix?: string; intermediates?: string; final: string },
          handler: (params: (number | number[])[]) => boolean | Promise<boolean>,
        ) => {
          const key = `${ident.prefix ?? ""}|${ident.intermediates ?? ""}|${ident.final}`;
          const handlers = this.csiHandlers.get(key) ?? [];
          handlers.push(handler);
          this.csiHandlers.set(key, handlers);
          return {
            dispose: () => {
              const current = this.csiHandlers.get(key) ?? [];
              this.csiHandlers.set(
                key,
                current.filter((candidate) => candidate !== handler),
              );
            },
          };
        },
      ),
      registerEscHandler: vi.fn(
        (
          ident: { intermediates?: string; final: string },
          handler: () => boolean | Promise<boolean>,
        ) => {
          const key = `${ident.intermediates ?? ""}|${ident.final}`;
          const handlers = this.escHandlers.get(key) ?? [];
          handlers.push(handler);
          this.escHandlers.set(key, handlers);
          return {
            dispose: () => {
              const current = this.escHandlers.get(key) ?? [];
              this.escHandlers.set(
                key,
                current.filter((candidate) => candidate !== handler),
              );
            },
          };
        },
      ),
    };
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        length: 24,
        type: "normal",
        getLine: (row: number) => {
          const text = this.bufferLines[row];
          return text === undefined
            ? undefined
            : { translateToString: (_trimRight: boolean) => text };
        },
      },
    };
    loadAddon = vi.fn((addon: unknown) => {
      if (addon instanceof FakeCanvasAddon) {
        offscreenCanvasDuringCanvasLoad.push(globalThis.OffscreenCanvas);
        if (config.canvasShouldFail) throw new Error("Canvas unavailable");
      }
    });
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListeners.add(listener);
      return { dispose: () => this.dataListeners.delete(listener) };
    });
    onScroll = vi.fn();
    onTitleChange = vi.fn((listener: (title: string) => void) => {
      this.titleListeners.add(listener);
      return { dispose: () => this.titleListeners.delete(listener) };
    });
    onBell = vi.fn((listener: () => void) => {
      this.bellListeners.add(listener);
      return { dispose: () => this.bellListeners.delete(listener) };
    });
    onRender = vi.fn((listener: () => void) => {
      this.renderListeners.add(listener);
      return { dispose: () => this.renderListeners.delete(listener) };
    });
    emitRender() {
      for (const listener of this.renderListeners) listener();
    }
    open(container: HTMLDivElement) {
      offscreenCanvasDuringOpen.push(globalThis.OffscreenCanvas);
      if (config.openShouldFail) throw new Error("Terminal open failed");
      this.element = document.createElement("div");
      this.textarea = document.createElement("textarea");
      this.element.appendChild(this.textarea);
      this.element.addEventListener("copy", () => {
        if (this.selectionText) defaultClipboardCopies.push(this.selectionText);
      });
      container.appendChild(this.element);
    }
    emitData(data: string) {
      for (const listener of this.dataListeners) listener(data);
    }
    emitOsc(ident: number, data: string) {
      return this.oscHandlers.get(ident)?.(data);
    }
    emitCsi(
      ident: { prefix?: string; intermediates?: string; final: string },
      params: (number | number[])[],
    ) {
      const key = `${ident.prefix ?? ""}|${ident.intermediates ?? ""}|${ident.final}`;
      for (const handler of this.csiHandlers.get(key) ?? []) handler(params);
    }
    input = vi.fn((data: string) => this.emitData(data));
    paste = vi.fn((data: string) => this.emitData(data));
    selectAll = vi.fn();
    getSelection = vi.fn(() => this.selectionText);
    clearTextureAtlas = vi.fn();
    refresh = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    focus = vi.fn();
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    });
    scrollToLine = vi.fn((line: number) => {
      this.buffer.active.viewportY = line;
    });
    marker = { line: 123, dispose: vi.fn() };
    registerMarker = vi.fn(() => this.marker);
    write = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminals.push(this);
    }
  }
  class FakeCanvasAddon {}
  class FakeWebLinksAddon {
    constructor(readonly handler: (event: MouseEvent, url: string) => void) {}
  }
  class FakeFitAddon {
    fit = vi.fn();
  }
  class FakeSearchAddon {}
  class FakeUnicode11Addon {}
  class FakeSerializeAddon {
    serialize = vi.fn(() => "");
  }
  return {
    apiMock,
    channels,
    config,
    defaultClipboardCopies,
    offscreenCanvasDuringCanvasLoad,
    offscreenCanvasDuringOpen,
    terminals,
    FakeTerminal,
    FakeCanvasAddon,
    FakeWebLinksAddon,
    FakeFitAddon,
    FakeSearchAddon,
    FakeUnicode11Addon,
    FakeSerializeAddon,
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: rendererMocks.FakeTerminal }));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: rendererMocks.FakeCanvasAddon,
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: rendererMocks.FakeFitAddon }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: rendererMocks.FakeSearchAddon,
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: rendererMocks.FakeWebLinksAddon,
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: rendererMocks.FakeUnicode11Addon,
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: rendererMocks.FakeSerializeAddon,
}));
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
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
  ),
  bytesToB64: vi.fn(() => "encoded-input"),
  clipboardHasImage: rendererMocks.apiMock.clipboardHasImage,
  copyText: rendererMocks.apiMock.copyText,
  errorText: (error: unknown) => String(error),
}));

import {
  applyTerminalLanguage,
  applyXtermTheme,
  attachHandle,
  disposeHandle,
  fitHandle,
  fitSession,
  getHandle,
  hasWarmTerminalPreview,
  isTerminalPreviewRendered,
  loadOlderNativeHistory,
  mountTerminal,
  releaseTerminal,
  resetForRestart,
  restoreDesktopTerminalSize,
  scrollTerminalViewport,
  setTerminalActive,
  writeMarker,
} from "./terminals";
import { bytesToB64 } from "./api";
import { applyUiLanguage } from "./i18n";
import { applyProjectsSnapshot, emptyRuntime, getState, setState } from "./store";
import type { AttachInfo, Settings } from "./types";

let resizeObserverCallbacks: Array<() => void> = [];

function invokeWriteCallback(call: ReadonlyArray<unknown> | undefined) {
  const callback = call?.[1];
  if (typeof callback !== "function") {
    throw new Error("Expected terminal write callback");
  }
  callback();
}

describe("terminal renderer", () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeObserverCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    rendererMocks.config.canvasShouldFail = false;
    rendererMocks.config.openShouldFail = false;
    rendererMocks.channels.length = 0;
    rendererMocks.defaultClipboardCopies.length = 0;
    rendererMocks.offscreenCanvasDuringCanvasLoad.length = 0;
    rendererMocks.offscreenCanvasDuringOpen.length = 0;
    vi.clearAllMocks();
    rendererMocks.apiMock.attachSession.mockReset().mockResolvedValue({
      attachmentId: 1, childAlive: true, hostPid: 42, logBytes: 0, status: null, agentSessionId: null,
    });
    rendererMocks.apiMock.listProjects.mockReset();
    vi.mocked(bytesToB64).mockReturnValue("encoded-input");
    rendererMocks.apiMock.clipboardHasImage.mockResolvedValue(false);
    setState({
      activeSessionId: "renderer-test",
      runtime: {},
      platform: null,
      projects: [
        {
          id: "prj_renderer",
          name: "Renderer",
          rootPath: "/tmp/renderer",
          gitRootPath: null,
          pinned: false,
          worktrees: [],
          sessions: [
            {
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
              pinnedAt: null,
              createdAt: "2026-07-23T00:00:00Z",
            },
          ],
        },
      ],
      rendererMode: "dom",
      rendererFallbackReason: null,
    });
    rendererMocks.apiMock.listProjects.mockResolvedValue(getState().projects);
  });

  it("uses Unicode 11 width tables for modern emoji and combining text", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.unicode.activeVersion).toBe("11");
  });

  it.each(["pi", "easy_pi", "omp"] as const)(
    "bounds fullscreen %s cold replay to one Host frame",
    async (adapter) => {
      setState({
        projects: getState().projects.map(project => ({
          ...project,
          sessions: project.sessions.map(session => session.id === "renderer-test"
            ? { ...session, adapter }
            : session),
        })),
      });

      mountTerminal("renderer-test", document.createElement("div"));
      await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());

      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledWith(
        "renderer-test",
        64 * 1024,
        expect.anything(),
        null,
      );
    },
  );

  it("keeps the 4 MiB cold replay window for ordinary Shell Sessions", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());

    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledWith(
      "renderer-test",
      4 * 1024 * 1024,
      expect.anything(),
      null,
    );
  });

  it("bounds in-memory scrollback independently of the persisted log", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.options.scrollback).toBe(10_000);
  });

  it("uses the selected family for new terminals and repaints existing handles in place", () => {
    const settings: Settings = {
      logLimitMib: 200,
      notificationsEnabled: true,
      uiLanguage: "zh-CN",
      theme: "dark",
      terminalTheme: "aurora",
      terminalFontFamily: "system-monospace",
      terminalFontSize: 13,
      terminalCommand: "",
      reducedMotion: "system",
      screenReaderMode: false,
      searchIndexEnabled: false,
      agentOrder: ["shell"],
      agentHidden: [],
      telemetryEnabled: false,
    };
    setState({ settings, themeEffective: "dark" });
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    expect((terminal.options.theme as { background: string }).background).toBe("#0d1321");
    const terminalCount = rendererMocks.terminals.length;
    terminal.clearTextureAtlas.mockClear();
    terminal.refresh.mockClear();
    applyXtermTheme("light", "graphite");

    expect(rendererMocks.terminals).toHaveLength(terminalCount);
    expect((terminal.options.theme as { background: string }).background).toBe("#ffffff");
    expect(terminal.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("renders an ended PTY exclusively from the agent-native log", async () => {
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "codex",
          lifecycle: "stopped" as const,
        })),
      })),
    });
    rendererMocks.apiMock.getNativeHistory.mockResolvedValue({
      sourceStatus: { status: "available", sources: [] },
      events: [{
        id: "native-answer",
        sourceId: "native-source",
        provider: "codex",
        kind: "message",
        role: "assistant",
        timestamp: "2026-08-25T00:00:00Z",
        text: "native answer\u001b[2J remains plain text",
      }],
      nextCursor: null,
      skippedLines: 0,
    });

    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.getNativeHistory).toHaveBeenCalledWith(
        "renderer-test",
        null,
        200,
      ),
    );

    expect(rendererMocks.apiMock.attachSession).not.toHaveBeenCalled();
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    invokeWriteCallback(
      terminal.write.mock.calls.find((call: unknown[]) => call[0] === ""),
    );
    const rendered = terminal.write.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("");
    expect(rendered).toContain("native answer␛[2J remains plain text");
    expect(rendered).not.toContain("\u001b[2J remains plain text");
  });

  it("deduplicates an in-flight native page request", async () => {
    let resolvePage!: (page: {
      sourceStatus: { status: "available"; sources: never[] };
      events: never[];
      nextCursor: null;
      skippedLines: number;
    }) => void;
    rendererMocks.apiMock.getNativeHistory.mockReturnValue(
      new Promise((resolve) => { resolvePage = resolve; }),
    );
    mountTerminal("renderer-test", document.createElement("div"));

    const first = loadOlderNativeHistory("renderer-test");
    const second = loadOlderNativeHistory("renderer-test");
    expect(rendererMocks.apiMock.getNativeHistory).toHaveBeenCalledTimes(1);
    resolvePage({
      sourceStatus: { status: "available", sources: [] },
      events: [],
      nextCursor: null,
      skippedLines: 0,
    });
    await Promise.all([first, second]);
  });

  it("prepends consecutive native pages without moving the visible xterm row", async () => {
    rendererMocks.apiMock.getNativeHistory
      .mockResolvedValueOnce({
        sourceStatus: { status: "available", sources: [] },
        events: [{
          id: "latest",
          sourceId: "native",
          provider: "codex",
          kind: "message",
          role: "assistant",
          timestamp: null,
          text: "latest native event",
        }],
        nextCursor: "older-page",
        skippedLines: 0,
      })
      .mockResolvedValueOnce({
        sourceStatus: { status: "available", sources: [] },
        events: [{
          id: "older",
          sourceId: "native",
          provider: "codex",
          kind: "message",
          role: "user",
          timestamp: null,
          text: "older native event",
        }],
        nextCursor: null,
        skippedLines: 0,
      });
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.viewportY = 0;
    terminal.buffer.active.cursorY = 10;
    terminal.buffer.active.length = 124;
    const handle = getHandle("renderer-test")!;
    vi.mocked(handle.serialize.serialize).mockReturnValue("live terminal snapshot");

    const firstCall = terminal.write.mock.calls.length;
    const first = loadOlderNativeHistory("renderer-test");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.getNativeHistory).toHaveBeenCalledWith(
        "renderer-test",
        null,
        200,
      ),
    );
    invokeWriteCallback(terminal.write.mock.calls[firstCall]);
    invokeWriteCallback(terminal.write.mock.calls[firstCall + 1]);
    terminal.marker.line = 123;
    terminal.buffer.active.baseY = 130;
    terminal.buffer.active.viewportY = 130;
    invokeWriteCallback(terminal.write.mock.calls[firstCall + 3]);
    await first;
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(124);
    const serializeCallsAfterFirst = vi.mocked(handle.serialize.serialize).mock.calls.length;

    terminal.buffer.active.viewportY = 0;
    terminal.buffer.active.length = 154;
    terminal.marker.line = 123;
    const secondCall = terminal.write.mock.calls.length;
    const second = loadOlderNativeHistory("renderer-test");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.getNativeHistory).toHaveBeenLastCalledWith(
        "renderer-test",
        "older-page",
        200,
      ),
    );
    invokeWriteCallback(terminal.write.mock.calls[secondCall]);
    invokeWriteCallback(terminal.write.mock.calls[secondCall + 1]);
    terminal.marker.line = 153;
    terminal.buffer.active.baseY = 160;
    terminal.buffer.active.viewportY = 160;
    invokeWriteCallback(terminal.write.mock.calls[secondCall + 3]);
    await second;

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(30);
    expect(handle.serialize.serialize).toHaveBeenCalledTimes(
      serializeCallsAfterFirst,
    );
    const secondPrefix = String(terminal.write.mock.calls[secondCall + 1]?.[0]);
    expect(secondPrefix.indexOf("older native event")).toBeLessThan(
      secondPrefix.indexOf("latest native event"),
    );
  });

  it("invalidates the cached native-history tail when live output arrives", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    const handle = getHandle("renderer-test")!;
    handle.nativeHistoryBoundaryMarker = terminal.registerMarker() as never;
    handle.nativeHistoryTailSnapshot = "cached live tail";
    handle.nativeHistoryTailDirty = false;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    });

    expect(handle.nativeHistoryTailDirty).toBe(true);
  });

  afterEach(() => {
    disposeHandle("renderer-test");
    setState({ settings: null });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses CanvasAddon for the default interactive terminal renderer", () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);

    expect(
      rendererMocks.terminals[rendererMocks.terminals.length - 1]?.loadAddon,
    ).toHaveBeenCalledWith(expect.any(rendererMocks.FakeCanvasAddon));
    expect(getState().rendererMode).toBe("canvas");
  });

  it("invalidates a cached native-history tail after terminal reflow", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    const handle = getHandle("renderer-test")!;
    handle.nativeHistoryBoundaryMarker = terminal.registerMarker() as never;
    handle.nativeHistoryTailSnapshot = "cached live tail";
    handle.nativeHistoryTailDirty = false;
    handle.lastCols = terminal.cols - 1;

    fitHandle(handle);

    expect(handle.nativeHistoryTailDirty).toBe(true);
  });

  it("routes explicit viewport commands through one controller", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const handle = getHandle("renderer-test");
    terminal.buffer.active.baseY = 100;

    scrollTerminalViewport("renderer-test", { type: "line", line: 42 });
    expect(terminal.scrollToLine).toHaveBeenCalledWith(42);
    expect(handle?.viewport.currentMode).toBe("reading");

    scrollTerminalViewport("renderer-test", { type: "bottom", focus: true });
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(handle?.viewport.currentMode).toBe("follow");
  });

  it("defers hidden-pane resize work and fits once after activation", async () => {
    setState({ activeSessionId: "another-session" });
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const handle = getHandle("renderer-test")!;

    vi.mocked(handle.fit.fit).mockClear();
    resizeObserverCallbacks[0]?.();
    expect(handle.fit.fit).not.toHaveBeenCalled();
    expect(handle.geometryDirty).toBe(true);

    setTerminalActive("renderer-test", true);
    fitSession("renderer-test", true);
    expect(handle.fit.fit).toHaveBeenCalledOnce();
    expect(handle.geometryDirty).toBe(false);
    expect(handle.fitCount).toBe(1);
    expect(handle.lastFitReason).toBe("activate");
    expect(handle.lastFitDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("reveals Pi startup after the timeout even when parser drains are wedged", () => {
    vi.useFakeTimers();
    setState({
      projects: [
        {
          id: "prj",
          name: "Project",
          rootPath: "/tmp/project",
          gitRootPath: null,
          pinned: false,
          sessions: [
            {
              ...getState().projects[0].sessions[0],
              adapter: "pi",
              transport: "pty",
            },
          ],
          worktrees: [],
        },
      ],
      runtime: {
        ...getState().runtime,
        "renderer-test": { ...emptyRuntime(), startupPending: true, attaching: true },
      },
    });
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const handle = getHandle("renderer-test")!;
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    vi.mocked(terminal.refresh).mockClear();

    vi.runOnlyPendingTimers();

    expect(getState().runtime["renderer-test"]?.startupPending).toBe(false);
    expect(getState().runtime["renderer-test"]?.replayDone).toBe(true);
    expect(handle.displayReady).toBe(true);
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("repaints the canvas after coalesced visible-pane resize", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1]!;
    vi.mocked(terminal.refresh).mockClear();

    resizeObserverCallbacks[0]?.();
    expect(terminal.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(90);

    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("fits xterm without publishing a passive PTY resize while mobile owns geometry", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const handle = getHandle("renderer-test")!;
    handle.attached = true;
    handle.lastCols = handle.term.cols - 1;
    setState({
      runtime: {
        ...getState().runtime,
        "renderer-test": {
          ...emptyRuntime(),
          attached: true,
          terminalGeometry: {
            runId: "run-mobile",
            runOrdinal: 2,
            cols: 48,
            rows: 40,
            sourceKind: "mobile",
            sourceDeviceId: "phone-1",
            attachmentId: 9,
            orientation: "portrait",
            revision: 4,
            updatedAt: "2026-09-02T10:00:00Z",
          },
        },
      },
    });
    rendererMocks.apiMock.resizePty.mockClear();

    fitHandle(handle, true, true, "desktop-window-resize");
    vi.runAllTimers();

    expect(handle.fit.fit).toHaveBeenCalled();
    expect(rendererMocks.apiMock.resizePty).not.toHaveBeenCalled();
  });

  it("restores desktop geometry with the mobile revision fence", async () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    container.getBoundingClientRect = () =>
      ({ width: 800, height: 600 }) as DOMRect;
    mountTerminal("renderer-test", container);
    const handle = getHandle("renderer-test")!;
    handle.attached = true;
    rendererMocks.apiMock.resizePty.mockClear();

    await restoreDesktopTerminalSize("renderer-test", 12);

    expect(rendererMocks.apiMock.resizePty).toHaveBeenCalledWith(
      "renderer-test",
      handle.term.cols,
      handle.term.rows,
      800,
      600,
      { expectedRevision: 12, sourceKind: "desktop" },
    );
  });

  it("preserves a user's scrollback position when fitting reflows the viewport", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 1_000;
    terminal.buffer.active.viewportY = 400;
    const handle = getHandle("renderer-test");
    expect(handle).toBeDefined();
    handle!.fit.fit = vi.fn(() => {
      terminal.buffer.active.viewportY = 0;
    });

    fitHandle(handle!);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(400);
    expect(terminal.buffer.active.viewportY).toBe(400);
  });

  it("restores a bottomed buffer synchronously after a Session re-entry fit", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 1_000;
    terminal.buffer.active.viewportY = 1_000;
    const handle = getHandle("renderer-test")!;
    handle.fit.fit = vi.fn(() => {
      terminal.buffer.active.viewportY = 0;
    });

    fitSession("renderer-test");

    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.viewportY).toBe(1_000);
  });

  it("leaves xterm's native viewport synchronized before the first upward wheel", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 1_000;
    terminal.buffer.active.viewportY = 1_000;
    const nativeViewport = document.createElement("div");
    nativeViewport.className = "xterm-viewport";
    Object.defineProperties(nativeViewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 10_000 },
    });
    nativeViewport.scrollTop = 0;
    terminal.element?.appendChild(nativeViewport);

    fitSession("renderer-test");

    expect(nativeViewport.scrollTop).toBe(9_500);
  });

  it("does not queue a repair that can override the user's next upward scroll", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 1_000;
    terminal.buffer.active.viewportY = 1_000;
    const handle = getHandle("renderer-test")!;
    handle.fit.fit = vi.fn(() => {
      terminal.buffer.active.viewportY = 0;
    });
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");

    fitSession("renderer-test");
    terminal.buffer.active.viewportY = 990;

    expect(requestFrame).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.viewportY).toBe(990);
  });

  it.each([
    ["already at the top", "normal", 0, 1_000, "normal"],
    ["already at the bottom", "normal", 1_000, 1_000, "normal"],
    ["using the alternate buffer", "alternate", 400, 1_000, "alternate"],
    ["switching buffers during fit", "normal", 400, 1_000, "alternate"],
  ])(
    "does not restore scrollback when %s",
    (_label, beforeType, viewport, base, afterType) => {
      const container = document.createElement("div");
      Object.defineProperties(container, {
        clientWidth: { configurable: true, value: 800 },
        clientHeight: { configurable: true, value: 600 },
      });
      mountTerminal("renderer-test", container);
      const terminal =
        rendererMocks.terminals[rendererMocks.terminals.length - 1];
      terminal.buffer.active.type = beforeType;
      terminal.buffer.active.viewportY = viewport;
      terminal.buffer.active.baseY = base;
      const handle = getHandle("renderer-test")!;
      handle.fit.fit = vi.fn(() => {
        terminal.buffer.active.type = afterType;
        terminal.buffer.active.viewportY = 0;
      });

      fitHandle(handle);

      expect(terminal.scrollToLine).not.toHaveBeenCalled();
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    },
  );

  it("opens plain and OSC 8 web links through the native URL command", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const webLinksAddon = terminal.loadAddon.mock.calls
      .map(([addon]) => addon)
      .find(
        (addon) => addon instanceof rendererMocks.FakeWebLinksAddon,
      ) as InstanceType<typeof rendererMocks.FakeWebLinksAddon>;

    webLinksAddon.handler(new MouseEvent("click"), "https://example.com/plain");
    const linkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, url: string) => void;
      allowNonHttpProtocols: boolean;
    };
    linkHandler.activate(new MouseEvent("click"), "https://example.com/osc8");

    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.openExternalUrl).toHaveBeenNthCalledWith(
        1,
        "https://example.com/plain",
      );
      expect(rendererMocks.apiMock.openExternalUrl).toHaveBeenNthCalledWith(
        2,
        "https://example.com/osc8",
      );
    });
    // file:// OSC 8 links must reach activate() so they can open the
    // in-app document viewer; only validated http(s) URLs leave the app.
    expect(linkHandler.allowNonHttpProtocols).toBe(true);
  });

  it("routes file links into the in-app document viewer instead of the OS", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const linkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, url: string) => void;
    };

    linkHandler.activate(
      new MouseEvent("click"),
      "file:///Users/w/project/docs/%E6%8A%A5%E5%91%8A.md:12",
    );

    expect(getState().openDocument).toEqual({
      path: "/Users/w/project/docs/报告.md",
      line: 12,
    });
    expect(rendererMocks.apiMock.openExternalUrl).not.toHaveBeenCalled();
    setState({ openDocument: null });
  });

  it("links plain-text absolute paths and skips URL path segments", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.bufferLines = [
      "已生成文档：[报告](/Users/w/project/docs/report.md:5) 请查收",
      "见 https://example.com/docs/report.md 了解详情",
    ];

    const provider = terminal.linkProviders[terminal.linkProviders.length - 1];
    const collect = (line: number) => {
      let found:
        | Array<{ text: string; activate(e: unknown, t: string): void }>
        | undefined;
      provider.provideLinks(line, (links) => {
        found = links;
      });
      return found ?? [];
    };

    const lineOne = collect(1);
    expect(lineOne.map((link) => link.text)).toEqual([
      "/Users/w/project/docs/report.md:5",
    ]);
    // The path inside an http(s) URL belongs to the WebLinksAddon, not us.
    expect(collect(2)).toEqual([]);

    lineOne[0]?.activate(new MouseEvent("click"), lineOne[0].text);
    expect(getState().openDocument).toEqual({
      path: "/Users/w/project/docs/report.md",
      line: 5,
    });
    setState({ openDocument: null });
  });

  it("links relative paths from their first segment and resolves them from the session cwd", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.bufferLines = [
      "src/src/components/DocumentPanel.tsx",
      "- changed src/src/styles.css:42 and ./docs/guide.md",
    ];

    const provider = terminal.linkProviders[terminal.linkProviders.length - 1];
    const collect = (line: number) => {
      let found:
        | Array<{ text: string; activate(e: unknown, t: string): void }>
        | undefined;
      provider.provideLinks(line, (links) => {
        found = links;
      });
      return found ?? [];
    };

    expect(collect(1).map((link) => link.text)).toEqual([
      "src/src/components/DocumentPanel.tsx",
    ]);
    expect(collect(2).map((link) => link.text)).toEqual([
      "src/src/styles.css:42",
      "./docs/guide.md",
    ]);

    const relativeLink = collect(1)[0];
    relativeLink?.activate(new MouseEvent("click"), relativeLink.text);
    expect(getState().openDocument).toEqual({
      path: "/tmp/renderer/src/src/components/DocumentPanel.tsx",
      line: null,
    });
    setState({ openDocument: null });
  });

  it("stops plain-path links before prose punctuation", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.bufferLines = [
      "已生成文档 /Users/w/AI/AI心法.md, 包含八重心法：",
      "详见 /tmp/说明文档.md，包含三部分。",
    ];

    const provider = terminal.linkProviders[terminal.linkProviders.length - 1];
    const collect = (line: number) => {
      let found: Array<{ text: string }> | undefined;
      provider.provideLinks(line, (links) => {
        found = links as Array<{ text: string }> | undefined;
      });
      return found ?? [];
    };

    // Half-width comma before the space and CJK punctuation must not leak
    // into the link target (this produced document_not_found before).
    expect(collect(1).map((link) => link.text)).toEqual([
      "/Users/w/AI/AI心法.md",
    ]);
    expect(collect(2).map((link) => link.text)).toEqual(["/tmp/说明文档.md"]);
  });

  it("uses DOM font measurement while retaining Canvas rendering on Linux", () => {
    const offscreenCanvas = class {};
    vi.stubGlobal("OffscreenCanvas", offscreenCanvas);
    setState({
      platform: {
        os: "linux",
        osVersion: "24.04",
        arch: "x86_64",
        webview: "WebKitGTK",
        appVersion: "0.1.0",
      },
    });

    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];

    expect(
      rendererMocks.offscreenCanvasDuringOpen[
        rendererMocks.offscreenCanvasDuringOpen.length - 1
      ],
    ).toBeUndefined();
    expect(globalThis.OffscreenCanvas).toBe(offscreenCanvas);
    expect(
      rendererMocks.offscreenCanvasDuringCanvasLoad[
        rendererMocks.offscreenCanvasDuringCanvasLoad.length - 1
      ],
    ).toBe(offscreenCanvas);
    expect(terminal.loadAddon).toHaveBeenCalledWith(
      expect.any(rendererMocks.FakeCanvasAddon),
    );
    expect(getState().rendererMode).toBe("canvas");
  });

  it("restores OffscreenCanvas when opening a Linux terminal fails", () => {
    const offscreenCanvas = class {};
    vi.stubGlobal("OffscreenCanvas", offscreenCanvas);
    rendererMocks.config.openShouldFail = true;
    setState({
      platform: {
        os: "linux",
        osVersion: "24.04",
        arch: "x86_64",
        webview: "WebKitGTK",
        appVersion: "0.1.0",
      },
    });

    expect(() =>
      mountTerminal("renderer-test", document.createElement("div")),
    ).toThrow("Terminal open failed");
    expect(globalThis.OffscreenCanvas).toBe(offscreenCanvas);
  });

  it("keeps the native font measurement path unchanged on macOS", () => {
    const offscreenCanvas = class {};
    vi.stubGlobal("OffscreenCanvas", offscreenCanvas);
    setState({
      platform: {
        os: "macos",
        osVersion: "15.0",
        arch: "aarch64",
        webview: "WebKit",
        appVersion: "0.1.0",
      },
    });

    mountTerminal("renderer-test", document.createElement("div"));

    expect(
      rendererMocks.offscreenCanvasDuringOpen[
        rendererMocks.offscreenCanvasDuringOpen.length - 1
      ],
    ).toBe(offscreenCanvas);
    expect(globalThis.OffscreenCanvas).toBe(offscreenCanvas);
  });

  it("copies Unicode terminal selections through the async clipboard path", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const selection =
      '/wjskill-prompt-refiner "审查 @/Users/w/AD/Apollo/模块，给出结论"';
    terminal.selectionText = selection;

    terminal.element?.dispatchEvent(
      new Event("copy", {
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.copyText).toHaveBeenCalledWith(selection);
    });
    expect(rendererMocks.defaultClipboardCopies).toEqual([]);
  });

  it("forwards an image clipboard paste to the Agent image-paste shortcut", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png" }],
        files: [],
        types: ["Files"],
        getData: () => "",
      },
    });

    terminal.textarea?.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(terminal.input).toHaveBeenCalledWith("\x16");
    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledWith(
        "renderer-test",
        "encoded-input",
      );
    });
  });

  it("probes the native clipboard when WebKit omits image paste metadata", async () => {
    rendererMocks.apiMock.clipboardHasImage.mockResolvedValue(true);
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [],
        files: [],
        types: [],
        getData: () => "",
      },
    });

    terminal.textarea?.dispatchEvent(paste);

    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.clipboardHasImage).toHaveBeenCalledOnce();
      expect(terminal.input).toHaveBeenCalledWith("\x16");
    });
  });

  it("leaves plain-text paste on xterm's native path", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [{ kind: "string", type: "text/plain" }],
        files: [],
        types: ["text/plain"],
        getData: () => "plain text",
      },
    });

    terminal.textarea?.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(rendererMocks.apiMock.clipboardHasImage).not.toHaveBeenCalled();
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("serializes independent terminal input events behind an in-flight send", async () => {
    let releaseFirst: (() => void) | undefined;
    rendererMocks.apiMock.sendInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];

    terminal.emitData("first");
    terminal.emitData("second");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(1),
    );

    releaseFirst?.();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(2),
    );
  });

  it("accepts input when the attach channel becomes writable before the invoke reply", async () => {
    let resolveAttach: ((info: AttachInfo) => void) | undefined;
    rendererMocks.apiMock.attachSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve;
        }),
    );
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const info: AttachInfo = {
      attachmentId: 41,
      childAlive: true,
      hostPid: 42,
      logBytes: 0,
      protocol: 2,
      agentSessionId: null,
      runId: "run_1",
      runOrdinal: 1,
      status: null,
      logCursor: {
        runId: "run_1",
        runOrdinal: 1,
        generation: 0,
        offset: 0,
      },
    };

    vi.mocked(bytesToB64).mockImplementation((bytes) =>
      new TextDecoder().decode(bytes),
    );
    terminal.emitData("first");
    terminal.emitData("second");
    expect(rendererMocks.apiMock.sendInput).not.toHaveBeenCalled();

    rendererMocks.channels[0].onmessage?.({ t: "attached", info });
    terminal.emitData("third");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput.mock.calls).toEqual([
        ["renderer-test", "first"],
        ["renderer-test", "second"],
        ["renderer-test", "third"],
      ]),
    );
    // The invoke reply is deliberately still pending: replay delivery cannot
    // keep a warm terminal's first keystroke behind this response anymore.
    resolveAttach?.(info);
    await Promise.resolve();
    expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("reattaches an external restart and clears old run state (exit observed: %s)", async sawExit => {
    const oldInfo = { attachmentId: 101, childAlive: true, hostPid: 42, logBytes: 0, status: null,
      runId: "old-run", runOrdinal: 1, logCursor: { runId: "old-run", runOrdinal: 1, generation: 0, offset: 0 } };
    rendererMocks.apiMock.attachSession.mockResolvedValueOnce(oldInfo);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(getHandle("renderer-test")?.attached).toBe(true));
    const oldChannel = rendererMocks.channels[0];
    oldChannel.onmessage?.({ t: "process_status", suspended: true, signal: 20 });
    oldChannel.onmessage?.({ t: "output", data: btoa("old"), offset: 0, cursor: oldInfo.logCursor });
    if (sawExit) oldChannel.onmessage?.({ t: "exit", code: 0, signal: null, groupCleaned: true, reason: "user_stop", runId: "old-run", runOrdinal: 1 });
    const nextStatus = { sessionId: "renderer-test", runId: "new-run", runOrdinal: 2, sequence: 1,
      state: "idle" as const, source: "process" as const, confidence: "high" as const, evidence: null, logCursor: null, occurredAt: "2026-09-08T01:00:00Z" };
    applyProjectsSnapshot(getState().projects.map(project => ({ ...project,
      sessions: project.sessions.map(session => ({ ...session, lifecycle: "running", hostAlive: true, status: nextStatus })) })));
    const nextInfo = { ...oldInfo, attachmentId: 102, hostPid: 43, runId: "new-run", runOrdinal: 2, status: nextStatus };
    rendererMocks.apiMock.attachSession.mockResolvedValueOnce(nextInfo);
    await attachHandle("renderer-test");
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
    expect(rendererMocks.apiMock.attachSession.mock.calls[1][3]).toBeNull();
    expect(getState().runtime["renderer-test"]).toMatchObject({ attached: true, exit: null, suspended: false, hostPid: 43 });
    expect(getHandle("renderer-test")?.attachmentId).toBe(102);
    oldChannel.onmessage?.({ t: "exit", code: 0, signal: null, groupCleaned: true, reason: "user_stop", runId: "old-run", runOrdinal: 1 });
    expect(getState().projects[0].sessions[0].lifecycle).toBe("running");
    expect(getState().runtime["renderer-test"]?.exit).toBeNull();
  });

  it("finishes a rejected stale handshake instead of leaving the loading overlay stuck", async () => {
    setState({ projects: getState().projects.map(project => ({ ...project, sessions: project.sessions.map(session => ({ ...session,
      status: { sessionId: session.id, runId: "current", runOrdinal: 2, sequence: 1, state: "idle", source: "process", confidence: "high", evidence: null, logCursor: null, occurredAt: "2026-09-08T00:00:00Z" },
    })) })) });
    rendererMocks.apiMock.attachSession.mockResolvedValueOnce({ attachmentId: 7, childAlive: true, runId: "old", runOrdinal: 1 });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attaching).toBe(false));
    expect(getState().runtime["renderer-test"]).toMatchObject({ attached: false, detached: true });
    expect(rendererMocks.apiMock.detachSession).toHaveBeenCalledWith("renderer-test", 7);
  });

  it("does not revive an attachment whose own run exits before its invoke reply", async () => {
    let finish!: (info: unknown) => void;
    rendererMocks.apiMock.attachSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    rendererMocks.channels[0].onmessage?.({ t: "exit", code: 1, signal: null, groupCleaned: true, reason: "child_exit", runId: "run", runOrdinal: 1 });
    finish({ attachmentId: 88, childAlive: true, runId: "run", runOrdinal: 1 });
    await Promise.resolve(); await Promise.resolve();
    expect(getState().runtime["renderer-test"]).toMatchObject({ attached: false, exit: { code: 1 } });
    expect(getState().projects[0].sessions[0].lifecycle).toBe("exited");
  });

  it("uses the DOM renderer only when CanvasAddon fails to initialize", () => {
    rendererMocks.config.canvasShouldFail = true;
    mountTerminal("renderer-test", document.createElement("div"));

    expect(getState().rendererMode).toBe("dom");
    expect(getState().rendererFallbackReason).toContain("Canvas unavailable");
  });

  it("updates xterm strings and existing terminal ARIA text when the language changes", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();

    expect(rendererMocks.FakeTerminal.strings.promptLabel).toBe(
      "Terminal input",
    );
    expect(rendererMocks.FakeTerminal.strings.tooMuchOutput).toContain(
      "Some output was omitted",
    );
    expect(terminal.textarea?.getAttribute("aria-label")).toBe(
      "Terminal input",
    );
  });

  it("re-localizes cached runtime errors and history notes on existing terminals", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "error",
      code: "status_persistence_failed",
      message: "状态未持久化",
      technicalDetail: "SQLITE_BUSY",
    });
    channel.onmessage?.({
      t: "resync_required",
      earliest: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
      reason: "generation changed",
    });
    expect(getState().runtime["renderer-test"]?.error).toBe(
      "Session 状态无法保存：SQLITE_BUSY",
    );
    expect(getState().runtime["renderer-test"]?.historyNote).toBe(
      "输出已重新同步：generation changed",
    );

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();

    expect(getState().runtime["renderer-test"]?.error).toBe(
      "Could not save the Session status: SQLITE_BUSY",
    );
    expect(getState().runtime["renderer-test"]?.historyNote).toBe(
      "Output resynchronized: generation changed",
    );
  });

  it("preserves the alternate buffer while rebuilding a resynchronized tail", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.type = "alternate";
    const channel = rendererMocks.channels[0];

    channel.onmessage?.({
      t: "resync_required",
      earliest: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 10 },
      reason: "retained tail advanced",
    });

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write.mock.calls.some(([data]) => data === "\u001b[2J\u001b[H")).toBe(true);
    expect(terminal.buffer.active.type).toBe("alternate");
  });

  it("replaces a stale error envelope when an output gap starts a reconnect", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_gap", runOrdinal: 1, generation: 0, offset: 0 },
    });
    channel.onmessage?.({
      t: "error",
      code: "status_persistence_failed",
      message: "状态未持久化",
      technicalDetail: "old detail",
    });
    rendererMocks.apiMock.attachSession.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    channel.onmessage?.({
      t: "output",
      data: "Qg==",
      offset: 5,
      cursor: { runId: "run_gap", runOrdinal: 1, generation: 0, offset: 5 },
    });

    expect(getState().runtime["renderer-test"]?.errorMessage?.code).toBe(
      "terminal_output_gap",
    );
    expect(getState().runtime["renderer-test"]?.error).toBe(
      "输出流出现间隙，正在重新同步",
    );

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();
    expect(getState().runtime["renderer-test"]?.error).toBe(
      "The output stream has a gap; resynchronizing",
    );
  });

  it("automatically retries a transient Host connection failure and clears its error", async () => {
    vi.useFakeTimers();
    rendererMocks.apiMock.attachSession.mockRejectedValueOnce({ code: "host_connection_failed", technicalDetail: "host not reachable" });
    rendererMocks.apiMock.listProjects.mockResolvedValueOnce(getState().projects);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().runtime["renderer-test"]?.detached).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
    expect(getState().runtime["renderer-test"]).toMatchObject({ attached: true, detached: false, error: null, errorMessage: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
  });

  it("refreshes a stale running session after Host attach failure stops being live", async () => {
    vi.useFakeTimers();
    rendererMocks.apiMock.attachSession.mockRejectedValue(new Error("host not reachable"));
    rendererMocks.apiMock.listProjects.mockResolvedValueOnce(getState().projects.map(project => ({
      ...project,
      sessions: project.sessions.map(session => ({ ...session, lifecycle: "interrupted" as const, hostAlive: false })),
    })));
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(rendererMocks.apiMock.listProjects).toHaveBeenCalledTimes(1));
    expect(getState().projects[0].sessions[0]).toMatchObject({ lifecycle: "interrupted", hostAlive: false });
    expect(getState().runtime["renderer-test"]?.detached).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(1);
  });

  it("reconnects a lost channel from its contiguous cursor without clearing the terminal", async () => {
    vi.useFakeTimers();
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    const handle = getHandle("renderer-test")!;
    const cursor = { runId: "run-reconnect", runOrdinal: 1, generation: 0, offset: 0 };
    rendererMocks.channels[0].onmessage?.({ t: "output", data: "QQ==", offset: 0, cursor });
    rendererMocks.channels[0].onmessage?.({ t: "detached" });
    await vi.advanceTimersByTimeAsync(500);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
    expect(rendererMocks.apiMock.attachSession.mock.calls[1][3]).toEqual({ ...cursor, offset: 1 });
    expect(handle.term.reset).not.toHaveBeenCalled();
    expect(getState().runtime["renderer-test"]?.attached).toBe(true);
    rendererMocks.channels[0].onmessage?.({ t: "detached" });
    expect(getState().runtime["renderer-test"]?.attached).toBe(true);
  });

  it("backs off repeated failures and caps retries at one per five seconds", async () => {
    vi.useFakeTimers();
    rendererMocks.apiMock.attachSession.mockRejectedValue(new Error("host not reachable"));
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [500, 1000, 2000, 4000, 5000, 5000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(index + 2);
    }
    expect(getState().runtime["renderer-test"]?.detached).toBe(true);
  });

  it.each(["hidden", "disposed", "ended", "restarted"])("does not retry an obsolete attachment after it is %s", async reason => {
    vi.useFakeTimers();
    rendererMocks.apiMock.attachSession.mockRejectedValue(new Error("host not reachable"));
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "hidden") setTerminalActive("renderer-test", false);
    if (reason === "disposed") disposeHandle("renderer-test");
    if (reason === "restarted") resetForRestart("renderer-test");
    if (reason === "ended") setState({ projects: getState().projects.map(project => ({ ...project, sessions: project.sessions.map(session => ({ ...session, lifecycle: "exited" as const })) })) });
    await vi.advanceTimersByTimeAsync(10000);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(1);
  });

  it("fences a detached channel before a late attach reply and never overlaps pending retries", async () => {
    vi.useFakeTimers();
    let finish!: (info: AttachInfo) => void;
    rendererMocks.apiMock.attachSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mountTerminal("renderer-test", document.createElement("div"));
    rendererMocks.channels[0].onmessage?.({ t: "detached" });
    rendererMocks.apiMock.attachSession.mockReturnValueOnce(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(500);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
    finish({ attachmentId: 99, childAlive: true, hostPid: 42, logBytes: 0, status: null, agentSessionId: null } as AttachInfo);
    await vi.advanceTimersByTimeAsync(10000);
    expect(rendererMocks.apiMock.detachSession).toHaveBeenCalledWith("renderer-test", 99);
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledTimes(2);
    expect(getState().runtime["renderer-test"]?.attached).not.toBe(true);
  });

  it("re-localizes a structured Host attach rejection", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    rendererMocks.apiMock.attachSession.mockRejectedValueOnce({
      code: "host_connection_failed",
      params: {},
      technicalDetail: "connection refused",
      message: "无法连接 Host",
    });
    mountTerminal("renderer-test", document.createElement("div"));

    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.error).toBe(
        "无法连接 Host：connection refused",
      ),
    );
    expect(getState().runtime["renderer-test"]?.errorMessage?.code).toBe(
      "host_connection_failed",
    );

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();
    expect(getState().runtime["renderer-test"]?.error).toBe(
      "Could not connect to the Host: connection refused",
    );
  });

  it("forwards native repeat keydowns even when xterm does not emit their input", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("s");
    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledWith(
        "renderer-test",
        "encoded-input",
      );
    });
  });

  it("stops synthetic repeat when remote text commits after xterm handled its keydown", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.textarea?.addEventListener("keydown", () =>
      terminal.emitData("a"),
    );
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "a",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(550);

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("forwards remote committed text once without repeating after a missing keyup", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "d",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(550);

    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("d");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("does not infer a held key from UU's keydown-only text stream", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.textarea?.addEventListener("keydown", (event) =>
      terminal.emitData(event.key),
    );
    vi.useFakeTimers();

    for (const key of ["a", "b", "c"]) {
      terminal.textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          // UU Remote reports every committed phone-keyboard character with
          // the same physical code and sends neither keyup nor InputEvent.
          code: "KeyA",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(550);

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(3),
    );
  });

  it("does not use terminal-generated OSC color replies for the automatic title", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];

    // xterm sends OSC 10 replies back through onData when a CLI asks for the
    // terminal foreground color. The reply may be split across IPC chunks.
    terminal.emitData("\x1b]10;rgb:d4d4/d4d4/");
    terminal.emitData("d4d4\x07");
    terminal.emitData("请修复自动命名\r");

    await vi.waitFor(() =>
      expect(
        rendererMocks.apiMock.autoRenameSessionFromFirstInput,
      ).toHaveBeenCalledWith("renderer-test", "请修复自动命名"),
    );
  });

  it("lets xterm handle native repeats in screen-reader mode without duplicating them", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.options.screenReaderMode = true;
    const xtermKeyDown = vi.fn(() => terminal.emitData("s"));
    terminal.textarea?.addEventListener("keydown", xtermKeyDown);
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(xtermKeyDown).toHaveBeenCalledOnce();
    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("keeps Shift+Tab in the terminal without blocking xterm input", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const xtermKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === "Tab" && event.shiftKey) terminal.emitData("\x1b[Z");
    });
    terminal.textarea?.addEventListener("keydown", xtermKeyDown);
    const keyDown = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    terminal.textarea?.dispatchEvent(keyDown);

    expect(keyDown.defaultPrevented).toBe(true);
    expect(xtermKeyDown).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("forwards committed third-party IME text when its keydown produced no xterm data", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Process",
        code: "KeyD",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "d",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("d");
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("waits for xterm's deferred keyCode 229 textarea diff before falling back", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const textarea = terminal.textarea!;
    textarea.addEventListener("keydown", (event) => {
      if (event.keyCode !== 229) return;
      const oldValue = textarea.value;
      window.setTimeout(() => {
        const diff = textarea.value.slice(oldValue.length);
        if (diff) terminal.emitData(diff);
      }, 0);
    });
    vi.useFakeTimers();

    const keyDown = new KeyboardEvent("keydown", {
      key: "Process",
      code: "KeyD",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyDown, "keyCode", { value: 229 });
    textarea.dispatchEvent(keyDown);
    textarea.value = "d";
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "d",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("forwards third-party IME commits in screen-reader mode", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.options.screenReaderMode = true;
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Process",
        code: "KeyD",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "d",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("cancels a queued IME fallback when the terminal is disposed", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Process",
        code: "KeyD",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "d",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    disposeHandle("renderer-test");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).not.toHaveBeenCalled();
    expect(rendererMocks.apiMock.sendInput).not.toHaveBeenCalled();
  });

  it("does not duplicate input that xterm already forwarded from keydown", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(getState().runtime["renderer-test"]?.attached).toBe(true),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.textarea?.addEventListener("keydown", () =>
      terminal.emitData("a"),
    );

    terminal.textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      }),
    );
    terminal.textarea?.dispatchEvent(
      new InputEvent("input", {
        data: "a",
        inputType: "insertText",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce(),
    );
  });

  it("shows the live log-rotation notice only once per run", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];

    for (let generation = 0; generation < 3; generation += 1) {
      channel.onmessage?.({
        t: "output",
        data: "QQ==",
        offset: 0,
        cursor: { runId: "run_rotation", runOrdinal: 1, generation, offset: 0 },
      });
    }

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const notices = terminal.write.mock.calls.filter(
      ([value]) =>
        typeof value === "string" &&
        value.includes("Older terminal output has rotated"),
    );
    expect(notices).toHaveLength(1);

    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: {
        runId: "run_after_restart",
        runOrdinal: 2,
        generation: 0,
        offset: 0,
      },
    });
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: {
        runId: "run_after_restart",
        runOrdinal: 2,
        generation: 1,
        offset: 0,
      },
    });

    const noticesAfterRestart = terminal.write.mock.calls.filter(
      ([value]) =>
        typeof value === "string" &&
        value.includes("Older terminal output has rotated"),
    );
    expect(noticesAfterRestart).toHaveLength(2);
  });

  it("restores the user's reading row when a write snaps the viewport to the bottom", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    // The user is reading scrollback, not following the tail.
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 200;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    expect(contentWrite).toBeDefined();
    // The renderer snaps the viewport to the bottom while the write parses.
    terminal.buffer.active.baseY = 502;
    terminal.buffer.active.viewportY = 502;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(200);
    expect(terminal.buffer.active.viewportY).toBe(200);
  });

  it("restores the user's reading row when a write drops the viewport to the top", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 200;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    terminal.buffer.active.viewportY = 0;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(200);
  });

  it("lets output keep following the tail while the user is at the bottom", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 500;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    terminal.buffer.active.baseY = 502;
    terminal.buffer.active.viewportY = 502;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("restores tail following when a dynamic write drops a bottomed viewport to the top", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 500;
    const nativeViewport = document.createElement("div");
    nativeViewport.className = "xterm-viewport";
    Object.defineProperties(nativeViewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 10_000 },
    });
    nativeViewport.scrollTop = 0;
    terminal.element?.appendChild(nativeViewport);

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    terminal.buffer.active.baseY = 502;
    terminal.buffer.active.viewportY = 0;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    invokeWriteCallback(
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1],
    );
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.viewportY).toBe(502);
    expect(nativeViewport.scrollTop).toBe(9_500);
  });

  it("coalesces tail repair until a burst of queued history writes has drained", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 500;

    for (let offset = 0; offset < 3; offset += 1) {
      rendererMocks.channels[0].onmessage?.({
        t: "output",
        data: "QQ==",
        offset,
        cursor: {
          runId: "run_1",
          runOrdinal: 1,
          generation: 0,
          offset,
        },
      });
    }
    const contentWrites = terminal.write.mock.calls.filter(
      ([data, callback]) => data instanceof Uint8Array && typeof callback === "function",
    );
    expect(contentWrites).toHaveLength(3);

    for (const contentWrite of contentWrites) {
      // Reproduce the renderer fault from the report: every queued parser turn
      // exposes the oldest row before its callback runs.
      terminal.buffer.active.baseY += 2;
      terminal.buffer.active.viewportY = 0;
      invokeWriteCallback(contentWrite);
    }

    // Repairing each parser turn makes the whole retained history visibly race
    // past. The repair must wait behind the burst and run only once.
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    const tailRepair =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    expect(tailRepair?.[0]).toBe("");
    invokeWriteCallback(tailRepair);
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("cancels a queued tail repair when the user wheels before the burst drains", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 500;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    terminal.buffer.active.baseY = 502;
    terminal.buffer.active.viewportY = 0;
    invokeWriteCallback(contentWrite);
    const tailRepair =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    invokeWriteCallback(tailRepair);

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("does not restore tail following over a wheel gesture during the write", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 500;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    terminal.buffer.active.baseY = 502;
    terminal.buffer.active.viewportY = 0;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(0);
  });

  it("does not fight xterm's trim compensation that lowers viewportY", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 200;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    // Scrollback trimmed lines above the reading row; xterm lowered viewportY
    // to keep the same text on screen. That is not a snap — leave it alone.
    terminal.buffer.active.viewportY = 198;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("does not yank the viewport back when the user scrolls down mid-write", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 200;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    // The user's own wheel gesture moved the viewport down while the write
    // parsed. That is deliberate movement, not a renderer snap: with output
    // streaming there is always a pending write callback, so reverting it
    // here would ratchet every downward scroll back toward the top.
    terminal.buffer.active.viewportY = 260;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(260);
  });

  it("lets the user escape the top of the scrollback while output streams", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    // The viewport landed on the oldest row (reflow quirk or scrollback
    // trim). The next write captures readingRow=0; when the user then
    // scrolls down, the callback must not drag them back to the top.
    terminal.buffer.active.baseY = 500;
    terminal.buffer.active.viewportY = 0;

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrite = terminal.write.mock.calls.find(
      ([data, callback]) => data !== "" && typeof callback === "function",
    );
    terminal.buffer.active.viewportY = 40;
    invokeWriteCallback(contentWrite);

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(40);
  });

  it("covers a reattach even when the previous attachment had completed replay", () => {
    setState({
      runtime: {
        "renderer-test": { ...emptyRuntime(), replayDone: true },
      },
    });

    mountTerminal("renderer-test", document.createElement("div"));

    expect(getState().runtime["renderer-test"]?.attaching).toBe(true);
    expect(getState().runtime["renderer-test"]?.replayDone).toBe(false);
  });

  it("marks replay complete only after its parser boundary, without waiting for later live output", async () => {
    setState({ runtime: {} });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    channel.onmessage?.({
      t: "replay_done",
      offset: 1,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    });

    expect(getState().runtime["renderer-test"]?.replayDone).toBe(false);
    const replayBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];

    channel.onmessage?.({
      t: "output",
      data: "Qg==",
      offset: 1,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    });
    invokeWriteCallback(replayBoundary);

    expect(getState().runtime["renderer-test"]?.replayDone).toBe(true);
    expect(isTerminalPreviewRendered("renderer-test")).toBe(false);
    terminal.emitRender();
    expect(isTerminalPreviewRendered("renderer-test")).toBe(true);
    const liveWrite = terminal.write.mock.calls.find(
      ([data]) =>
        data instanceof Uint8Array && new TextDecoder().decode(data) === "B",
    );
    expect(liveWrite).toBeDefined();
    // Its callback intentionally remains pending: replay completion is scoped
    // to the transport marker, not to later live traffic.
  });

  it("keeps a restarted Pi covered until its startup-ready OSC drains through xterm", async () => {
    const project = getState().projects[0]!;
    setState({
      projects: [
        {
          ...project,
          sessions: project.sessions.map((session) => ({
            ...session,
            adapter: "pi",
          })),
        },
      ],
      runtime: {},
    });
    resetForRestart("renderer-test");
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    channel.onmessage?.({
      t: "replay_done",
      offset: 0,
      cursor: null,
    });
    const replayBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(replayBoundary);

    expect(getState().runtime["renderer-test"]?.replayDone).toBe(true);
    expect(getState().runtime["renderer-test"]?.startupPending).toBe(true);

    expect(terminal.emitOsc(6973, "startup-ready")).toBe(true);
    const startupBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(startupBoundary);

    expect(getState().runtime["renderer-test"]?.startupPending).toBe(false);
  });

  it("drops replay completion from a stale attach generation", async () => {
    setState({ runtime: {} });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    channel.onmessage?.({
      t: "replay_done",
      offset: 0,
      cursor: null,
    });
    const staleBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];

    resetForRestart("renderer-test");
    invokeWriteCallback(staleBoundary);

    expect(getState().runtime["renderer-test"]?.replayDone).toBe(false);
  });

  it("coalesces a DEC 2026 redraw split across Channel output frames", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b[?2026h\x1b[2Jpartial redraw";
    const second = "\r\ninput box\r\nstatus\x1b[?2026l";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_sync", runOrdinal: 1, generation: 0, offset: 0 },
    });

    // Neither partial content nor its rendered-cursor drain may overtake the
    // still-open application frame.
    expect(terminal.write).not.toHaveBeenCalled();
    expect(rendererMocks.apiMock.markSessionLogRendered).not.toHaveBeenCalled();

    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: {
        runId: "run_sync",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });

    expect(terminal.write.mock.calls.map(([data]) => data === "" ? "drain" : "content"))
      .toEqual(["content", "drain"]);
    const contentWrite = terminal.write.mock.calls[0];
    expect(new TextDecoder().decode(contentWrite?.[0] as Uint8Array)).toBe(
      first + second,
    );
    invokeWriteCallback(contentWrite);
    expect(rendererMocks.apiMock.markSessionLogRendered).not.toHaveBeenCalled();
    invokeWriteCallback(terminal.write.mock.calls[1]);
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenCalledWith(
        "renderer-test",
        1,
        {
          runId: "run_sync",
          runOrdinal: 1,
          generation: 0,
          offset: first.length,
        },
      ),
    );
  });

  it("keeps a plain prefix ahead of a DEC 2026 redraw split across Channel frames", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const prefix = "plain prefix";
    const first = `${prefix}\x1b[?2026hpartial`;
    const second = " redraw\x1b[?2026l";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_prefix", runOrdinal: 1, generation: 0, offset: 0 },
    });

    expect(terminal.write).toHaveBeenCalledOnce();
    expect(
      new TextDecoder().decode(terminal.write.mock.calls[0]?.[0] as Uint8Array),
    ).toBe(prefix);

    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: {
        runId: "run_prefix",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });

    const rendered = terminal.write.mock.calls
      .filter(([data]) => data instanceof Uint8Array)
      .map(([data]) => new TextDecoder().decode(data as Uint8Array));
    expect(rendered).toEqual([
      prefix,
      "\x1b[?2026hpartial redraw\x1b[?2026l",
    ]);
  });

  it("recognizes both DEC 2026 markers at every Channel chunk split", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const begin = "\x1b[?2026h";
    const end = "\x1b[?2026l";
    const expected: string[] = [];
    let offset = 0;
    const send = (data: string) => {
      channel.onmessage?.({
        t: "output",
        data: btoa(data),
        offset,
        cursor: {
          runId: "run_splits",
          runOrdinal: 1,
          generation: 0,
          offset,
        },
      });
      offset += data.length;
    };

    for (let split = 1; split < begin.length; split += 1) {
      const block = `${begin}begin-${split}${end}`;
      send(begin.slice(0, split));
      send(begin.slice(split) + `begin-${split}${end}`);
      expected.push(block);
    }
    for (let split = 1; split < end.length; split += 1) {
      const block = `${begin}end-${split}${end}`;
      send(`${begin}end-${split}${end.slice(0, split)}`);
      send(end.slice(split));
      expected.push(block);
    }

    const rendered = terminal.write.mock.calls
      .filter(([data]) => data instanceof Uint8Array)
      .map(([data]) => new TextDecoder().decode(data as Uint8Array));
    expect(rendered).toEqual(expected);
  });

  it("keeps ordinary bytes immediate and ordered around multiple DEC 2026 blocks", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const begin = "\x1b[?2026h";
    const end = "\x1b[?2026l";
    const output = `prefix${begin}first${end}middle${begin}second${end}suffix`;

    channel.onmessage?.({
      t: "output",
      data: btoa(output),
      offset: 0,
      cursor: { runId: "run_order", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const rendered = terminal.write.mock.calls
      .filter(([data]) => data instanceof Uint8Array)
      .map(([data]) => new TextDecoder().decode(data as Uint8Array));
    expect(rendered).toEqual([
      "prefix",
      `${begin}first${end}`,
      "middle",
      `${begin}second${end}`,
      "suffix",
    ]);
  });

  it("holds replay completion behind an open DEC 2026 frame", async () => {
    setState({ runtime: {} });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b[?2026hpartial";
    const second = "complete\x1b[?2026l";
    const replayCursor = {
      runId: "run_replay_sync",
      runOrdinal: 1,
      generation: 0,
      offset: first.length,
    };

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { ...replayCursor, offset: 0 },
    });
    channel.onmessage?.({
      t: "replay_done",
      offset: first.length,
      cursor: replayCursor,
    });

    expect(terminal.write).not.toHaveBeenCalled();
    expect(getState().runtime["renderer-test"]?.replayDone).toBe(false);

    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: replayCursor,
    });
    const callsAtClose = [...terminal.write.mock.calls];
    expect(callsAtClose.map(([data]) => data === "" ? "drain" : "content"))
      .toEqual(["content", "drain", "drain"]);
    invokeWriteCallback(callsAtClose[0]);
    invokeWriteCallback(callsAtClose[1]);
    expect(getState().runtime["renderer-test"]?.replayDone).toBe(false);
    invokeWriteCallback(callsAtClose[2]);
    expect(getState().runtime["renderer-test"]?.replayDone).toBe(true);
  });

  it("starts the frame timeout after a split DEC 2026 begin marker completes", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    vi.useFakeTimers();
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b";
    const second = "[?2026hpartial";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_delayed", runOrdinal: 1, generation: 0, offset: 0 },
    });
    await vi.advanceTimersByTimeAsync(900);
    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: {
        runId: "run_delayed",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(terminal.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const contentWrite = terminal.write.mock.calls.find(
      ([data]) => data instanceof Uint8Array,
    );
    expect(new TextDecoder().decode(contentWrite?.[0] as Uint8Array)).toBe(
      first + second,
    );
  });

  it("still arms an open-frame timeout when flushing earlier output throws", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    vi.useFakeTimers();
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    terminal.write.mockImplementationOnce(() => {
      throw new Error("output sink failed");
    });
    const prefix = "plain prefix";
    const openFrame = "\x1b[?2026hpartial";

    expect(() =>
      channel.onmessage?.({
        t: "output",
        data: btoa(prefix + openFrame),
        offset: 0,
        cursor: {
          runId: "run_throwing_sink",
          runOrdinal: 1,
          generation: 0,
          offset: 0,
        },
      }),
    ).toThrow("output sink failed");

    await vi.advanceTimersByTimeAsync(1_000);
    const contentWrites = terminal.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(contentWrites).toHaveLength(2);
    expect(
      new TextDecoder().decode(contentWrites[1]?.[0] as Uint8Array),
    ).toBe(openFrame);
  });

  it("releases an unterminated DEC 2026 frame after the safety timeout", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    vi.useFakeTimers();
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b[?2026hunterminated";
    const end = "\x1b[?2026l";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_timeout", runOrdinal: 1, generation: 0, offset: 0 },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(terminal.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    let contentWrites = terminal.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(contentWrites).toHaveLength(1);
    expect(new TextDecoder().decode(contentWrites[0]?.[0] as Uint8Array)).toBe(
      first,
    );

    channel.onmessage?.({
      t: "output",
      data: btoa(end),
      offset: first.length,
      cursor: {
        runId: "run_timeout",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });
    contentWrites = terminal.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(contentWrites).toHaveLength(2);
    expect(new TextDecoder().decode(contentWrites[1]?.[0] as Uint8Array)).toBe(
      end,
    );
  });

  it("bounds an unterminated DEC 2026 frame without dropping its bytes", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const output = "\x1b[?2026h" + "x".repeat(1024 * 1024);

    channel.onmessage?.({
      t: "output",
      data: btoa(output),
      offset: 0,
      cursor: { runId: "run_bound", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const contentWrites = terminal.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(contentWrites).toHaveLength(1);
    expect(
      new TextDecoder().decode(contentWrites[0]?.[0] as Uint8Array),
    ).toBe(output);
  });

  it("releases a false DEC 2026 begin prefix at its original Channel boundary", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b[?20";
    const second = "xplain";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_false", runOrdinal: 1, generation: 0, offset: 0 },
    });
    expect(terminal.write).not.toHaveBeenCalled();
    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: {
        runId: "run_false",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });

    expect(terminal.write.mock.calls.map(([data]) => data === "" ? "drain" : "content"))
      .toEqual(["content", "drain", "content"]);
    expect(
      terminal.write.mock.calls
        .filter(([data]) => data instanceof Uint8Array)
        .map(([data]) => new TextDecoder().decode(data as Uint8Array)),
    ).toEqual([first, second]);
  });

  it("queues local terminal writes behind an open DEC 2026 frame", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const first = "\x1b[?2026hpartial";
    const second = "complete\x1b[?2026l";

    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 0,
      cursor: { runId: "run_local", runOrdinal: 1, generation: 0, offset: 0 },
    });
    writeMarker("renderer-test", "queued local write");
    expect(terminal.write).not.toHaveBeenCalled();
    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: first.length,
      cursor: {
        runId: "run_local",
        runOrdinal: 1,
        generation: 0,
        offset: first.length,
      },
    });

    expect(terminal.write.mock.calls.map(([data]) =>
      data === "" ? "drain" : typeof data === "string" ? "local" : "content"
    )).toEqual(["content", "drain", "local"]);
    expect(String(terminal.write.mock.calls[2]?.[0])).toContain(
      "queued local write",
    );
  });

  it("discards deferred DEC 2026 output on a restart generation reset", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    vi.useFakeTimers();
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.write.mockClear();
    const stale = "\x1b[?2026hstale restart frame";
    channel.onmessage?.({
      t: "output",
      data: btoa(stale),
      offset: 0,
      cursor: { runId: "run_reset", runOrdinal: 1, generation: 0, offset: 0 },
    });

    resetForRestart("renderer-test");
    await vi.advanceTimersByTimeAsync(1_001);

    expect(
      terminal.write.mock.calls.some(
        ([data]) =>
          data instanceof Uint8Array &&
          new TextDecoder().decode(data).includes("stale restart frame"),
      ),
    ).toBe(false);
    expect(rendererMocks.apiMock.markSessionLogRendered).not.toHaveBeenCalled();
  });

  it("cancels deferred DEC 2026 output when its terminal handle is disposed", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    vi.useFakeTimers();
    const oldChannel = rendererMocks.channels[0];
    const oldTerminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    oldTerminal.write.mockClear();
    const stale = "\x1b[?2026hstale frame";
    oldChannel.onmessage?.({
      t: "output",
      data: btoa(stale),
      offset: 0,
      cursor: { runId: "run_stale", runOrdinal: 1, generation: 0, offset: 0 },
    });

    disposeHandle("renderer-test");
    mountTerminal("renderer-test", document.createElement("div"));
    const newTerminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    await vi.advanceTimersByTimeAsync(1_001);

    expect(oldTerminal.write).not.toHaveBeenCalled();
    expect(
      newTerminal.write.mock.calls.some(
        ([data]) =>
          data instanceof Uint8Array &&
          new TextDecoder().decode(data).includes("stale frame"),
      ),
    ).toBe(false);
  });

  it("acknowledges output only after xterm drains the renderer write queue", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 10,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 10 },
    });

    expect(rendererMocks.apiMock.markSessionLogRendered).not.toHaveBeenCalled();
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    // The rendered-cursor acknowledgement rides the empty sentinel write that
    // is queued after the content write; content writes carry their own
    // viewport-restore callback now.
    const callback = terminal.write.mock.calls
      .filter((call) => call[0] === "")
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

  it("runs each rendered-cursor drain once and queues later output behind a new boundary", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const firstBoundary = terminal.write.mock.calls.find(
      ([data, callback]) => data === "" && typeof callback === "function",
    );
    channel.onmessage?.({
      t: "output",
      data: "Qg==",
      offset: 1,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    });

    invokeWriteCallback(firstBoundary);
    invokeWriteCallback(firstBoundary);
    expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenCalledTimes(1);
    expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenLastCalledWith(
      "renderer-test",
      1,
      { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    );

    const secondBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    expect(secondBoundary).not.toBe(firstBoundary);
    invokeWriteCallback(secondBoundary);
    expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenCalledTimes(2);
    expect(rendererMocks.apiMock.markSessionLogRendered).toHaveBeenLastCalledWith(
      "renderer-test",
      1,
      { runId: "run_1", runOrdinal: 1, generation: 0, offset: 2 },
    );
  });

  it("restores Pi's fullscreen mouse protocol before replaying a bounded cold-attach tail", () => {
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "pi",
          agentSessionId: "pi-session",
        })),
      })),
    });

    mountTerminal("renderer-test", document.createElement("div"));

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.write).toHaveBeenCalledWith(
      "\x1b[?1049h\x1b[?1002h\x1b[?1006h",
      undefined,
    );
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledWith(
      "renderer-test",
      expect.any(Number),
      expect.anything(),
      null,
    );
  });

  it("repairs the omitted SGR mode when restoring a fullscreen Pi v1 snapshot", () => {
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "pi",
          agentSessionId: "pi-session",
        })),
      })),
    });
    const legacyKey = "agentport:terminal-snapshot:v1:renderer-test";
    const currentKey = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        cursor: {
          runId: "run_1",
          runOrdinal: 1,
          generation: 0,
          offset: 1,
        },
        cols: 80,
        rows: 24,
        content: "\x1b[?1049hserialized-screen",
      }),
    );

    mountTerminal("renderer-test", document.createElement("div"));

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.write).toHaveBeenCalledWith(
      "\x1b[?1049hserialized-screen\x1b[?1002h\x1b[?1006h",
      expect.any(Function),
    );
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledWith(
      "renderer-test",
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({ offset: 1 }),
    );
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(currentKey) ?? "null")).toMatchObject({
      version: 2,
      mouseEncoding: "default",
      content: "\x1b[?1049hserialized-screen",
    });
    localStorage.removeItem(currentKey);
  });

  it("repairs a fullscreen Pi v2 snapshot captured without mouse tracking", () => {
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "pi",
          agentSessionId: "pi-session",
        })),
      })),
    });
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        cursor: {
          runId: "run_1",
          runOrdinal: 1,
          generation: 0,
          offset: 1,
        },
        cols: 80,
        rows: 24,
        content: "\x1b[?1049hserialized-screen",
        mouseEncoding: "sgr",
      }),
    );

    mountTerminal("renderer-test", document.createElement("div"));

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.write).toHaveBeenCalledWith(
      "\x1b[?1049hserialized-screen\x1b[?1002h\x1b[?1006h",
      expect.any(Function),
    );
    localStorage.removeItem(key);
  });

  it("preserves mouse tracking serialized by a fullscreen Pi snapshot", () => {
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          adapter: "pi",
          agentSessionId: "pi-session",
        })),
      })),
    });
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        cursor: {
          runId: "run_1",
          runOrdinal: 1,
          generation: 0,
          offset: 1,
        },
        cols: 80,
        rows: 24,
        content: "\x1b[?1049hserialized-screen\x1b[?1003h",
        mouseEncoding: "sgr",
      }),
    );

    mountTerminal("renderer-test", document.createElement("div"));

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.write).toHaveBeenCalledWith(
      "\x1b[?1049hserialized-screen\x1b[?1003h\x1b[?1006h",
      expect.any(Function),
    );
    expect(terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining("\x1b[?1003h\x1b[?1002h"),
      undefined,
    );
    localStorage.removeItem(key);
  });

  it("restores the SGR mouse encoding that xterm's serializer omits", () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        cursor: {
          runId: "run_1",
          runOrdinal: 1,
          generation: 0,
          offset: 1,
        },
        cols: 80,
        rows: 24,
        content: "serialized-screen",
        mouseEncoding: "sgr",
      }),
    );

    expect(hasWarmTerminalPreview("renderer-test")).toBe(true);
    mountTerminal("renderer-test", document.createElement("div"));

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.write).toHaveBeenCalledWith(
      "serialized-screen\x1b[?1006h",
      expect.any(Function),
    );
    expect(rendererMocks.apiMock.attachSession).toHaveBeenCalledWith(
      "renderer-test",
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({ offset: 1 }),
    );
    localStorage.removeItem(key);
  });

  it("persists a parser-drained checkpoint before releasing the sole renderer", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.removeItem(key);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const handle = getHandle("renderer-test")!;
    handle.logCursor = {
      runId: "run_release",
      runOrdinal: 1,
      generation: 0,
      offset: 42,
    };
    handle.displayReady = true;
    handle.attached = true;
    handle.attachmentId = 1;
    vi.mocked(handle.serialize.serialize).mockReturnValue("release checkpoint");

    const released = releaseTerminal("renderer-test");
    const releaseBoundary = terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(releaseBoundary);
    await released;

    const snapshot = JSON.parse(localStorage.getItem(key) ?? "null") as {
      content?: string;
      cursor?: { offset?: number };
    } | null;
    expect(snapshot?.content).toBe("release checkpoint");
    expect(snapshot?.cursor?.offset).toBe(42);
    localStorage.removeItem(key);
  });

  it("flushes an open synchronized-output frame before release snapshots its cursor", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.removeItem(key);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const handle = getHandle("renderer-test")!;
    const frame = "\x1b[?2026hpartial redraw";
    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: btoa(frame),
      offset: 0,
      cursor: {
        runId: "run_release_sync",
        runOrdinal: 1,
        generation: 0,
        offset: 0,
      },
    });
    handle.displayReady = true;
    handle.attached = true;
    handle.attachmentId = 1;
    vi.mocked(handle.serialize.serialize).mockReturnValue("release checkpoint");

    const released = releaseTerminal("renderer-test");
    const contentWrite = terminal.write.mock.calls.find(
      ([data]) => data instanceof Uint8Array,
    );
    expect(new TextDecoder().decode(contentWrite?.[0] as Uint8Array)).toBe(frame);
    invokeWriteCallback(contentWrite);
    const releaseBoundary = terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(releaseBoundary);
    await released;

    const snapshot = JSON.parse(localStorage.getItem(key) ?? "null") as {
      cursor?: { offset?: number };
    } | null;
    expect(snapshot?.cursor?.offset).toBe(frame.length);
    localStorage.removeItem(key);
  });

  it("reserializes cursorless transient output before release", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    const snapshot = JSON.stringify({
      version: 2,
      cursor: {
        runId: "run_transient",
        runOrdinal: 1,
        generation: 0,
        offset: 42,
      },
      cols: 80,
      rows: 24,
      content: "cached screen",
      mouseEncoding: "default",
    });
    localStorage.setItem(key, snapshot);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const handle = getHandle("renderer-test")!;
    invokeWriteCallback(terminal.write.mock.calls[0]);
    terminal.emitRender();
    rendererMocks.channels[0].onmessage?.({
      t: "transient_output",
      data: btoa("cursorless update"),
    });
    handle.attached = true;
    handle.attachmentId = 1;
    vi.mocked(handle.serialize.serialize).mockReturnValue("updated screen");

    const released = releaseTerminal("renderer-test");
    const releaseBoundary = terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(releaseBoundary);
    await released;

    expect(handle.serialize.serialize).toHaveBeenCalledWith({ scrollback: 1000 });
    expect(JSON.parse(localStorage.getItem(key) ?? "null").content).toBe(
      "updated screen",
    );
    localStorage.removeItem(key);
  });

  it("bounds parsed snapshot caching to the renderer retention limit", () => {
    const baseSession = getState().projects[0].sessions[0];
    const makeSnapshot = (runId: string) => JSON.stringify({
      version: 2,
      cursor: { runId, runOrdinal: 1, generation: 0, offset: 1 },
      cols: 80,
      rows: 24,
      content: `screen ${runId}`,
      mouseEncoding: "default",
    });
    const ids = ["snapshot-cache-a", "snapshot-cache-b"];
    setState({
      projects: [{
        ...getState().projects[0],
        sessions: ids.map((id) => ({ ...baseSession, id })),
      }],
    });
    ids.forEach((id) =>
      localStorage.setItem(
        `agentport:terminal-snapshot:v2:${id}`,
        makeSnapshot(id),
      ),
    );
    const parse = vi.spyOn(JSON, "parse");

    expect(hasWarmTerminalPreview(ids[0])).toBe(true);
    expect(hasWarmTerminalPreview(ids[1])).toBe(true);
    expect(hasWarmTerminalPreview(ids[0])).toBe(true);

    expect(parse).toHaveBeenCalledTimes(3);
    parse.mockRestore();
    ids.forEach((id) =>
      localStorage.removeItem(`agentport:terminal-snapshot:v2:${id}`),
    );
  });

  it("clears a stale warm snapshot before recovering an output gap", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      cursor: {
        runId: "run_gap",
        runOrdinal: 1,
        generation: 0,
        offset: 1,
      },
      cols: 80,
      rows: 24,
      content: "old screen",
      mouseEncoding: "default",
    }));
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    invokeWriteCallback(terminal.write.mock.calls[0]);
    expect(hasWarmTerminalPreview("renderer-test")).toBe(true);

    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 10,
      cursor: {
        runId: "run_gap",
        runOrdinal: 1,
        generation: 0,
        offset: 10,
      },
    });

    expect(localStorage.getItem(key)).toBeNull();
    expect(hasWarmTerminalPreview("renderer-test")).toBe(false);
  });

  it("records the active SGR mouse encoding beside a terminal snapshot", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.removeItem(key);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.emitCsi({ prefix: "?", final: "h" }, [1006]);
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const renderedBoundary = terminal.write.mock.calls.find(
      ([data, callback]) => data === "" && typeof callback === "function",
    );

    vi.useFakeTimers();
    invokeWriteCallback(renderedBoundary);
    vi.advanceTimersByTime(1000);
    const snapshotBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    invokeWriteCallback(snapshotBoundary);

    const snapshot = JSON.parse(localStorage.getItem(key) ?? "null") as {
      mouseEncoding?: string;
    } | null;
    expect(snapshot?.mouseEncoding).toBe("sgr");
    localStorage.removeItem(key);
  });

  it("serializes a snapshot at the cursor owned by its parser boundary", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.removeItem(key);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const renderedBoundary = terminal.write.mock.calls.find(
      ([data, callback]) => data === "" && typeof callback === "function",
    );

    vi.useFakeTimers();
    invokeWriteCallback(renderedBoundary);
    vi.advanceTimersByTime(1000);
    const snapshotBoundary =
      terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
    channel.onmessage?.({
      t: "output",
      data: "Qg==",
      offset: 1,
      cursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 1 },
    });
    invokeWriteCallback(snapshotBoundary);

    const handle = getHandle("renderer-test")!;
    expect(handle.serialize.serialize).toHaveBeenCalledWith({
      scrollback: 1000,
    });
    const snapshot = JSON.parse(localStorage.getItem(key) ?? "null") as {
      cursor?: { offset?: number };
    } | null;
    expect(snapshot?.cursor?.offset).toBe(1);
    localStorage.removeItem(key);
  });

  it("does not snapshot a cursor whose drain was promoted past a DEC 2026 frame", async () => {
    const key = "agentport:terminal-snapshot:v2:renderer-test";
    localStorage.removeItem(key);
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const handle = getHandle("renderer-test")!;
    vi.mocked(handle.serialize.serialize).mockClear();

    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_snapshot_sync", runOrdinal: 1, generation: 0, offset: 0 },
    });
    const initialContent = terminal.write.mock.calls.find(
      ([data]) => data instanceof Uint8Array,
    );
    const initialRenderedBoundary = terminal.write.mock.calls.find(
      ([data, callback]) => data === "" && typeof callback === "function",
    );
    invokeWriteCallback(initialContent);
    vi.useFakeTimers();
    invokeWriteCallback(initialRenderedBoundary);
    vi.advanceTimersByTime(500);

    const first = "\x1b[?2026hpartial";
    const second = "complete\x1b[?2026l";
    channel.onmessage?.({
      t: "output",
      data: btoa(first),
      offset: 1,
      cursor: {
        runId: "run_snapshot_sync",
        runOrdinal: 1,
        generation: 0,
        offset: 1,
      },
    });
    vi.advanceTimersByTime(500);
    const callsBeforeClose = terminal.write.mock.calls.length;
    channel.onmessage?.({
      t: "output",
      data: btoa(second),
      offset: 1 + first.length,
      cursor: {
        runId: "run_snapshot_sync",
        runOrdinal: 1,
        generation: 0,
        offset: 1 + first.length,
      },
    });

    const closeCalls = terminal.write.mock.calls.slice(callsBeforeClose);
    expect(closeCalls.map(([data]) => data === "" ? "drain" : "content"))
      .toEqual(["content", "drain", "drain"]);
    invokeWriteCallback(closeCalls[0]);
    invokeWriteCallback(closeCalls[1]);
    invokeWriteCallback(closeCalls[2]);

    expect(handle.serialize.serialize).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBeNull();
    localStorage.removeItem(key);
  });

  it("queues replaying synchronized TUI output by Host frame instead of redraw frame", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const synchronizedRedraw =
      "\x1b[?2026h" + "W".repeat(48) + "\x1b[?2026l";
    expect(synchronizedRedraw.length).toBe(64);
    const hostFrame = synchronizedRedraw.repeat(1024);
    const data = btoa(hostFrame);
    const timeoutSpy = vi.spyOn(window, "setTimeout");

    for (let index = 0; index < 64; index += 1) {
      const offset = index * hostFrame.length;
      channel.onmessage?.({
        t: "output",
        data,
        offset,
        cursor: {
          runId: "run_synchronized_replay",
          runOrdinal: 1,
          generation: 0,
          offset,
        },
      });
    }

    const timeoutCalls = timeoutSpy.mock.calls.length;
    timeoutSpy.mockRestore();
    const contentWrites = terminal.write.mock.calls.filter(
      ([written, callback]) =>
        written instanceof Uint8Array && typeof callback === "function",
    );
    expect(timeoutCalls).toBe(0);
    expect(contentWrites).toHaveLength(64);
    expect(
      contentWrites.every(
        ([written]) =>
          new TextDecoder().decode(written as Uint8Array) === hostFrame,
      ),
    ).toBe(true);
    expect(getHandle("renderer-test")?.pendingOutputBytes).toBe(4 * 1024 * 1024);
  });

  it("keeps measured parser pressure below the backpressure threshold when 4 MiB drains frame-by-frame", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const frameBytes = 64 * 1024;
    const frame = btoa("A".repeat(frameBytes));

    for (let index = 0; index < 64; index += 1) {
      const offset = index * frameBytes;
      channel.onmessage?.({
        t: "output",
        data: frame,
        offset,
        cursor: {
          runId: "run_pressure",
          runOrdinal: 1,
          generation: 0,
          offset,
        },
      });
      const contentWrite = terminal.write.mock.calls
        .slice()
        .reverse()
        .find(
          ([data, callback]) =>
            data instanceof Uint8Array && typeof callback === "function",
        );
      invokeWriteCallback(contentWrite);
    }

    const handle = getHandle("renderer-test")!;
    expect(handle.pendingOutputBytes).toBe(0);
    expect(handle.peakPendingOutputBytes).toBe(frameBytes);
    expect(handle.peakPendingOutputBytes).toBeLessThan(500 * 1024);
    expect(handle.lastOutputParseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("writes raw PTY bytes without translating or rewriting them", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const raw = "原始 Git/CLI 输出: checkout Session\r\n";
    const bytes = new TextEncoder().encode(raw);
    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: btoa(String.fromCharCode(...bytes)),
      offset: 0,
      cursor: { runId: "run_raw", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const written = terminal.write.mock.calls
      .map(([value]) =>
        value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : String(value),
      )
      .join("");
    expect(written).toContain(raw);
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
    await vi.waitFor(() =>
      expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled(),
    );
    const channel = rendererMocks.channels[0];
    channel.onmessage?.({
      t: "replay_done",
      offset: 0,
      cursor: null,
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

    const terminal =
      rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const rendered = terminal.write.mock.calls
      .map(([value]) =>
        value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : String(value),
      )
      .join("");
    expect(rendered).not.toContain("No project session found");
  });
});
