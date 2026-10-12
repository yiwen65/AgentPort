// Copy-selection resolution for live-TUI sessions (fullscreen agents with
// mouse reporting): xterm drops a selection as soon as a redraw touches it,
// so the pane context menu falls back to the freshest captured selection
// within a bounded TTL. Kept in its own module so component tests that mock
// ../terminals wholesale are unaffected.

import type { TermHandle } from "./terminals";

/** Milliseconds a captured selection stays copyable after a live-TUI redraw
 * erased it — covers the select → right-click → menu-open round trip even
 * with a pause in between. */
export const COPY_SELECTION_CAPTURE_TTL_MS = 30_000;

/** Resolve the text a Copy action should use: the live xterm selection when
 * present, otherwise the most recent captured selection while it is fresh. */
export function resolveCopySelection(
  handle: Pick<TermHandle, "term" | "lastSelectionText" | "lastSelectionAt"> | undefined,
  now = Date.now(),
): string {
  if (!handle) return "";
  const live = handle.term.getSelection();
  if (live) return live;
  const captured = handle.lastSelectionText;
  if (captured && now - handle.lastSelectionAt <= COPY_SELECTION_CAPTURE_TTL_MS) {
    return captured;
  }
  return "";
}
