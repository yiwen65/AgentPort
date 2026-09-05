import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApplyAppAppearance } from "./appAppearance";
import { useMobileTerminalAppearance } from "../terminal/terminalAppearance";
import { loadMobileTerminalAppearance, MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY as KEY } from "../terminal/terminalThemes";

function Controls() {
  const [appearance, update, resolved] = useMobileTerminalAppearance();
  return <><output>{appearance.theme}:{appearance.mode}:{resolved}</output>{(["light", "dark", "system"] as const).map(mode => <button key={mode} onClick={() => update({ mode })}>{mode}</button>)}</>;
}
function AppTheme() { useApplyAppAppearance(); return null; }
let media: MediaQueryList;
let listeners: Set<() => void>;
function system(dark: boolean) {
  Object.defineProperty(media, "matches", { configurable: true, value: dark });
  act(() => listeners.forEach(listener => listener()));
}

beforeEach(() => {
  localStorage.clear();
  listeners = new Set();
  media = { matches: false, addEventListener: vi.fn((_event, listener) => listeners.add(listener)), removeEventListener: vi.fn((_event, listener) => listeners.delete(listener)) } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("unified Theme", () => {
  it("defaults to One/System, follows OS changes and leaves the persisted preference as system", () => {
    render(<><AppTheme /><Controls /></>);
    expect(screen.getByText("one:system:light")).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#fafafa");
    system(true);
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282c34");
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ theme: "one", mode: "light" });
    system(false); system(true);
    expect(screen.getByText("one:light:light")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(screen.getByText("one:system:dark")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY)!).mode).toBe("system");
  });

  it("uses existing terminal choices as the source of truth, ignoring the retired independent app preference", () => {
    localStorage.setItem("agentport-mobile-v2:app-appearance", "dark");
    localStorage.setItem(KEY, '{"theme":"ember","mode":"light"}');
    const write = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<><AppTheme /><Controls /></>);
    expect(screen.getByText("ember:light:light")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme-family", "ember");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#fffaf5");
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    view.unmount();
    expect(listeners.size).toBe(0);
    expect(document.documentElement).not.toHaveAttribute("data-app-theme");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    render(<Controls />);
    expect(screen.getByText("ember:dark:dark")).toBeInTheDocument();
  });

  it("keeps mounted and newly opened consumers unified even when persistence fails", () => {
    localStorage.setItem(KEY, "invalid");
    expect(loadMobileTerminalAppearance()).toEqual({ theme: "one", mode: "system" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    function LateConsumer() {
      const [show, setShow] = useState(false);
      return <><button onClick={() => setShow(true)}>Mount consumer</button>{show ? <Controls /> : null}</>;
    }
    render(<><AppTheme /><Controls /><LateConsumer /></>);
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Mount consumer" }));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    expect(screen.getAllByText("one:dark:dark")).toHaveLength(2);
  });

  it("synchronizes external storage updates and resets to system on clear", () => {
    render(<><AppTheme /><Controls /></>);
    localStorage.setItem(KEY, '{"theme":"sakura","mode":"dark"}');
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(document.documentElement).toHaveAttribute("data-theme-family", "sakura");
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(document.documentElement).toHaveAttribute("data-theme-family", "one");
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
  });
});
