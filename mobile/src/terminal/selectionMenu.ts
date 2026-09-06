import type { IBufferRange } from "@xterm/xterm";

interface Rect { left: number; top: number; width: number; height: number }

/** Position relative to the terminal section, above the visible selection when
 * possible, below it at the top edge, and always inside the visible surface. */
export function selectionMenuPosition(
  selection: IBufferRange,
  viewportY: number,
  cols: number,
  rows: number,
  screen: Rect,
  section: Rect,
  menu: { width: number; height: number },
) {
  if (cols <= 0 || rows <= 0 || screen.width <= 0 || screen.height <= 0) return;
  const lastRow = selection.end.y - (selection.end.x === 0 ? 1 : 0);
  if (lastRow < viewportY || selection.start.y >= viewportY + rows) return;
  const rowHeight = screen.height / rows;
  const cellWidth = screen.width / cols;
  const top = screen.top - section.top;
  const left = screen.left - section.left;
  const startRow = Math.max(0, selection.start.y - viewportY);
  const endRow = Math.min(rows - 1, lastRow - viewportY);
  const selectionTop = top + startRow * rowHeight;
  const selectionBottom = top + (endRow + 1) * rowHeight;
  const center = lastRow === selection.start.y
    ? left + (selection.start.x + (selection.end.x || cols)) / 2 * cellWidth
    : left + screen.width / 2;
  const minTop = Math.max(8, top);
  const maxBottom = Math.min(section.height - 8, top + screen.height);
  const above = selectionTop - menu.height - 8;
  const preferredTop = above >= minTop ? above : selectionBottom + 8;
  return {
    left: Math.max(8, Math.min(section.width - menu.width - 8, center - menu.width / 2)),
    top: Math.max(minTop, Math.min(maxBottom - menu.height, preferredTop)),
  };
}
