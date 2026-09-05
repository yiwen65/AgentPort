import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_APPEARANCE_KEY, loadAppAppearance, useAppAppearance, useApplyAppAppearance } from "./appAppearance";

function Controls() {
  const { preference, update, resolved } = useAppAppearance();
  return <><output>{preference}:{resolved}</output>{(["light", "dark", "system"] as const).map(mode => <button key={mode} onClick={() => update(mode)}>{mode}</button>)}</>;
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

describe("application appearance", () => {
  it("defaults to system, follows live OS changes, and ignores them under explicit selection", () => {
    render(<><AppTheme /><Controls /></>);
    expect(screen.getByText("system:light")).toBeInTheDocument();
    system(true);
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(localStorage.getItem(APP_APPEARANCE_KEY)).toBe("light");
    system(false); system(true);
    expect(screen.getByText("light:light")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(screen.getByText("system:dark")).toBeInTheDocument();
  });

  it("restores stored preference without overwriting it on mount and leaves terminal storage alone", () => {
    localStorage.setItem(APP_APPEARANCE_KEY, "dark");
    localStorage.setItem("agentport-mobile-v2:terminal-appearance", '{"theme":"ember","mode":"light"}');
    const write = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<><AppTheme /><Controls /></>);
    expect(screen.getByText("dark:dark")).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(localStorage.getItem("agentport-mobile-v2:terminal-appearance")).toBe('{"theme":"ember","mode":"light"}');
    view.unmount();
    expect(listeners.size).toBe(0);
    expect(document.documentElement).not.toHaveAttribute("data-app-theme");
    render(<Controls />);
    expect(screen.getByText("light:light")).toBeInTheDocument();
  });

  it("handles invalid and denied storage and still updates mounted consumers", () => {
    localStorage.setItem(APP_APPEARANCE_KEY, "invalid");
    expect(loadAppAppearance()).toBe("system");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<><AppTheme /><Controls /></>);
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    expect(screen.getByText("dark:dark")).toBeInTheDocument();
  });

  it("accepts cross-window storage changes and a clear falls back to system", () => {
    render(<><AppTheme /><Controls /></>);
    localStorage.setItem(APP_APPEARANCE_KEY, "dark");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: APP_APPEARANCE_KEY })));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
  });
});
