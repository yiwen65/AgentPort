import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTerminal } from "./MobileTerminal";

const terminalHarness = vi.hoisted(() => ({
  helper: undefined as HTMLTextAreaElement | undefined,
  selection: "selected output",
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() { /* deterministic no-op */ } },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { fontSize?: number } = {};
    loadAddon() { /* deterministic no-op */ }
    open(container: HTMLElement) {
      terminalHarness.helper = document.createElement("textarea");
      terminalHarness.helper.className = "xterm-helper-textarea";
      container.append(terminalHarness.helper);
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
});
