import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTerminal } from "./MobileTerminal";

const terminalHarness = vi.hoisted(() => ({
  helper: undefined as HTMLTextAreaElement | undefined,
  screen: undefined as HTMLDivElement | undefined,
  screenHeight: 240,
  selection: "selected output",
  fitCalls: 0,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() { terminalHarness.fitCalls += 1; } },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { cursorY: 20 } };
    options: { fontSize?: number } = {};
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
    onData() { return { dispose() { /* deterministic no-op */ } }; }
    focus() { terminalHarness.helper?.focus(); }
    write() { /* deterministic no-op */ }
    reset() { /* deterministic no-op */ }
    dispose() { /* deterministic no-op */ }
    selectAll() { /* deterministic no-op */ }
    getSelection() { return terminalHarness.selection; }
  },
}));

describe("MobileTerminal input accessory", () => {
  beforeEach(() => {
    terminalHarness.helper = undefined;
    terminalHarness.screen = undefined;
    terminalHarness.screenHeight = 240;
    terminalHarness.fitCalls = 0;
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
