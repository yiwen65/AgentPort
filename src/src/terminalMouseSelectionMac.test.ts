// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// xterm caches its Mac detection from navigator.platform when the module is
// first imported, so stub it before loading @xterm/xterm and ./terminals.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
});

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  copyText: vi.fn().mockResolvedValue(true),
}));

// xterm decides "is this Node?" with `'title' in process`, which is true under
// Vitest even in the jsdom environment; that short-circuits its Mac detection.
// Hide process.title only while xterm evaluates so it reads navigator.platform.
const realProcess = (globalThis as unknown as {
  process: { [key: PropertyKey]: unknown };
}).process;
let Terminal: (typeof import("@xterm/xterm"))["Terminal"];
{
  const browserLikeProcess = new Proxy(realProcess, {
    has: (target, prop) => (prop === "title" ? false : prop in target),
  });
  Object.defineProperty(globalThis, "process", {
    value: browserLikeProcess,
    configurable: true,
  });
  try {
    ({ Terminal } = await import("@xterm/xterm"));
  } finally {
    Object.defineProperty(globalThis, "process", {
      value: realProcess,
      configurable: true,
    });
  }
}

const { copyText } = await import("./api");
const { getState, setState } = await import("./store");
const { installClipboardCompatibility } = await import("./terminals");

const disposals: Array<() => void> = [];
const originalPlatform = getState().platform;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
  setState({
    platform: {
      os: "macos",
      osVersion: "15.0",
      arch: "aarch64",
      webview: "WebKit",
      appVersion: "0.1.0",
      windowDecorated: true,
    },
    contextMenu: null,
  });
});

