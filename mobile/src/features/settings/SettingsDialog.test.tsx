import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY as STORAGE_KEY } from "../../terminal/terminalThemes";
import { SettingsDialog } from "./SettingsDialog";

describe("SettingsDialog", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en-US");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("offers six themes and two modes, persists edits, and restores without resetting storage", () => {
    const first = render(<SettingsDialog onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "One" })).toBeChecked();
    expect(within(within(dialog).getByRole("radiogroup", { name: "Color theme" })).getAllByRole("radio")).toHaveLength(6);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Light" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Aurora" }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ theme: "aurora", mode: "light" });
    expect(dialog.style.getPropertyValue("--terminal-bg")).toBe("");
    expect(dialog.style.colorScheme).toBe("");
    expect(document.documentElement.style.getPropertyValue("--terminal-bg")).toBe("");
    const preview = within(dialog).getByRole("radio", { name: "Aurora" }).closest("label")!.querySelector<HTMLElement>(".mobile-terminal-theme-preview")!;
    expect(preview.style.getPropertyValue("--terminal-bg")).toBe("#f7f9ff");
    expect(preview.style.colorScheme).toBe("light");
    first.unmount();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Aurora" })).toBeChecked();
    expect(writes).not.toHaveBeenCalled();
  });

  it("reads fresh persisted values on each mount and safely handles malformed storage", () => {
    localStorage.setItem(STORAGE_KEY, "{invalid");
    const first = render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "One" })).toBeChecked();
    first.unmount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Aurora" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });

  it("keeps edits live when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("radio", { name: "Aurora" }));
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Aurora" })).toBeChecked();
  });

  it("refreshes external storage changes", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY })));
    expect(screen.getByRole("radio", { name: "Aurora" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });

  it("exposes localized appearance controls", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<SettingsDialog onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("终端外观")).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "深浅模式" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "浅色" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "主题色" })).toBeInTheDocument();
  });
});
