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
    copyText: vi.fn().mockResolvedValue(true),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    readRecoveryLogContext: vi.fn(),
    resizePty: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
  };
  const config = { canvasShouldFail: false, openShouldFail: false };
  class FakeTerminal {
    static strings = { promptLabel: "", tooMuchOutput: "" };
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private readonly bellListeners = new Set<() => void>();
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
        callback: (links: Array<{ text: string; activate(e: unknown, t: string): void }> | undefined) => void,
      ) => void;
    }> = [];
    registerLinkProvider = vi.fn((provider: (typeof this.linkProviders)[number]) => {
      this.linkProviders.push(provider);
    });
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
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
    scrollToLine = vi.fn((line: number) => {
      this.buffer.active.viewportY = line;
    });
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
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: rendererMocks.FakeCanvasAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: rendererMocks.FakeFitAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: rendererMocks.FakeSearchAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: rendererMocks.FakeWebLinksAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: rendererMocks.FakeUnicode11Addon }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: rendererMocks.FakeSerializeAddon }));
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
  bytesToB64: vi.fn(() => "encoded-input"),
  copyText: rendererMocks.apiMock.copyText,
  errorText: (error: unknown) => String(error),
}));

import {
  applyTerminalLanguage,
  disposeHandle,
  fitHandle,
  getHandle,
  jumpToRecoveryOutput,
  mountTerminal,
} from "./terminals";
import { applyUiLanguage } from "./i18n";
import { getState, setState } from "./store";