afterEach(() => {
  disposals.splice(0).reverse().forEach((fn) => fn());
  setState({ platform: originalPlatform, contextMenu: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(
  mode = 1002,
  opts: {
    alt?: boolean;
    onAgentScroll?: () => void;
    canAgentScroll?: () => boolean;
    enabled?: () => boolean;
  } = {},
) {
  const terminal = new Terminal({
    cols: 40,
    rows: 10,
    macOptionClickForcesSelection: true,
  });
  const container = document.createElement("div");
  document.body.append(container);
  terminal.open(container);
  const screen = terminal.element!.querySelector<HTMLElement>(".xterm-screen")!;
  // jsdom has no layout engine. Supply cell measurements only; selection,
  // mouse protocol parsing, DOM listeners and onData are real xterm 5.5.
  const core = (terminal as unknown as { _core: {
    _charSizeService: { width: number; height: number };
    _renderService: { dimensions: { css: {
      cell: { width: number; height: number };
      canvas: { width: number; height: number };
    } } };
  } })._core;
  core._charSizeService.width = 10;
  core._charSizeService.height = 20;
  core._renderService.dimensions.css.cell.width = 10;
  core._renderService.dimensions.css.cell.height = 20;
  core._renderService.dimensions.css.canvas.width = 400;
  core._renderService.dimensions.css.canvas.height = 200;
  screen.style.padding = "0px";
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200,
    width: 400, height: 200, toJSON() {},
  });
  terminal.write(
    (opts.alt ? "\x1b[?1049h" : "") +
      (mode ? `\x1b[?${mode}h\x1b[?1006h` : "") +
      "copy 中文\r\nsecond line",
  );
  await vi.advanceTimersByTimeAsync(10);
  const sent: string[] = [];
  const subscription = terminal.onData((data) => sent.push(data));
  const uninstall = installClipboardCompatibility(terminal, container, {
    onAgentScroll: opts.onAgentScroll,
    // Selection regressions keep the gesture local; edge-handoff tests opt in.
    canAgentScroll: opts.canAgentScroll ?? (() => false),
    enabled: opts.enabled,
  });
  disposals.push(() => {
    uninstall(); subscription.dispose(); terminal.dispose(); container.remove();
  });
  const mouse = (
    type: string,
    x: number,
    y = 1,
    modifiers: MouseEventInit = {},
    target: EventTarget = screen,
  ) => {
    const event = new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1,
      detail: 1, bubbles: true, cancelable: true, ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };
  const drag = (modifiers: MouseEventInit = {}) => {
    mouse("mousedown", 1, 1, modifiers);
    mouse("mousemove", 91, 1, modifiers);
    mouse("mouseup", 91, 1, modifiers);
  };
  return { terminal, sent, mouse, drag };
}

describe("macOS Agent mouse mode selection", () => {
  it.each([1000, 1002, 1003])(
    "selects with a plain drag in mouse protocol %s without reporting it to the Agent",
    async (mode) => {
      const { terminal, sent, drag } = await setup(mode);
      drag();
      expect(terminal.getSelection()).toBe("copy 中文");
      expect(sent).toEqual([]);
    },
  );

  it("still copies the drag through the right-click menu", async () => {
    const { terminal, sent, drag, mouse } = await setup();
    drag();
    mouse("mousemove", 120, 1, { buttons: 0 });
    mouse("mousedown", 91, 1, { button: 2, buttons: 2 });
    mouse("mouseup", 91, 1, { button: 2 });
    mouse("contextmenu", 91, 1, { button: 2 });
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
    const copy = getState().contextMenu!.items[0];
    expect(copy.disabled).toBe(false);
    copy.action!();
    expect(copyText).toHaveBeenCalledWith("copy 中文");
  });

  it("keeps a plain click as one Agent press/release pair", async () => {
    const { sent, mouse } = await setup();
    mouse("mousedown", 1);
    mouse("mouseup", 1);
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
  });

  it("keeps Option-drag as xterm's native forced selection", async () => {
    const { terminal, sent, drag } = await setup();
    drag({ altKey: true });
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
  });

  it("leaves Ctrl drag on the Agent mouse path", async () => {
    const { terminal, sent, drag } = await setup();
    drag({ ctrlKey: true });
    expect(terminal.getSelection()).toBe("");
    expect(sent).toHaveLength(3);
  });

  it("auto-scrolls locally while a drag is held beyond the top edge", async () => {
    const { terminal, sent, mouse } = await setup();
    terminal.write(
      "\r\n" + Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\r\n"),
    );
    await vi.advanceTimersByTimeAsync(20);
    terminal.scrollToBottom();
    const startViewportY = terminal.buffer.active.viewportY;
    expect(startViewportY).toBeGreaterThan(0);

    mouse("mousedown", 5, 100);
    mouse("mousemove", 5, -10);
    await vi.advanceTimersByTimeAsync(300);

    expect(terminal.buffer.active.viewportY).toBeLessThan(startViewportY);
    expect(sent).toEqual([]);
    mouse("mouseup", 5, -10);
  });

  it("hands an alternate-screen edge drag to the Agent as wheel reports", async () => {
    const onAgentScroll = vi.fn();
    const { terminal, sent, mouse } = await setup(1002, {
      alt: true,
      onAgentScroll,
      canAgentScroll: () => true,
    });
    terminal.write(
      "\r\n" + Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\r\n"),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(terminal.buffer.active.type).toBe("alternate");

    mouse("mousedown", 5, 100);
    mouse("mousemove", 5, -10);

    // The local selection ends; the TUI owns the rest of the gesture.
    expect(onAgentScroll).toHaveBeenCalledOnce();
    expect(terminal.getSelection()).toBe("");
    await vi.advanceTimersByTimeAsync(240);
    expect(sent.some((data) => data.includes("\x1b[<64;"))).toBe(true);

    mouse("mouseup", 5, -10);
    const afterRelease = sent.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(sent.length).toBe(afterRelease);
  });

  it("hands over as soon as the drag reaches the outermost row", async () => {
    const onAgentScroll = vi.fn();
    const { terminal, sent, mouse } = await setup(1002, {
      alt: true,
      onAgentScroll,
      canAgentScroll: () => true,
    });

    mouse("mousedown", 5, 100);
    mouse("mousemove", 5, 5); // first row, still inside the screen

    expect(onAgentScroll).toHaveBeenCalledOnce();
    expect(terminal.getSelection()).toBe("");
    await vi.advanceTimersByTimeAsync(160);
    expect(sent.some((data) => data.includes("\x1b[<64;"))).toBe(true);
    mouse("mouseup", 5, 5);
  });

  it("leaves the drag to a TUI that owns selection (Pi fullscreen)", async () => {
    const onAgentScroll = vi.fn();
    const { terminal, sent, drag } = await setup(1002, {
      alt: true,
      onAgentScroll,
      canAgentScroll: () => true,
      enabled: () => false,
    });

    drag();

    // The TUI receives the drag as mouse reports and does its own selection,
    // edge auto-scroll and copy-on-release.
    expect(terminal.getSelection()).toBe("");
    expect(onAgentScroll).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
  });

  it("keeps the selection when the Session cannot act on wheel reports", async () => {
    const onAgentScroll = vi.fn();
    const { terminal, mouse } = await setup(1002, {
      alt: true,
      onAgentScroll,
      canAgentScroll: () => false,
    });

    mouse("mousedown", 5, 100);
    mouse("mousemove", 5, -10);

    expect(onAgentScroll).not.toHaveBeenCalled();
    expect(terminal.getSelection()).not.toBe("");
    mouse("mouseup", 5, -10);
  });
});
