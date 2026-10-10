// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { copyText } from "./api";
import { getState, setState } from "./store";
import { installClipboardCompatibility } from "./terminals";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  copyText: vi.fn().mockResolvedValue(true),
}));

const disposals: Array<() => void> = [];
const originalPlatform = getState().platform;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {} }));
  setState({ platform: {
    os: "linux", osVersion: "24.04", arch: "x86_64", webview: "WebKitGTK",
    appVersion: "0.1.2", windowDecorated: true,
  }, contextMenu: null });
});

afterEach(() => {
  disposals.splice(0).reverse().forEach((fn) => fn());
  setState({ platform: originalPlatform, contextMenu: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(mode = 1002) {
  const terminal = new Terminal({ cols: 40, rows: 10 });
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
  terminal.write((mode ? `\x1b[?${mode}h\x1b[?1006h` : "") + "copy 中文\r\nsecond line");
  await vi.advanceTimersByTimeAsync(10);
  const sent: string[] = [];
  const subscription = terminal.onData((data) => sent.push(data));
  const uninstall = installClipboardCompatibility(terminal, container);
  disposals.push(() => {
    uninstall(); subscription.dispose(); terminal.dispose(); container.remove();
  });
  const mouse = (type: string, x: number, y = 1, modifiers: MouseEventInit = {}, target: EventTarget = screen) => {
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
  return { terminal, container, screen, sent, mouse, drag, uninstall };
}

describe("Linux Agent mouse mode selection", () => {
  it.each([1000, 1002, 1003])("copies a plain drag in mouse protocol %s through the context menu", async (mode) => {
    const { terminal, sent, drag, mouse } = await setup(mode);
    drag();
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
    // Real right-clicks have pointer motion and a button press before the menu.
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

  it("forwards a plain click as one Agent press/release pair", async () => {
    const { sent, mouse } = await setup();
    mouse("mousedown", 1);
    mouse("mouseup", 1);
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
  });

  it("leaves Ctrl drag on the Agent mouse path", async () => {
    const { terminal, sent, drag } = await setup();
    drag({ ctrlKey: true });
    expect(terminal.getSelection()).toBe("");
    expect(sent).toEqual(["\x1b[<16;1;1M", "\x1b[<48;10;1M", "\x1b[<16;10;1m"]);
  });

  it("keeps Shift drag on xterm's native selection path", async () => {
    const { terminal, sent, drag } = await setup();
    drag({ shiftKey: true });
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
  });

  it("does not change Shell selection", async () => {
    const { terminal, sent, drag } = await setup(0);
    drag();
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
  });

  it("does not change macOS Agent mouse input", async () => {
    const { terminal, sent, drag } = await setup();
    setState({ platform: { ...getState().platform!, os: "macos" } });
    drag();
    expect(terminal.getSelection()).toBe("");
    expect(sent).toHaveLength(3);
  });

  it("handles backward and multiline selection with xterm", async () => {
    const { terminal, sent, mouse } = await setup();
    mouse("mousedown", 61, 21);
    mouse("mousemove", 1, 1);
    mouse("mouseup", 1, 1);
    expect(terminal.getSelection()).toBe("copy 中文\nsecond");
    expect(sent).toEqual([]);
  });

  it("treats small hand jitter as an Agent click", async () => {
    const { sent, mouse } = await setup();
    mouse("mousedown", 1);
    mouse("mousemove", 3);
    mouse("mouseup", 3);
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
  });

  it("survives renderer child replacement after focus", async () => {
    const { terminal, screen, sent, mouse } = await setup();
    const child = document.createElement("span");
    screen.append(child);
    mouse("mousedown", 1, 1, {}, child);
    child.remove(); // DOM renderer redraws the hit-tested glyph on focus.
    mouse("mousemove", 91);
    mouse("mouseup", 91);
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
  });

  it("continues selecting outside the terminal", async () => {
    const { terminal, sent, mouse } = await setup();
    mouse("mousedown", 1);
    mouse("mousemove", 91, 1, {}, document);
    mouse("mouseup", 91, 1, {}, document);
    expect(terminal.getSelection()).toBe("copy 中文");
    expect(sent).toEqual([]);
  });

  it("cancels a pending click on blur without leaving mouse listeners active", async () => {
    const { terminal, sent, mouse } = await setup();
    mouse("mousedown", 1);
    window.dispatchEvent(new Event("blur"));
    mouse("mousemove", 91);
    mouse("mouseup", 91);
    expect(terminal.getSelection()).toBe("");
    expect(sent).toEqual([]);
    mouse("mousedown", 1);
    mouse("mouseup", 1);
    expect(sent).toHaveLength(2);
  });

  it("cleans up an active drag on uninstall", async () => {
    const { terminal, mouse, uninstall } = await setup();
    mouse("mousedown", 1);
    mouse("mousemove", 91);
    uninstall();
    mouse("mousemove", 151, 1, {}, document);
    expect(terminal.getSelection()).toBe("copy 中文");
  });

  it("does not activate a link after a drag but allows the next click", async () => {
    const { screen, drag, mouse } = await setup();
    const clicked = vi.fn();
    screen.addEventListener("click", clicked);
    drag();
    mouse("click", 91);
    expect(clicked).not.toHaveBeenCalled();
    mouse("mousedown", 1);
    mouse("mouseup", 1);
    mouse("click", 1);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("keeps wheel reports available to the Agent", async () => {
    const { screen, sent } = await setup();
    screen.dispatchEvent(new WheelEvent("wheel", {
      clientX: 1, clientY: 1, deltaY: 100, bubbles: true, cancelable: true,
    }));
    expect(sent).toEqual(["\x1b[<65;1;1M"]);
  });
});
