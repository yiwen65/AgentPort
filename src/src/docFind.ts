// In-document search helpers. Preview matches are represented as Ranges over
// the rendered text nodes; the viewer paints them in a read-only overlay so
// React never fights DOM mutations (Shiki swaps, StrictMode, images).

const MAX_MATCHES = 2000;

export interface FindTextNode {
  node: Text;
  start: number;
  end: number;
}

export interface FindTextMap {
  text: string;
  nodes: FindTextNode[];
}

const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, .md-code-line, .md-frontmatter";

/** Concatenate searchable source text in document order. Blocks are joined
 * with a newline so a query cannot match across paragraph boundaries. */
export function buildFindText(root: HTMLElement): FindTextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: FindTextNode[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest("[data-search-skip]")) continue;
    if (!parent.closest("[data-source-line]")) continue;
    const block = parent.closest(BLOCK_SELECTOR) ?? parent;
    if (previousBlock && block !== previousBlock) text += "\n";
    previousBlock = block;
    const value = node.nodeValue ?? "";
    nodes.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, nodes };
}

export function findMatchesIn(text: string, query: string, limit = MAX_MATCHES): number[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  const matches: number[] = [];
  let from = 0;
  while (matches.length < limit) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    matches.push(found);
    from = found + Math.max(1, needle.length);
  }
  return matches;
}

/** Raw textarea search (line-oriented text, no DOM mapping). */
export function findTextOccurrences(text: string, query: string, limit = MAX_MATCHES): number[] {
  return findMatchesIn(text, query, limit);
}

export interface TextPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RawMatchPosition extends TextPosition {
  start: number;
}

/** Content-box geometry for raw-editor matches. The raw textarea has
 * `wrap="off"`, so every match stays on one visual line. All matches on a
 * line share one measured text node; Range rects account for tabs and CJK. */
export function rawMatchMetricsBatch(
  textarea: HTMLTextAreaElement,
  text: string,
  starts: number[],
  length: number,
): RawMatchPosition[] {
  const style = window.getComputedStyle(textarea);
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.55;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const measurer = document.createElement("span");
  measurer.style.position = "absolute";
  measurer.style.left = "0";
  measurer.style.top = "0";
  measurer.style.visibility = "hidden";
  measurer.style.pointerEvents = "none";
  measurer.style.whiteSpace = "pre";
  measurer.style.fontFamily = style.fontFamily;
  measurer.style.fontSize = style.fontSize;
  measurer.style.fontWeight = style.fontWeight;
  measurer.style.fontStyle = style.fontStyle;
  measurer.style.letterSpacing = style.letterSpacing;
  measurer.style.wordSpacing = style.wordSpacing;
  measurer.style.tabSize = style.tabSize || "8";
  const textNode = document.createTextNode("");
  measurer.append(textNode);
  document.body.append(measurer);
  const origin = measurer.getBoundingClientRect().left;
  const ordered = [...starts].sort((a, b) => a - b);
  const results: RawMatchPosition[] = [];
  let lineStart = 0;
  let lineEnd = text.indexOf("\n");
  if (lineEnd < 0) lineEnd = text.length;
  let lineIndex = 0;
  let loadedLine = -1;
  for (const start of ordered) {
    if (start < 0 || start > text.length) continue;
    while (start > lineEnd && lineEnd < text.length) {
      lineStart = lineEnd + 1;
      lineIndex += 1;
      lineEnd = text.indexOf("\n", lineStart);
      if (lineEnd < 0) lineEnd = text.length;
    }
    if (lineStart !== loadedLine) {
      textNode.nodeValue = text.slice(lineStart, lineEnd);
      loadedLine = lineStart;
    }
    const lineLength = textNode.nodeValue?.length ?? 0;
    const from = Math.max(0, Math.min(start - lineStart, lineLength));
    const to = Math.max(from, Math.min(start - lineStart + length, lineLength));
    const range = document.createRange();
    range.setStart(textNode, from);
    range.setEnd(textNode, to);
    const rect =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : { left: 0, width: 0 };
    results.push({
      start,
      left: paddingLeft + rect.left - origin,
      top: paddingTop + lineIndex * lineHeight,
      width: Math.max(1, rect.width),
      height: lineHeight,
    });
  }
  measurer.remove();
  return results;
}

/** Content-box geometry for one raw-editor match. */
export function rawMatchMetrics(
  textarea: HTMLTextAreaElement,
  text: string,
  start: number,
  length: number,
): TextPosition | null {
  return rawMatchMetricsBatch(textarea, text, [start], length)[0] ?? null;
}

/** Replace every case-insensitive occurrence without overlapping. */
export function replaceAllOccurrences(
  text: string,
  query: string,
  replacement: string,
): { text: string; count: number } {
  const needle = query.toLocaleLowerCase();
  if (!needle) return { text, count: 0 };
  const haystack = text.toLocaleLowerCase();
  let result = "";
  let cursor = 0;
  let count = 0;
  let found = haystack.indexOf(needle, cursor);
  while (found >= 0) {
    result += text.slice(cursor, found) + replacement;
    cursor = found + query.length;
    count += 1;
    found = haystack.indexOf(needle, cursor);
  }
  result += text.slice(cursor);
  return { text: result, count };
}

function nodeAt(nodes: FindTextNode[], offset: number, end: boolean): FindTextNode | null {
  let low = 0;
  let high = nodes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = nodes[middle];
    if (offset < entry.start) {
      high = middle - 1;
    } else if (offset > entry.end) {
      low = middle + 1;
    } else if (offset === entry.end && !end && middle + 1 < nodes.length && nodes[middle + 1].start === offset) {
      return nodes[middle + 1];
    } else {
      return entry;
    }
  }
  return null;
}

/** DOM Range for the match starting at `start` in the concatenated text. */
export function rangeForMatch(
  map: FindTextMap,
  start: number,
  length: number,
): Range | null {
  const startNode = nodeAt(map.nodes, start, false);
  const endNode = nodeAt(map.nodes, start + length, true);
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode.node, start - startNode.start);
    range.setEnd(endNode.node, start + length - endNode.start);
  } catch {
    return null;
  }
  return range;
}
