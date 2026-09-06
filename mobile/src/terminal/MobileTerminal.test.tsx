import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTerminal, type MobileTerminalHandle } from "./MobileTerminal";
import { MOBILE_TERMINAL_THEMES } from "./terminalThemes";

const terminalHarness = vi.hoisted(() => ({
  helper: undefined as HTMLTextAreaElement | undefined,
  screen: undefined as HTMLDivElement | undefined,
  screenHeight: 240,
  selection: "selected output",
  selects: [] as number[][],
  clears: 0,
  selectionChanged: () => {},
  fitCalls: 0,
  writes: [] as (string | Uint8Array)[],
  resets: 0,
  instances: 0,
  options: undefined as { fontSize?: number; minimumContrastRatio?: number; screenReaderMode?: boolean; theme?: unknown } | undefined,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() { terminalHarness.fitCalls += 1; } },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { cursorY: 20, viewportY: 0, baseY: 0, getLine: () => ({ getCell: () => ({ getChars: () => "a", getWidth: () => 1 }) }) } };
    options: { fontSize?: number; minimumContrastRatio?: number; screenReaderMode?: boolean; theme?: unknown };
    constructor(options: { fontSize?: number; minimumContrastRatio?: number; screenReaderMode?: boolean; theme?: unknown } = {}) {
      this.options = { ...options };
      terminalHarness.options = this.options;
      terminalHarness.instances += 1;
    }
    loadAddon() { /* deterministic no-op */ }
    open(container: HTMLElement) {
      terminalHarness.screen = document.createElement("div");
      terminalHarness.screen.className = "xterm-screen";
      terminalHarness.screen.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, right: 320, bottom: terminalHarness.screenHeight, left: 0,
        width: 320, height: terminalHarness.screenHeight, toJSON: () => ({}),
      });
      terminalHarness.helper = document.createElement("textarea");
      terminalHarness.helper.className = "xterm-helper-textarea";
      terminalHarness.screen.append(terminalHarness.helper);
      container.append(terminalHarness.screen);
    }
    onScroll() { return { dispose() {} }; }
    getSelectionPosition() { return { start: { x: 0, y: 4 }, end: { x: 10, y: 4 } }; }
    onData() { return { dispose() { /* deterministic no-op */ } }; }
    focus() { terminalHarness.helper?.focus(); }
    write(data: string | Uint8Array, callback?: () => void) {
      if (data) terminalHarness.writes.push(data);
      callback?.();
    }
    reset() { terminalHarness.resets += 1; }
    dispose() { /* deterministic no-op */ }
    selectAll() { /* deterministic no-op */ }
    getSelection() { return terminalHarness.selection; }
    select(...args: number[]) { terminalHarness.selects.push(args); }
    clearSelection() { terminalHarness.clears += 1; terminalHarness.selection = ""; terminalHarness.selectionChanged(); }
    onSelectionChange(callback: () => void) { terminalHarness.selectionChanged = callback; return { dispose() {} }; }
  },
}));

