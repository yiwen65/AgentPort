import { describe, expect, it } from "vitest";
import { paneShortcutAction } from "./paneShortcuts";

const key = (
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("pane shortcuts", () => {
  it("uses the confirmed macOS shortcuts", () => {
    expect(paneShortcutAction(key("d", { metaKey: true }), true)).toBe("split-right");
    expect(
      paneShortcutAction(key("D", { metaKey: true, shiftKey: true }), true),
    ).toBe("split-down");
    expect(
      paneShortcutAction(key("Enter", { metaKey: true, shiftKey: true }), true),
    ).toBe("toggle-maximize");
  });

  it("uses the confirmed Linux shortcuts", () => {
    expect(
      paneShortcutAction(key("e", { ctrlKey: true, shiftKey: true }), false),
    ).toBe("split-right");
    expect(
      paneShortcutAction(key("O", { ctrlKey: true, shiftKey: true }), false),
    ).toBe("split-down");
    expect(
      paneShortcutAction(key("x", { ctrlKey: true, shiftKey: true }), false),
    ).toBe("toggle-maximize");
  });

  it("does not intercept terminal control keys or extra-modifier variants", () => {
    expect(paneShortcutAction(key("d", { ctrlKey: true }), false)).toBeNull();
    expect(
      paneShortcutAction(
        key("e", { ctrlKey: true, shiftKey: true, altKey: true }),
        false,
      ),
    ).toBeNull();
    expect(
      paneShortcutAction(key("d", { metaKey: true, altKey: true }), true),
    ).toBeNull();
  });
});
