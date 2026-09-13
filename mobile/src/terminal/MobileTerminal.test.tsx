import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTerminal, type MobileTerminalHandle } from "./MobileTerminal";
import { MOBILE_TERMINAL_THEMES } from "./terminalThemes";
import { defaultShortcuts, loadShortcuts, saveShortcuts } from "./shortcuts";
import "../i18n";

const terminalHarness = vi.hoisted(() => ({
  helper: undefined as HTMLTextAreaElement | undefined,
  screen: undefined as HTMLDivElement | undefined,
  screenHeight: 240,
  baseY: 0,
  viewportY: 0,
  viewport: undefined as HTMLDivElement | undefined,
  selection: "selected output",
  selects: [] as number[][],
  clears: 0,
  selectionChanged: () => {},
  scrolled: (_viewportY: number) => {},
  input: (_data: string) => {},
  applicationCursor: false,
  mouseTracking: "none",
  bufferType: "normal",
  queued: false,
  writesQueue: [] as (() => void)[],
  fitCalls: 0,
  cols: 80,
  rows: 24,
  resizeObserved: () => {},
  scrolledLines: [] as number[],
  writes: [] as (string | Uint8Array)[],
  renderListeners: new Set<() => void>(),
  refreshes: 0,
  resets: 0,
  pastes: [] as string[],
  scrollToTopCalls: 0,
  instances: 0,
  options: undefined as { fontSize?: number; fontFamily?: string; minimumContrastRatio?: number; screenReaderMode?: boolean; scrollback?: number; theme?: unknown } | undefined,
}));

vi.mock("./terminalSnapshot", () => ({
  captureSnapshotState: () => ({ version: 1 }),
  restoreSnapshotState: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() { terminalHarness.fitCalls += 1; } },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class { serialize() { return "serialized-screen"; } },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) };
    resize(cols: number, rows: number) { terminalHarness.cols = cols; terminalHarness.rows = rows; }
    get cols() { return terminalHarness.cols; }
    get rows() { return terminalHarness.rows; }
    get modes() { return { applicationCursorKeysMode: terminalHarness.applicationCursor, mouseTrackingMode: terminalHarness.mouseTracking }; }
    buffer = { active: { get type() { return terminalHarness.bufferType; }, cursorY: 20, get viewportY() { return terminalHarness.viewportY; }, get baseY() { return terminalHarness.baseY; }, getLine: () => ({ getCell: () => ({ getChars: () => "a", getWidth: () => 1 }) }) } };
    element: HTMLElement | undefined;
    options: { fontSize?: number; fontFamily?: string; minimumContrastRatio?: number; screenReaderMode?: boolean; scrollback?: number; theme?: unknown };
    constructor(options: { fontSize?: number; fontFamily?: string; minimumContrastRatio?: number; screenReaderMode?: boolean; scrollback?: number; theme?: unknown } = {}) {
      this.options = { ...options };
      terminalHarness.options = this.options;
      terminalHarness.instances += 1;
    }
    loadAddon() { /* deterministic no-op */ }
    open(container: HTMLElement) {
      this.element = container;
      terminalHarness.viewport = document.createElement("div");
      terminalHarness.viewport.className = "xterm-viewport";
      Object.defineProperties(terminalHarness.viewport, { scrollHeight: { value: 20000 }, clientHeight: { value: 700 } });
      container.append(terminalHarness.viewport);
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
    onScroll(callback: (viewportY: number) => void) { terminalHarness.scrolled = callback; return { dispose() {} }; }
    getSelectionPosition() { return { start: { x: 0, y: 4 }, end: { x: 10, y: 4 } }; }
    onData(handler: (data: string) => void) { terminalHarness.input = handler; return { dispose() { /* deterministic no-op */ } }; }
    focus() { terminalHarness.helper?.focus(); }
    write(data: string | Uint8Array, callback?: () => void) {
      const parse = () => { if (data) terminalHarness.writes.push(data); callback?.(); };
      if (terminalHarness.queued) terminalHarness.writesQueue.push(parse); else parse();
    }
    reset() { terminalHarness.resets += 1; }
    onWriteParsed() { return { dispose() {} }; }
    onRender(callback: () => void) { terminalHarness.renderListeners.add(callback); return { dispose() { terminalHarness.renderListeners.delete(callback); } }; }
    refresh() { terminalHarness.refreshes += 1; }
    paste(data: string) { terminalHarness.pastes.push(data); terminalHarness.input(data); }
    scrollLines(rows: number) { terminalHarness.scrolledLines.push(rows); }
    scrollToTop() { terminalHarness.scrollToTopCalls += 1; }
    scrollToBottom() { terminalHarness.viewportY = terminalHarness.baseY; }
    dispose() { /* deterministic no-op */ }
    selectAll() { /* deterministic no-op */ }
    getSelection() { return terminalHarness.selection; }
    select(...args: number[]) { terminalHarness.selects.push(args); }
    clearSelection() { terminalHarness.clears += 1; terminalHarness.selection = ""; terminalHarness.selectionChanged(); }
    onSelectionChange(callback: () => void) { terminalHarness.selectionChanged = callback; return { dispose() {} }; }
  },
}));

