import { describe, expect, it } from "vitest";
import { piTerminalShortcutSequence } from "./piTerminalShortcuts";

function key(
  keyValue: string,
  code: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
) {
  return {
    key: keyValue,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("Pi terminal shortcuts", () => {
  it.each([
    [key("g", "KeyG", { metaKey: true }), "\x1b[103;9u"],
    [key("©", "KeyG", { altKey: true }), "\x1b[103;3u"],
    [key("ArrowUp", "ArrowUp", { metaKey: true }), "\x1b[1;9A"],
    [key("ArrowUp", "ArrowUp", { altKey: true }), "\x1b[1;3A"],
    [key("ArrowDown", "ArrowDown", { metaKey: true }), "\x1b[1;9B"],
    [key("ArrowDown", "ArrowDown", { altKey: true }), "\x1b[1;3B"],
  ])("maps the requested chord to terminal input", (event, sequence) => {
    expect(piTerminalShortcutSequence(event)).toBe(sequence);
  });

  it.each([
    key("g", "KeyG"),
    key("g", "KeyG", { metaKey: true, shiftKey: true }),
    key("g", "KeyG", { metaKey: true, altKey: true }),
    key("ArrowLeft", "ArrowLeft", { altKey: true }),
  ])("ignores unrelated or ambiguous chords", (event) => {
    expect(piTerminalShortcutSequence(event)).toBeNull();
  });
});
