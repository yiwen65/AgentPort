// Native text edits for the raw editor. `execCommand("insertText")` is the
// only programmatic edit that enters the browser's undo stack, so replace
// actions use it and fall back to a caller-provided snapshot when the WebView
// does not support it.

export function replaceSelectionUndoable(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): boolean {
  if (typeof document.execCommand !== "function") return false;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

export function undoTextareaEdit(textarea: HTMLTextAreaElement): boolean {
  if (typeof document.execCommand !== "function") return false;
  textarea.focus({ preventScroll: true });
  try {
    return document.execCommand("undo");
  } catch {
    return false;
  }
}
