import { computeLineRange } from "./terminalDrop";

/** Resolve an ordered DOM selection without searching its text in the file.
 * Preview Markdown text runs carry their original source line; plain prose
 * preserves source text verbatim, so DOM prefix lengths give exact offsets. */
export function previewSelectionLineRange(
  root: Element,
  range: Range,
  plainSource?: string,
): { startLine: number; endLine: number } | null {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  if (plainSource !== undefined) {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return computeLineRange(plainSource, start, prefix.toString().length);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let startLine = Infinity;
  let endLine = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.textContent?.length ?? 0;
    // Merely touching the start of the next line does not select that line.
    if (end <= start) continue;
    const marker = node.parentElement?.closest<HTMLElement>("[data-source-line]");
    const line = Number(marker?.dataset.sourceLine);
    // Ignore preview controls (image consent/retry, diagram tools), not source text.
    if (!Number.isSafeInteger(line) || line < 1) continue;
    startLine = Math.min(startLine, line);
    endLine = Math.max(endLine, line);
  }
  return endLine > 0 ? { startLine, endLine } : null;
}
