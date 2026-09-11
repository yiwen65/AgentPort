import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { APP_APPEARANCE_STORAGE_KEY } from "../../app/appAppearance";
import { MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY as STORAGE_KEY } from "../../terminal/terminalThemes";
import { SettingsDialog } from "./SettingsDialog";
const terminal = () => within(screen.getByRole("group", { name: "Terminal appearance" }));
const interfaceGroup = () => within(screen.getByRole("group", { name: "Interface appearance" }));
describe("SettingsDialog", () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("offers independent interface and terminal modes and preserves existing terminal preferences", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    const first = render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(12);
    expect(interfaceGroup().getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(terminal().getByRole("radio", { name: "Light" })).toBeChecked();
    expect(terminal().getByRole("radio", { name: "Aurora" })).toBeChecked();
    fireEvent.click(interfaceGroup().getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem(APP_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ theme: "aurora", mode: "light" });
    fireEvent.click(terminal().getByRole("radio", { name: "Dark" }));
    expect(interfaceGroup().getByRole("radio", { name: "Light" })).toBeChecked();
    first.unmount();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(interfaceGroup().getByRole("radio", { name: "Light" })).toBeChecked();
    expect(terminal().getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(writes).not.toHaveBeenCalled();
  });
  it("handles malformed terminal storage and reads fresh values on remount", () => {
    localStorage.setItem(STORAGE_KEY, "{invalid");
    const first = render(<SettingsDialog onClose={vi.fn()} />);
    expect(terminal().getByRole("radio", { name: "One" })).toBeChecked();
    first.unmount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(terminal().getByRole("radio", { name: "Aurora" })).toBeChecked();
  });
  it("keeps independent edits live when storage fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.click(interfaceGroup().getByRole("radio", { name: "Light" }));
    fireEvent.click(terminal().getByRole("radio", { name: "Aurora" }));
    expect(interfaceGroup().getByRole("radio", { name: "Light" })).toBeChecked();
    expect(terminal().getByRole("radio", { name: "Aurora" })).toBeChecked();
  });
  it("refreshes terminal storage without changing the interface", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: "aurora", mode: "light" }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY })));
    expect(terminal().getByRole("radio", { name: "Light" })).toBeChecked();
    expect(interfaceGroup().getByRole("radio", { name: "Dark" })).toBeChecked();
  });
  it("localizes the independent controls", async () => {
    await i18n.changeLanguage("zh-CN"); render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("group", { name: "主界面外观" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "终端外观" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "界面深浅模式" })).toBeInTheDocument();
  });
});