describe("terminal renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    rendererMocks.config.canvasShouldFail = false;
    rendererMocks.config.openShouldFail = false;
    rendererMocks.channels.length = 0;
    rendererMocks.defaultClipboardCopies.length = 0;
    rendererMocks.offscreenCanvasDuringCanvasLoad.length = 0;
    rendererMocks.offscreenCanvasDuringOpen.length = 0;
    vi.clearAllMocks();
    setState({
      activeSessionId: "renderer-test",
      platform: null,
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

  it("uses Unicode 11 width tables for modern emoji and combining text", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    expect(terminal.unicode.activeVersion).toBe("11");
  });

  afterEach(() => {
    disposeHandle("renderer-test");
    vi.useRealTimers();
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

  it("preserves a user's scrollback position when fitting reflows the viewport", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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

  it.each([
    ["already at the top", "normal", 0, 1_000, "normal"],
    ["already at the bottom", "normal", 1_000, 1_000, "normal"],
    ["using the alternate buffer", "alternate", 400, 1_000, "alternate"],
    ["switching buffers during fit", "normal", 400, 1_000, "alternate"],
  ])("does not restore scrollback when %s", (_label, beforeType, viewport, base, afterType) => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    mountTerminal("renderer-test", container);
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
  });

  it("opens plain and OSC 8 web links through the native URL command", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const webLinksAddon = terminal.loadAddon.mock.calls
      .map(([addon]) => addon)
      .find((addon) => addon instanceof rendererMocks.FakeWebLinksAddon) as InstanceType<
        typeof rendererMocks.FakeWebLinksAddon
      >;

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
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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

  it("stops plain-path links before prose punctuation", () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    expect(collect(1).map((link) => link.text)).toEqual(["/Users/w/AI/AI心法.md"]);
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
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    expect(rendererMocks.offscreenCanvasDuringOpen[
      rendererMocks.offscreenCanvasDuringOpen.length - 1
    ]).toBeUndefined();
    expect(globalThis.OffscreenCanvas).toBe(offscreenCanvas);
    expect(rendererMocks.offscreenCanvasDuringCanvasLoad[
      rendererMocks.offscreenCanvasDuringCanvasLoad.length - 1
    ]).toBe(offscreenCanvas);
    expect(terminal.loadAddon).toHaveBeenCalledWith(expect.any(rendererMocks.FakeCanvasAddon));
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

    expect(() => mountTerminal("renderer-test", document.createElement("div")))
      .toThrow("Terminal open failed");
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

    expect(rendererMocks.offscreenCanvasDuringOpen[
      rendererMocks.offscreenCanvasDuringOpen.length - 1
    ]).toBe(offscreenCanvas);
    expect(globalThis.OffscreenCanvas).toBe(offscreenCanvas);
  });

  it("copies Unicode terminal selections through the async clipboard path", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const selection = '/wjskill-prompt-refiner "审查 @/Users/w/AD/Apollo/模块，给出结论"';
    terminal.selectionText = selection;

    terminal.element?.dispatchEvent(new Event("copy", {
      bubbles: true,
      cancelable: true,
    }));

    await vi.waitFor(() => {
      expect(rendererMocks.apiMock.copyText).toHaveBeenCalledWith(selection);
    });
    expect(rendererMocks.defaultClipboardCopies).toEqual([]);
  });

  it("forwards an image clipboard paste to the Agent image-paste shortcut", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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

  it("serializes independent terminal input events behind an in-flight send", async () => {
    let releaseFirst: (() => void) | undefined;
    rendererMocks.apiMock.sendInput.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    terminal.emitData("first");
    terminal.emitData("second");
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(1));

    releaseFirst?.();
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledTimes(2));
  });

  it("uses the DOM renderer only when CanvasAddon fails to initialize", () => {
    rendererMocks.config.canvasShouldFail = true;
    mountTerminal("renderer-test", document.createElement("div"));

    expect(getState().rendererMode).toBe("dom");
    expect(getState().rendererFallbackReason).toContain("Canvas unavailable");
  });

  it("updates xterm strings and existing terminal ARIA text when the language changes", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();

    expect(rendererMocks.FakeTerminal.strings.promptLabel).toBe("Terminal input");
    expect(rendererMocks.FakeTerminal.strings.tooMuchOutput).toContain("Some output was omitted");
    expect(terminal.textarea?.getAttribute("aria-label")).toBe("Terminal input");
  });

  it("re-localizes cached runtime errors and history notes on existing terminals", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
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
    expect(getState().runtime["renderer-test"]?.error).toBe("Session 状态无法保存：SQLITE_BUSY");
    expect(getState().runtime["renderer-test"]?.historyNote).toBe("输出已重新同步：generation changed");

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();

    expect(getState().runtime["renderer-test"]?.error)
      .toBe("Could not save the Session status: SQLITE_BUSY");
    expect(getState().runtime["renderer-test"]?.historyNote)
      .toBe("Output resynchronized: generation changed");
  });

  it("replaces a stale error envelope when an output gap starts a reconnect", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
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
    rendererMocks.apiMock.attachSession.mockReturnValueOnce(new Promise(() => undefined));
    channel.onmessage?.({
      t: "output",
      data: "Qg==",
      offset: 5,
      cursor: { runId: "run_gap", runOrdinal: 1, generation: 0, offset: 5 },
    });

    expect(getState().runtime["renderer-test"]?.errorMessage?.code).toBe("terminal_output_gap");
    expect(getState().runtime["renderer-test"]?.error).toBe("输出流出现间隙，正在重新同步");

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();
    expect(getState().runtime["renderer-test"]?.error)
      .toBe("The output stream has a gap; resynchronizing");
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

    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.error)
      .toBe("无法连接 Host：connection refused"));
    expect(getState().runtime["renderer-test"]?.errorMessage?.code)
      .toBe("host_connection_failed");

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();
    expect(getState().runtime["renderer-test"]?.error)
      .toBe("Could not connect to the Host: connection refused");
  });

  it("preserves a structured recovery rejection for later language changes", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    setState({
      projects: getState().projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => session.id === "renderer-test"
          ? { ...session, lifecycle: "exited" as const }
          : session),
      })),
    });
    rendererMocks.apiMock.readRecoveryLogContext.mockRejectedValueOnce({
      code: "recovery_log_changed",
      params: {},
      technicalDetail: "log generation changed",
      message: "读取期间输出日志发生变化，无法安全定位；请重试",
    });

    await expect(jumpToRecoveryOutput("renderer-test", {
      runId: "run_1",
      runOrdinal: 1,
      generation: 0,
      offset: 10,
    })).rejects.toBeTruthy();
    expect(getState().runtime["renderer-test"]?.historyMessage?.code).toBe("recovery_log_changed");
    expect(getState().runtime["renderer-test"]?.historyNote)
      .toBe("读取期间输出日志发生变化，无法安全定位；请重试。");

    await applyUiLanguage("en-US", { persistHint: false });
    applyTerminalLanguage();
    expect(getState().runtime["renderer-test"]?.historyNote)
      .toBe("The output log changed while it was being read. Try again.");
  });

  it("forwards native repeat keydowns even when xterm does not emit their input", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      bubbles: true,
      cancelable: true,
    }));
    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      repeat: true,
      bubbles: true,
      cancelable: true,
    }));
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

  it("does not use terminal-generated OSC color replies for the automatic title", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];

    // xterm sends OSC 10 replies back through onData when a CLI asks for the
    // terminal foreground color. The reply may be split across IPC chunks.
    terminal.emitData("\x1b]10;rgb:d4d4/d4d4/");
    terminal.emitData("d4d4\x07");
    terminal.emitData("请修复自动命名\r");

    await vi.waitFor(() => expect(rendererMocks.apiMock.autoRenameSessionFromFirstInput)
      .toHaveBeenCalledWith("renderer-test", "请修复自动命名"));
  });

  it("lets xterm handle native repeats in screen-reader mode without duplicating them", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.options.screenReaderMode = true;
    const xtermKeyDown = vi.fn(() => terminal.emitData("s"));
    terminal.textarea?.addEventListener("keydown", xtermKeyDown);
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      repeat: true,
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(xtermKeyDown).toHaveBeenCalledOnce();
    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("keeps Shift+Tab in the terminal without blocking xterm input", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("forwards committed third-party IME text when its keydown produced no xterm data", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Process",
      code: "KeyD",
      bubbles: true,
      cancelable: true,
    }));
    terminal.textarea?.dispatchEvent(new InputEvent("input", {
      data: "d",
      inputType: "insertText",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("d");
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("waits for xterm's deferred keyCode 229 textarea diff before falling back", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    textarea.dispatchEvent(new InputEvent("input", {
      data: "d",
      inputType: "insertText",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("forwards third-party IME commits in screen-reader mode", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.options.screenReaderMode = true;
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Process",
      code: "KeyD",
      bubbles: true,
      cancelable: true,
    }));
    terminal.textarea?.dispatchEvent(new InputEvent("input", {
      data: "d",
      inputType: "insertText",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("cancels a queued IME fallback when the terminal is disposed", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    vi.useFakeTimers();

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Process",
      code: "KeyD",
      bubbles: true,
      cancelable: true,
    }));
    terminal.textarea?.dispatchEvent(new InputEvent("input", {
      data: "d",
      inputType: "insertText",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    disposeHandle("renderer-test");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal.input).not.toHaveBeenCalled();
    expect(rendererMocks.apiMock.sendInput).not.toHaveBeenCalled();
  });

  it("does not duplicate input that xterm already forwarded from keydown", async () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);
    await vi.waitFor(() => expect(getState().runtime["renderer-test"]?.attached).toBe(true));
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    terminal.textarea?.addEventListener("keydown", () => terminal.emitData("a"));

    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      bubbles: true,
      cancelable: true,
    }));
    terminal.textarea?.dispatchEvent(new InputEvent("input", {
      data: "a",
      inputType: "insertText",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    await Promise.resolve();

    expect(terminal.input).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rendererMocks.apiMock.sendInput).toHaveBeenCalledOnce());
  });

  it("shows the live log-rotation notice only once per run", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const channel = rendererMocks.channels[0];

    for (let generation = 0; generation < 3; generation += 1) {
      channel.onmessage?.({
        t: "output",
        data: "QQ==",
        offset: 0,
        cursor: { runId: "run_rotation", runOrdinal: 1, generation, offset: 0 },
      });
    }

    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const notices = terminal.write.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes("Older terminal output has rotated"),
    );
    expect(notices).toHaveLength(1);

    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_after_restart", runOrdinal: 2, generation: 0, offset: 0 },
    });
    channel.onmessage?.({
      t: "output",
      data: "QQ==",
      offset: 0,
      cursor: { runId: "run_after_restart", runOrdinal: 2, generation: 1, offset: 0 },
    });

    const noticesAfterRestart = terminal.write.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes("Older terminal output has rotated"),
    );
    expect(noticesAfterRestart).toHaveLength(2);
  });

  it("restores the user's reading row when a write snaps the viewport to the bottom", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    (contentWrite?.[1] as () => void)();

    expect(terminal.scrollToLine).toHaveBeenCalledWith(200);
    expect(terminal.buffer.active.viewportY).toBe(200);
  });

  it("restores the user's reading row when a write drops the viewport to the top", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    (contentWrite?.[1] as () => void)();

    expect(terminal.scrollToLine).toHaveBeenCalledWith(200);
  });

  it("lets output keep following the tail while the user is at the bottom", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    (contentWrite?.[1] as () => void)();

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("does not fight xterm's trim compensation that lowers viewportY", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
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
    (contentWrite?.[1] as () => void)();

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
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

  it("writes raw PTY bytes without translating or rewriting them", async () => {
    mountTerminal("renderer-test", document.createElement("div"));
    await vi.waitFor(() => expect(rendererMocks.apiMock.attachSession).toHaveBeenCalled());
    const raw = "原始 Git/CLI 输出: checkout Session\r\n";
    const bytes = new TextEncoder().encode(raw);
    rendererMocks.channels[0].onmessage?.({
      t: "output",
      data: btoa(String.fromCharCode(...bytes)),
      offset: 0,
      cursor: { runId: "run_raw", runOrdinal: 1, generation: 0, offset: 0 },
    });

    const terminal = rendererMocks.terminals[rendererMocks.terminals.length - 1];
    const written = terminal.write.mock.calls
      .map(([value]) => value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value))
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