describe("MobileTerminal input accessory", () => {
  beforeEach(() => {
    terminalHarness.selection = "selected output";
    terminalHarness.selectionChanged = () => {};
    terminalHarness.selects = [];
    terminalHarness.clears = 0;
    terminalHarness.helper = undefined;
    terminalHarness.screen = undefined;
    terminalHarness.screenHeight = 240;
    terminalHarness.fitCalls = 0;
    terminalHarness.writes = [];
    terminalHarness.resets = 0;
    terminalHarness.instances = 0;
    terminalHarness.options = undefined;
    vi.stubGlobal("ResizeObserver", class {
      observe() { /* deterministic no-op */ }
      disconnect() { /* deterministic no-op */ }
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("pasted"), writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("uses stock xterm input with screen reader mode disabled", () => {
    render(<MobileTerminal showProbeOutput={false} />);
    expect(terminalHarness.options?.screenReaderMode).toBe(false);
  });

  it("exposes direct write and reset operations without React output state", () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showHeading={false} showProbeOutput={false} />);

    ref.current?.write("first");
    ref.current?.write("second");
    ref.current?.reset();

    expect(terminalHarness.writes).toEqual(["first", "second"]);
    expect(terminalHarness.resets).toBe(1);
  });

  it("passes raw bytes to the retained xterm without a text re-encode", () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    const bytes = new Uint8Array([0xe4, 0xbd]);
    ref.current?.write(bytes);
    expect(terminalHarness.writes[0]).toBe(bytes);
  });

  it("obscures stopping output without disposing or clearing the terminal", () => {
    const ref = createRef<MobileTerminalHandle>();
    const { rerender } = render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    const section = screen.getByRole("region", { name: "Terminal interaction test" });
    rerender(<MobileTerminal ref={ref} showProbeOutput={false} obscured />);
    ref.current?.write("Resume this session with: claude --resume fixture");
    expect(section).not.toBeVisible();
    expect(section).toHaveAttribute("aria-hidden", "true");
    expect(section.style.display).not.toBe("none");
    rerender(<MobileTerminal ref={ref} showProbeOutput={false} />);
    expect(section).toBeVisible();
    expect(terminalHarness.instances).toBe(1);
    expect(terminalHarness.resets).toBe(0);
    expect(terminalHarness.writes).toEqual(["Resume this session with: claude --resume fixture"]);
  });

  it("updates its xterm palette in place without replacing the live renderer", () => {
    const ref = createRef<MobileTerminalHandle>();
    const { rerender } = render(
      <MobileTerminal
        ref={ref}
        theme={MOBILE_TERMINAL_THEMES.one.dark.xterm}
        showHeading={false}
        showProbeOutput={false}
      />,
    );

    ref.current?.write("retained output");
    rerender(
      <MobileTerminal
        ref={ref}
        theme={MOBILE_TERMINAL_THEMES.aurora.light.xterm}
        showHeading={false}
        showProbeOutput={false}
      />,
    );

    expect(terminalHarness.instances).toBe(1);
    expect(terminalHarness.options?.minimumContrastRatio).toBe(4.5);
    expect(terminalHarness.options?.theme).toBe(MOBILE_TERMINAL_THEMES.aurora.light.xterm);
    expect(terminalHarness.writes).toEqual(["retained output"]);
    expect(terminalHarness.resets).toBe(0);
  });

  it("shows the requested icon row only while terminal input owns focus", async () => {
    const onInput = vi.fn();
    render(<><MobileTerminal onInput={onInput} showHeading={false} /><button type="button">Outside</button></>);
    const toolbar = screen.getByLabelText("Terminal special keys");
    expect(toolbar).not.toBeVisible();

    terminalHarness.helper!.focus();
    await waitFor(() => expect(toolbar).toBeVisible());
    expect(within(toolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Paste", "Escape", "Tab", "Shift", "Slash", "At sign", "Command",
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Shift" }));
    fireEvent.click(within(toolbar).getByRole("button", { name: "Tab" }));
    expect(onInput).toHaveBeenCalledWith("\u001b[Z");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onInput).toHaveBeenCalledWith("pasted"));

    screen.getByRole("button", { name: "Outside" }).focus();
    await waitFor(() => expect(toolbar).not.toBeVisible());
  });

  it("dispatches a touch shortcut before WebKit can drop terminal focus", async () => {
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showHeading={false} />);
    const toolbar = screen.getByLabelText("Terminal special keys");
    terminalHarness.helper!.focus();
    await waitFor(() => expect(toolbar).toBeVisible());

    const slash = within(toolbar).getByRole("button", { name: "Slash" });
    expect(fireEvent.touchStart(slash)).toBe(false);
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenLastCalledWith("/");
    expect(document.activeElement).toBe(terminalHarness.helper);

    fireEvent.click(slash, { detail: 1 });
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("dismisses terminal input when tapping output but keeps the current input rows active", async () => {
    render(<MobileTerminal showHeading={false} />);
    const toolbar = screen.getByLabelText("Terminal special keys");
    terminalHarness.helper!.focus();
    await waitFor(() => expect(toolbar).toBeVisible());

    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientY: 40 }] });
    fireEvent.click(terminalHarness.screen!, { clientY: 40 });
    await waitFor(() => expect(toolbar).not.toBeVisible());
    expect(document.activeElement).not.toBe(terminalHarness.helper);

    terminalHarness.helper!.focus();
    await waitFor(() => expect(toolbar).toBeVisible());
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientY: 205 }] });
    // The software keyboard can resize the viewport before WebKit emits click.
    terminalHarness.screenHeight = 120;
    fireEvent.click(terminalHarness.screen!, { clientY: 205 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(terminalHarness.helper);
    expect(toolbar).toBeVisible();
  });

  it("does not dismiss terminal input or refit when the immersive chrome reveal is tapped", async () => {
    render(<><MobileTerminal showHeading={false} /><button className="terminal-chrome-reveal">Reveal controls</button></>);
    terminalHarness.helper!.focus();
    await waitFor(() => expect(screen.getByLabelText("Terminal special keys")).toBeVisible());
    await new Promise(resolve => requestAnimationFrame(resolve));
    const fits = terminalHarness.fitCalls;
    const reveal = screen.getByRole("button", { name: "Reveal controls" });
    fireEvent.pointerDown(reveal);
    fireEvent.click(reveal, { detail: 1 });
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(terminalHarness.helper);
    expect(screen.getByLabelText("Terminal special keys")).toBeVisible();
    expect(terminalHarness.fitCalls).toBe(fits);
  });

  it("blocks xterm compatibility mousedown before it can focus output, but permits an input tap", () => {
    render(<MobileTerminal showHeading={false} />);
    const focus = vi.fn(() => terminalHarness.helper!.focus());
    terminalHarness.screen!.addEventListener("mousedown", focus);
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.mouseDown(terminalHarness.screen!, { clientY: 40 });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(terminalHarness.helper);
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 205 }] });
    fireEvent.mouseDown(terminalHarness.screen!, { clientY: 205 });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("routes vertical touch movement through xterm's wheel path, without interpreting a horizontal swipe as scroll", () => {
    render(<MobileTerminal showHeading={false} />);
    const wheel = vi.fn();
    screen.getByRole("application").addEventListener("wheel", wheel);
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 32, clientY: 100 }] });
    expect(wheel).toHaveBeenCalledWith(expect.objectContaining({ deltaY: 60 }));
    wheel.mockClear();
    fireEvent.touchEnd(terminalHarness.screen!, { changedTouches: [{ clientX: 32, clientY: 100 }] });
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 120, clientY: 155 }] });
    expect(wheel).not.toHaveBeenCalled();
  });

  it("long-presses and drag-selects output without wheel events or keyboard focus", () => {
    vi.useFakeTimers();
    try {
      const onInput = vi.fn();
      render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
      const wheel = vi.fn();
      terminalHarness.screen!.addEventListener("wheel", wheel);
      fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 40 }] });
      vi.advanceTimersByTime(550);
      expect(terminalHarness.selects).toEqual([[0, 4, 80]]);
      fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 80, clientY: 60 }] });
      expect(terminalHarness.selects.at(-1)).toEqual([0, 4, 181]);
      fireEvent.touchEnd(terminalHarness.screen!, { changedTouches: [{ clientX: 80, clientY: 60 }] });
      expect(wheel).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(terminalHarness.helper);
    } finally { vi.useRealTimers(); }
  });

  it("keeps selection available after a failed copy, and clears it only after success", async () => {
    render(<MobileTerminal showProbeOutput={false} />);
    const copy = vi.mocked(navigator.clipboard.writeText);
    copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    act(() => terminalHarness.selectionChanged());
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await screen.findByRole("alert");
    expect(terminalHarness.clears).toBe(0);
    expect(copy).toHaveBeenCalledWith("selected output");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Copy" })).toBeNull());
    expect(terminalHarness.clears).toBe(1);
  });

  it("hides the floating menu with obscured terminal output and reanchors it on return", async () => {
    const { rerender } = render(<MobileTerminal showProbeOutput={false} />);
    act(() => terminalHarness.selectionChanged());
    await screen.findByRole("button", { name: "Copy" });
    rerender(<MobileTerminal showProbeOutput={false} obscured />);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    rerender(<MobileTerminal showProbeOutput={false} />);
    await screen.findByRole("button", { name: "Copy" });
    expect(terminalHarness.instances).toBe(1);
  });

  it("cancels long-press selection on scrolling, multitouch, cancellation and unmount", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<MobileTerminal showProbeOutput={false} />);
      const start = () => fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 40 }] });
      start();
      fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 100 }] });
      vi.advanceTimersByTime(550);
      expect(terminalHarness.selects).toEqual([]);
      start();
      fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 40 }, { clientX: 50, clientY: 40 }] });
      vi.advanceTimersByTime(550);
      expect(terminalHarness.selects).toEqual([]);
      start(); fireEvent.touchCancel(terminalHarness.screen!);
      vi.advanceTimersByTime(550);
      expect(terminalHarness.selects).toEqual([]);
      start(); unmount(); vi.advanceTimersByTime(550);
      expect(terminalHarness.selects).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("uses the keyboard viewport and refits after the shortcut row enters layout", async () => {
    // WKWebView can shrink innerHeight together with visualViewport, so the
    // stable device window height is the keyboard-open comparison baseline.
    vi.stubGlobal("innerHeight", 500);
    vi.stubGlobal("screen", { height: 844 });
    vi.stubGlobal("visualViewport", {
      height: 500,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onResize = vi.fn();
    const { container } = render(<article className="session-workspace"><MobileTerminal onResize={onResize} showHeading={false} /></article>);
    const workspace = container.querySelector<HTMLElement>(".session-workspace")!;
    await waitFor(() => expect(terminalHarness.fitCalls).toBeGreaterThan(1));
    expect(workspace).toHaveAttribute("data-keyboard-visible", "true");

    const settledFits = terminalHarness.fitCalls;
    onResize.mockClear();
    terminalHarness.helper!.focus();
    await waitFor(() => expect(screen.getByLabelText("Terminal special keys")).toBeVisible());
    await waitFor(() => expect(terminalHarness.fitCalls).toBeGreaterThan(settledFits));
    expect(onResize).toHaveBeenCalledWith(80, 24);
  });
});
