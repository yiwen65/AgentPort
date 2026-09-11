import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_APPEARANCE_STORAGE_KEY, useAppAppearance, useApplyAppAppearance } from "./appAppearance";
import { useMobileTerminalAppearance } from "../terminal/terminalAppearance";
import { MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY as TERMINAL_KEY } from "../terminal/terminalThemes";
function Controls() {
  const [mode, update, resolved] = useAppAppearance();
  const [terminal, updateTerminal] = useMobileTerminalAppearance();
  useApplyAppAppearance();
  return <><output>{mode}:{resolved}:{terminal.theme}:{terminal.mode}</output>
    {(["light", "dark", "system"] as const).map(mode => <button key={mode} onClick={() => update(mode)}>{mode}</button>)}
    <button onClick={() => updateTerminal({ theme: "aurora", mode: "light" })}>terminal</button></>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => localStorage.clear());
describe("independent interface appearance", () => {
  it("defaults to mosaic dark without migrating or overwriting terminal preferences", () => {
    localStorage.setItem(TERMINAL_KEY, '{"theme":"ember","mode":"light"}');
    render(<Controls />);
    expect(screen.getByRole("status")).toHaveTextContent("dark:dark:ember:light");
    expect(document.documentElement).toHaveAttribute("data-theme-family", "mosaic");
    const background = document.documentElement.style.getPropertyValue("--bg");
    fireEvent.click(screen.getByText("terminal"));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(background);
    fireEvent.click(screen.getByText("light", { selector: "button" }));
    expect(JSON.parse(localStorage.getItem(TERMINAL_KEY)!)).toEqual({ theme: "aurora", mode: "light" });
    expect(localStorage.getItem(APP_APPEARANCE_STORAGE_KEY)).toBe("light");
  });
  it("responds only to its own storage key and restores its independent mode", () => {
    const view = render(<Controls />);
    localStorage.setItem(APP_APPEARANCE_STORAGE_KEY, "light");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: APP_APPEARANCE_STORAGE_KEY })));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
    view.unmount(); render(<Controls />);
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
    expect(document.documentElement.style.getPropertyValue("--terminal-bg")).toBe("");
  });
  it("keeps changes live when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<Controls />); fireEvent.click(screen.getByText("light", { selector: "button" }));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
  });
  it("resolves system mode without rewriting the choice", () => {
    const listeners = new Set<() => void>(); let dark = false;
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }));
    render(<Controls />); fireEvent.click(screen.getByText("system", { selector: "button" }));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
    act(() => { dark = true; listeners.forEach(fn => fn()); });
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    expect(localStorage.getItem(APP_APPEARANCE_STORAGE_KEY)).toBe("system");
    vi.unstubAllGlobals();
  });
});
