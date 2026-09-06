import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyShortcutModifiers, BUILTIN_SHORTCUTS, defaultShortcuts, encodeShortcutKey, loadShortcuts, parseShortcutLayout, saveShortcuts, SHORTCUT_STORAGE_KEY } from "./shortcuts";

describe("terminal shortcut configuration", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());
  it("defaults to the requested order with exactly one Control", () => {
    expect(defaultShortcuts().items.map(item => item.id)).toEqual(["slash", "control", "tab", "at", "escape", "up", "down", "left", "right", "paste", "shift", "command"]);
  });
  it("round-trips reordered, hidden and custom items without sending anything", () => {
    const layout = defaultShortcuts();
    layout.items.reverse();
    layout.items[0].visible = false;
    layout.items.push({ id: "custom_interrupt", visible: true, label: "⌃C", action: { type: "key", key: "c", ctrl: true } });
    layout.items.push({ id: "custom_text", visible: true, label: "Hello", action: { type: "text", text: "hello 中文\n" } });
    saveShortcuts(layout);
    expect(loadShortcuts()).toEqual(parseShortcutLayout(layout));
  });
  it("rejects corrupt, duplicated, incomplete, excessive or executable-looking config", () => {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, "{");
    expect(loadShortcuts().items).toHaveLength(BUILTIN_SHORTCUTS.length);
    const base = defaultShortcuts();
    for (const value of [null, { ...base, version: 2 }, { ...base, items: base.items.slice(1) },
      { ...base, items: [...base.items, base.items[0]] },
      { ...base, items: [...base.items, { id: "custom_bad", label: "bad", visible: true, action: { type: "eval", text: "alert(1)" } }] },
      { ...base, items: [...base.items, { id: "custom_bad", label: "bad", visible: true, action: { type: "text", text: "\x1b[2J" } }] },
      { ...base, items: [...base.items, { id: "custom_bad", label: "bad", visible: true, action: { type: "key", key: "arbitrary-key", ctrl: "yes" } }] },
      { ...base, items: Array.from({ length: 100 }, () => base.items[0]) }]) {
      expect(parseShortcutLayout(value)).toBeUndefined();
    }
  });
  it("loads safely when storage is unavailable and reports save failure", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadShortcuts()).toEqual(defaultShortcuts());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(() => saveShortcuts(defaultShortcuts())).toThrow("full");
  });
});

describe("terminal key sequences", () => {
  it("encodes normal and application arrows, and modified cursor keys", () => {
    expect(encodeShortcutKey("ArrowUp")).toBe("\x1b[A");
    expect(encodeShortcutKey("ArrowDown", {}, true)).toBe("\x1bOB");
    expect(encodeShortcutKey("ArrowLeft", { ctrl: true }, true)).toBe("\x1b[1;5D");
    expect(encodeShortcutKey("ArrowRight", { ctrl: true, shift: true })).toBe("\x1b[1;6C");
    expect(encodeShortcutKey("Delete", { alt: true })).toBe("\x1b[3;3~");
  });
  it("encodes control, shift-tab, alt and ordinary text without appending Return", () => {
    expect(encodeShortcutKey("c", { ctrl: true })).toBe("\x03");
    expect(encodeShortcutKey("@", { ctrl: true })).toBe("\0");
    expect(encodeShortcutKey("/", { ctrl: true })).toBe("\x1f");
    expect(encodeShortcutKey("Tab", { shift: true })).toBe("\x1b[Z");
    expect(encodeShortcutKey("c", { ctrl: true, alt: true })).toBe("\x1b\x03");
    expect(encodeShortcutKey("Enter", { alt: true })).toBe("\x1b\r");
    expect(encodeShortcutKey("a", { shift: true })).toBe("A");
  });
  it("applies one-shot modifiers to xterm output without corrupting IME commits", () => {
    expect(applyShortcutModifiers("\x1bOA", { ctrl: true })).toBe("\x1b[1;5A");
    expect(applyShortcutModifiers("\t", { shift: true })).toBe("\x1b[Z");
    expect(applyShortcutModifiers("你好", { ctrl: true, shift: true })).toBe("你好");
    expect(applyShortcutModifiers("中", { ctrl: true })).toBe("中");
    expect(applyShortcutModifiers("ß", { ctrl: true })).toBe("ß");
  });
});