describe("MobileTerminal input accessory", () => {
  it("covers recovery without hiding or replacing the focused terminal", () => {
    const view = render(<MobileTerminal showProbeOutput={false} />);
    const helper = terminalHarness.helper!;
    helper.focus();
    view.rerender(<MobileTerminal showProbeOutput={false} recovering recoveryLabel="Reconnecting" />);
    expect(document.activeElement).toBe(helper);
    const surface = view.container.querySelector(".mobile-terminal-surface")!;
    expect(surface).toHaveAttribute("data-recovering", "true");
    expect(surface).toHaveAttribute("data-recovery-label", "Reconnecting");
    expect(surface).toHaveAttribute("aria-busy", "true");
    expect(view.container.querySelector(".mobile-terminal-spike")).not.toHaveStyle({ visibility: "hidden" });
    view.rerender(<MobileTerminal showProbeOutput={false} />);
    expect(surface).not.toHaveAttribute("data-recovering");
    expect(document.activeElement).toBe(helper);
  });

  it("applies and updates the configured terminal font", () => {
    const view = render(<MobileTerminal showProbeOutput={false} fontFamily="JetBrains Mono" />);
    expect(terminalHarness.options?.fontFamily).toBe("JetBrains Mono");
    view.rerender(<MobileTerminal showProbeOutput={false} fontFamily="Fira Code" />);
    expect(terminalHarness.options?.fontFamily).toBe("Fira Code");
  });

  it("finishes restoration only on a real render and cancels an obsolete render waiter", async () => {
    const ref = createRef<MobileTerminalHandle>();
    const view = render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    const old = vi.fn(), current = vi.fn();
    act(() => { ref.current!.finishRestore(old); ref.current!.finishRestore(current); });
    expect(old).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    act(() => { for (const render of [...terminalHarness.renderListeners]) render(); });
    expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(1);
    const disposed = vi.fn(); ref.current!.finishRestore(disposed);
    view.unmount();
    for (const render of [...terminalHarness.renderListeners]) render();
    expect(disposed).not.toHaveBeenCalled();
  });
  it("captures after queued writes during release, before disposal", async () => {
    const ref = createRef<MobileTerminalHandle>();
    let captured: ReturnType<MobileTerminalHandle["capture"]> | undefined;
    const view = render(<MobileTerminal ref={ref} showProbeOutput={false} onRelease={handle => { captured = handle.capture(); }} />);
    terminalHarness.queued = true;
    ref.current!.write("\x1b[38;2;");
    view.unmount();
    expect(captured).toBeDefined();
    while (terminalHarness.writesQueue.length) terminalHarness.writesQueue.shift()!();
    expect(await captured).toEqual({ content: "serialized-screen", cols: 80, rows: 24, pending: [...new TextEncoder().encode("\x1b[38;2;")], state: { version: 1 } });
  });

  it("keeps checkpoint geometry until resumed output has drained", async () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    await act(async () => ref.current!.restore({ content: "screen", cols: 47, rows: 53, pending: [27, 91] }));
    const fits = terminalHarness.fitCalls;
    act(() => terminalHarness.resizeObserved());
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(terminalHarness.fitCalls).toBe(fits);
    expect(terminalHarness.cols).toBe(47);
    expect(terminalHarness.rows).toBe(53);
    act(() => ref.current!.finishRestore());
    await waitFor(() => expect(terminalHarness.fitCalls).toBeGreaterThan(fits));
  });

  it("synchronizes restored log geometry and the native tail before returning to the event loop", async () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    await act(async () => ref.current!.restore({ content: "snapshot", cols: 160, rows: 50, pending: [] }));
    terminalHarness.baseY = 651;
    terminalHarness.viewportY = 651;
    const fits = terminalHarness.fitCalls;
    act(() => ref.current!.finishRestore());
    expect(terminalHarness.fitCalls).toBeGreaterThan(fits);
    expect(terminalHarness.viewportY).toBe(651);
    expect(terminalHarness.viewport!.scrollTop).toBe(19300);
    // A later reading gesture must not be overwritten by a queued tail repair.
    terminalHarness.viewportY = 300;
    terminalHarness.viewport!.scrollTop = 9000;
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(terminalHarness.viewportY).toBe(300);
    expect(terminalHarness.viewport!.scrollTop).toBe(9000);
  });

  it("does not force a live scrollback reader to the tail at a replay barrier", () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    terminalHarness.baseY = 651;
    terminalHarness.viewportY = 300;
    act(() => ref.current!.finishRestore());
    expect(terminalHarness.viewportY).toBe(300);
  });

  beforeEach(() => {
    localStorage.clear();
    terminalHarness.applicationCursor = false;
    terminalHarness.mouseTracking = "none";
    terminalHarness.bufferType = "normal";
    terminalHarness.queued = false;
    terminalHarness.writesQueue = [];
    terminalHarness.scrolledLines = [];
    terminalHarness.input = () => {};
    terminalHarness.selection = "selected output";
    terminalHarness.selectionChanged = () => {};
    terminalHarness.scrolled = () => {};
    terminalHarness.selects = [];
    terminalHarness.clears = 0;
    terminalHarness.helper = undefined;
    terminalHarness.screen = undefined;
    terminalHarness.screenHeight = 240;
    terminalHarness.baseY = 0;
    terminalHarness.viewportY = 0;
    terminalHarness.viewport = undefined;
    terminalHarness.fitCalls = 0;
    terminalHarness.cols = 80;
    terminalHarness.rows = 24;
    terminalHarness.writes = [];
    terminalHarness.resets = 0;
    terminalHarness.pastes = [];
    terminalHarness.scrollToTopCalls = 0;
    terminalHarness.instances = 0;
    terminalHarness.options = undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { terminalHarness.resizeObserved = callback; }
      observe() { /* deterministic no-op */ }
      disconnect() { /* deterministic no-op */ }
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("pasted"), writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("uses stock xterm input with screen reader mode disabled and deep scrollback", () => {
    render(<MobileTerminal showProbeOutput={false} />);
    expect(terminalHarness.options?.screenReaderMode).toBe(false);
    expect(terminalHarness.options?.scrollback).toBe(2_000);
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

  it("fences reset and parse completion behind queued writes, without reordering live bytes", () => {
    const ref = createRef<MobileTerminalHandle>();
    render(<MobileTerminal ref={ref} showProbeOutput={false} />);
    terminalHarness.queued = true;
    const parsed = vi.fn();
    ref.current?.write("old");
    ref.current?.reset();
    ref.current?.write("replay");
    ref.current?.write("", parsed);
    ref.current?.write("live");
    expect(terminalHarness.resets).toBe(0);
    expect(parsed).not.toHaveBeenCalled();
    terminalHarness.writesQueue.shift()?.();
    terminalHarness.writesQueue.shift()?.();
    expect(terminalHarness.resets).toBe(1);
    terminalHarness.writesQueue.shift()?.();
    expect(parsed).not.toHaveBeenCalled();
    terminalHarness.writesQueue.shift()?.();
    expect(parsed).toHaveBeenCalledOnce();
    terminalHarness.writesQueue.shift()?.();
    expect(terminalHarness.writes).toEqual(["old", "replay", "live"]);
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
      "Slash", "Control", "Tab", "At sign", "Escape", "Up arrow", "Down arrow", "Left arrow", "Right arrow", "Paste", "Shift", "Command", "Terminal shortcuts",
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Shift" }));
    fireEvent.click(within(toolbar).getByRole("button", { name: "Tab" }));
    expect(onInput).toHaveBeenCalledWith("\u001b[Z");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onInput).toHaveBeenCalledWith("pasted"));

    screen.getByRole("button", { name: "Outside" }).focus();
    await waitFor(() => expect(toolbar).not.toBeVisible());
  });

  it("waits for a completed tap so horizontal shortcut swipes do not send input", async () => {
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showHeading={false} />);
    const toolbar = screen.getByLabelText("Terminal special keys");
    terminalHarness.helper!.focus();
    await waitFor(() => expect(toolbar).toBeVisible());

    const slash = within(toolbar).getByRole("button", { name: "Slash" });
    expect(fireEvent.touchStart(slash)).toBe(true);
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.mouseDown(slash);
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.click(slash, { detail: 1 });
    expect(onInput).toHaveBeenCalledExactlyOnceWith("/");
    expect(document.activeElement).toBe(terminalHarness.helper);
  });

  it("uploads one image and uses existing paste without Enter, even after picker focus loss", async () => {
    let resolve!: (path: string | null) => void;
    const onUploadImage = vi.fn(() => new Promise<string | null>(done => { resolve = done; }));
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} onUploadImage={onUploadImage} imageUploadTarget="host/session/run" showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const button = await screen.findByRole("button", { name: "Upload image" });
    fireEvent.mouseDown(button);
    expect(onUploadImage).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onUploadImage).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    terminalHarness.helper!.blur();
    const path = "/home/test/.cache/agentport/image-1726031234.png";
    await act(async () => resolve(path));
    expect(terminalHarness.pastes).toEqual([path]);
    expect(onInput).toHaveBeenCalledExactlyOnceWith(path);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });

  it.each(["cancel", "failure"])("does not insert a path on image %s", async outcome => {
    const onInput = vi.fn();
    const onUploadImage = outcome === "cancel" ? vi.fn().mockResolvedValue(null)
      : vi.fn().mockRejectedValue("SFTP unavailable");
    render(<MobileTerminal onInput={onInput} onUploadImage={onUploadImage} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const button = await screen.findByRole("button", { name: "Upload image" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(onInput).not.toHaveBeenCalled();
    expect(terminalHarness.pastes).toEqual([]);
    if (outcome === "failure") expect(screen.getByRole("alert")).toHaveTextContent("SFTP unavailable");
    else expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["reset", "unmount", "hide", "target", "switch-back"])("does not misroute an uploaded image after %s", async boundary => {
    let resolve!: (path: string) => void;
    const onUploadImage = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const ref = createRef<MobileTerminalHandle>();
    const onInput = vi.fn();
    const props = { onInput, onUploadImage, showProbeOutput: false, imageUploadTarget: "original" };
    const view = render(<MobileTerminal ref={ref} {...props} />);
    terminalHarness.helper!.focus();
    fireEvent.click(await screen.findByRole("button", { name: "Upload image" }));
    if (boundary === "reset") act(() => ref.current?.reset());
    if (boundary === "unmount") view.unmount();
    if (boundary === "hide") view.rerender(<MobileTerminal ref={ref} {...props} obscured />);
    if (boundary === "target" || boundary === "switch-back") view.rerender(<MobileTerminal ref={ref} {...props} imageUploadTarget="other" />);
    if (boundary === "switch-back") view.rerender(<MobileTerminal ref={ref} {...props} />);
    await act(async () => resolve("/home/test/.cache/agentport/image.png"));
    expect(onInput).not.toHaveBeenCalled();
    expect(terminalHarness.pastes).toEqual([]);
  });

  it("reads the clipboard on the completed click, not before WebKit grants user activation", async () => {
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const paste = await screen.findByRole("button", { name: "Paste" });
    paste.getBoundingClientRect = () => ({ left: 0, right: 44, top: 0, bottom: 44 } as DOMRect);
    const point = { clientX: 10, clientY: 10 };
    fireEvent.touchStart(paste, { touches: [point] });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    fireEvent.touchEnd(paste, { touches: [], changedTouches: [point] });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    fireEvent.mouseDown(paste);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    fireEvent.click(paste, { detail: 1 });
    await waitFor(() => expect(onInput).toHaveBeenCalledExactlyOnceWith("pasted"));
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(terminalHarness.helper);
  });

  it("pastes through the native bridge once without opening WebKit's clipboard menu", async () => {
    const invoke = vi.fn().mockResolvedValue("native pasted");
    vi.stubGlobal("isTauri", true);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    vi.mocked(navigator.clipboard.readText).mockRejectedValue(new DOMException("WebKit menu", "NotAllowedError"));
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    fireEvent.click(await screen.findByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onInput).toHaveBeenCalledExactlyOnceWith("native pasted"));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin:clipboard-manager|read_text", {}, undefined);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(terminalHarness.pastes).toEqual(["native pasted"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not fall back to WebKit or send input when native clipboard access is denied", async () => {
    const invoke = vi.fn().mockRejectedValue("Denied");
    vi.stubGlobal("isTauri", true);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    fireEvent.click(await screen.findByRole("button", { name: "Paste" }));
    await screen.findByRole("alert");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });

  it("allows only one clipboard read while a paste request is pending", async () => {
    let resolve!: (text: string) => void;
    vi.mocked(navigator.clipboard.readText).mockReturnValue(new Promise(done => { resolve = done; }));
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const paste = await screen.findByRole("button", { name: "Paste" });
    fireEvent.click(paste);
    fireEvent.click(paste);
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Control" }));
    await act(async () => resolve("c"));
    expect(onInput).toHaveBeenCalledExactlyOnceWith("c");
  });

  it.each(["reset", "unmount", "hide"])("discards a clipboard reply after terminal %s", async boundary => {
    let resolve!: (text: string) => void;
    vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const ref = createRef<MobileTerminalHandle>();
    const onInput = vi.fn();
    const view = render(<MobileTerminal ref={ref} onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    fireEvent.click(await screen.findByRole("button", { name: "Paste" }));
    if (boundary === "reset") act(() => ref.current?.reset());
    if (boundary === "unmount") view.unmount();
    if (boundary === "hide") view.rerender(<MobileTerminal ref={ref} onInput={onInput} showProbeOutput={false} obscured />);
    await act(async () => resolve("late paste"));
    expect(onInput).not.toHaveBeenCalled();
  });

  it("does not paste when a touch is dragged or cancelled", async () => {
    render(<MobileTerminal showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const paste = await screen.findByRole("button", { name: "Paste" });
    paste.getBoundingClientRect = () => ({ left: 0, right: 44, top: 0, bottom: 44 } as DOMRect);
    const point = { clientX: 10, clientY: 10 };
    fireEvent.touchStart(paste, { touches: [point] });
    fireEvent.touchMove(paste, { touches: [{ clientX: 60, clientY: 10 }] });
    fireEvent.touchEnd(paste, { touches: [], changedTouches: [point] });
    fireEvent.touchStart(paste, { touches: [point] });
    fireEvent.touchCancel(paste);
    fireEvent.touchEnd(paste, { touches: [], changedTouches: [point] });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it("reports denied clipboard access without sending input, and permits an explicit retry", async () => {
    const onInput = vi.fn();
    vi.mocked(navigator.clipboard.readText).mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const paste = await screen.findByRole("button", { name: "Paste" });
    fireEvent.click(paste);
    await screen.findByRole("alert");
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.click(paste);
    await waitFor(() => expect(onInput).toHaveBeenCalledExactlyOnceWith("pasted"));
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("routes vertical touch movement through fast local scrollback, without interpreting a horizontal swipe as scroll", async () => {
    render(<MobileTerminal showHeading={false} />);
    const wheel = vi.fn();
    screen.getByRole("application").addEventListener("wheel", wheel);
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 32, clientY: 100 }] });
    expect(wheel).not.toHaveBeenCalled();
    expect(terminalHarness.scrolledLines).toEqual([]);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(terminalHarness.scrolledLines).toEqual([21]);
    expect(wheel).not.toHaveBeenCalled();
    fireEvent.touchEnd(terminalHarness.screen!, { changedTouches: [{ clientX: 32, clientY: 100 }] });
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 120, clientY: 155 }] });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(terminalHarness.scrolledLines).toEqual([21]);
  });

  it.each([
    ["alternate", "none"], ["normal", "x10"], ["alternate", "vt200"],
    ["normal", "drag"], ["alternate", "any"],
  ])("delegates %s buffer / %s mouse mode to xterm's wheel encoder", async (bufferType, mouseTracking) => {
    terminalHarness.bufferType = bufferType;
    terminalHarness.mouseTracking = mouseTracking;
    render(<MobileTerminal showHeading={false} />);
    const wheel = vi.fn();
    screen.getByRole("application").addEventListener("wheel", wheel);
    fireEvent.touchStart(terminalHarness.screen!, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchMove(terminalHarness.screen!, { touches: [{ clientX: 32, clientY: 100 }] });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(wheel).toHaveBeenCalledWith(expect.objectContaining({ deltaY: 150, deltaMode: WheelEvent.DOM_DELTA_PIXEL }));
    expect(terminalHarness.scrolledLines).toEqual([]);
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

  it("uses one-shot Control/Shift and live application-cursor mode without duplicate input", async () => {
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const ctrl = await screen.findByRole("button", { name: "Control" });
    fireEvent.click(ctrl);
    expect(ctrl).toHaveAttribute("aria-pressed", "true");
    act(() => terminalHarness.input("c"));
    expect(onInput).toHaveBeenLastCalledWith("\u0003");
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
    act(() => terminalHarness.input("c"));
    expect(onInput).toHaveBeenLastCalledWith("c");
    terminalHarness.applicationCursor = true;
    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));
    expect(onInput).toHaveBeenLastCalledWith("\u001bOA");
    fireEvent.click(ctrl);
    fireEvent.click(screen.getByRole("button", { name: "Shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Left arrow" }));
    expect(onInput).toHaveBeenLastCalledWith("\u001b[1;6D");
    expect(onInput).toHaveBeenCalledTimes(4);
  });

  it("loads custom text and combinations and sends their exact payload only when clicked", async () => {
    const layout = defaultShortcuts();
    layout.items.push({ id: "custom_text", visible: true, label: "Greeting", action: { type: "text", text: "hello 中文\n" } });
    layout.items.push({ id: "custom_key", visible: true, label: "Interrupt", action: { type: "key", key: "c", ctrl: true } });
    saveShortcuts(layout);
    const onInput = vi.fn();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    const text = await screen.findByRole("button", { name: "Greeting" });
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.click(text);
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onInput.mock.calls).toEqual([["hello 中文\n"], ["\u0003"]]);
  });

  it("saves layout from the gear without sending input and retains it after remount", async () => {
    const onInput = vi.fn();
    const view = render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    fireEvent.click(await screen.findByRole("button", { name: "Terminal shortcuts" }));
    const dialog = await screen.findByRole("dialog", { name: "Terminal shortcuts" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show Slash" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadShortcuts().items[0].visible).toBe(false);
    expect(onInput).not.toHaveBeenCalled();
    expect(terminalHarness.instances).toBe(1);
    view.unmount();
    render(<MobileTerminal onInput={onInput} showProbeOutput={false} />);
    terminalHarness.helper!.focus();
    await screen.findByRole("button", { name: "Terminal shortcuts" });
    expect(screen.queryByRole("button", { name: "Slash" })).toBeNull();
    expect(onInput).not.toHaveBeenCalled();
  });

  it("reports content-box geometry changes after layout settles, including while concealed", async () => {
    const onResize = vi.fn();
    render(<MobileTerminal onResize={onResize} showProbeOutput={false} obscured />);
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    onResize.mockClear();
    terminalHarness.cols = 52;
    terminalHarness.rows = 38;
    act(() => { terminalHarness.resizeObserved(); terminalHarness.resizeObserved(); });
    await waitFor(() => expect(onResize).toHaveBeenCalledWith(52, 38));
    expect(onResize).toHaveBeenCalledOnce();
    act(() => terminalHarness.resizeObserved());
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(onResize).toHaveBeenCalledOnce();
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
