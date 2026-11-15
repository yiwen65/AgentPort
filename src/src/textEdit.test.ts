// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSelectionUndoable, undoTextareaEdit } from "./textEdit";

const original = document.execCommand;

afterEach(() => {
  if (original) {
    Object.defineProperty(document, "execCommand", { configurable: true, value: original });
  } else {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  }
});

describe("textEdit", () => {
  it("routes replacements and undo through execCommand when available", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.append(textarea);
    const exec = vi.fn((command: string) => command === "insertText" || command === "undo");
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });

    expect(replaceSelectionUndoable(textarea, 0, 5, "bye")).toBe(true);
    expect(exec).toHaveBeenCalledWith("insertText", false, "bye");
    expect(undoTextareaEdit(textarea)).toBe(true);
    expect(exec).toHaveBeenCalledWith("undo");
    textarea.remove();
  });
});
