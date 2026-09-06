import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ShortcutSettings } from "./ShortcutSettings";
import { defaultShortcuts, isCustomShortcut, type ShortcutLayout } from "./shortcuts";

afterEach(cleanup);
const open = (onSave = vi.fn(), onClose = vi.fn()) => {
  render(<ShortcutSettings layout={defaultShortcuts()} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
};
const addText = () => {
  fireEvent.click(screen.getByRole("button", { name: "Add shortcut" }));
  fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "Hello" } });
  fireEvent.change(screen.getByRole("textbox", { name: /^Text to send/ }), { target: { value: "你好\n" } });
  fireEvent.submit(screen.getByRole("form", { name: "Add shortcut" }));
};

describe("shortcut settings", () => {
  it("edits visibility and order in a draft, saves explicitly, and never mutates the original", () => {
    const original = defaultShortcuts();
    const onSave = vi.fn();
    render(<ShortcutSettings layout={original} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Slash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Control earlier" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(original.items[0]).toEqual({ id: "slash", visible: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0].items.slice(0, 2)).toEqual([{ id: "control", visible: true }, { id: "slash", visible: false }]);
  });
  it("discards edits on cancel, and restores defaults only in the draft", () => {
    const { onSave, onClose } = open();
    addText();
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(screen.queryByRole("button", { name: "Edit Hello" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("adds, edits and deletes custom text and modifier combinations", () => {
    const { onSave } = open();
    addText();
    fireEvent.click(screen.getByRole("button", { name: "Edit Hello" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "Interrupt" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "key" } });
    expect(screen.getByRole("checkbox", { name: "⌃ Ctrl" })).toBeChecked();
    fireEvent.submit(screen.getByRole("form", { name: "Add shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved: ShortcutLayout = onSave.mock.calls[0][0];
    const custom = saved.items.find(isCustomShortcut)!;
    expect(custom.label).toBe("Interrupt");
    expect(custom.action).toEqual({ type: "key", key: "c", ctrl: true, shift: false, alt: false });
    fireEvent.click(screen.getByRole("button", { name: "Delete Interrupt" }));
    expect(screen.queryByRole("button", { name: "Edit Interrupt" })).toBeNull();
  });
  it("keeps the dialog and draft on storage failure", () => {
    const { onClose } = open(vi.fn(() => { throw new Error("full"); }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to save");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("rejects invalid custom payloads and prevents saving unfinished edits", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add shortcut" }));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("form", { name: "Add shortcut" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(12);
  });
});
