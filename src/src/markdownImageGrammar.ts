// Image-only extension to the desktop minimal renderer; no raw HTML parsing.
export type ImageReferences = Map<string, string>;
export interface MarkdownImageToken { start: number; end: number; source: string; alt: string }
const referenceKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
function unescapeMarkdown(value: string) { return value.replace(/\\([\\`*{}\[\]()#+.!_<> ])/g, "$1"); }
function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}
function closingDestination(text: string, start: number): number {
  let depth = 1;
  let angle = false;
  let quote = "";
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (angle) { if (char === ">") angle = false; continue; }
    if (char === "<") { angle = true; continue; }
    if ((char === '"' || char === "'") && /\s/.test(text[i - 1])) { quote = char; continue; }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return i;
  }
  return -1;
}
function destination(value: string): string | null {
  let text = value.trim();
  if (text.startsWith("<")) {
    const end = text.indexOf(">");
    if (end < 0 || !/^(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.test(text.slice(end + 1))) return null;
    text = text.slice(1, end);
  } else text = text.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
  return text ? unescapeMarkdown(text) : null;
}
export function extractImageReferences(source: string): { source: string; references: ImageReferences } {
  const references: ImageReferences = new Map();
  let fence = false;
  const lines = source.split("\n").map((line) => {
    if (/^```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    const match = /^\s{0,3}\[([^\]]+)\]:\s*(.+)\s*$/.exec(line);
    if (!match) return line;
    const target = destination(match[2]);
    if (!target) return line;
    const key = referenceKey(match[1]);
    if (!references.has(key)) references.set(key, target);
    return "";
  });
  return { source: lines.join("\n"), references };
}
export function markdownImageTokens(text: string, references: ImageReferences = new Map()): MarkdownImageToken[] {
  const tokens: MarkdownImageToken[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      let runEnd = i + 1;
      while (text[runEnd] === "`") runEnd++;
      const delimiter = text.slice(i, runEnd);
      const end = text.indexOf(delimiter, runEnd);
      if (end >= 0) { i = end + delimiter.length - 1; continue; }
    }
    const wrapped = text.startsWith("[![", i);
    const start = wrapped ? i + 1 : i;
    if (!text.startsWith("![", start)) continue;
    const altEnd = closing(text, start + 1, "[", "]");
    if (altEnd < 0) continue;
    const alt = unescapeMarkdown(text.slice(start + 2, altEnd));
    let end = altEnd + 1;
    let target: string | null = null;
    if (text[end] === "(") {
      const targetEnd = closingDestination(text, end);
      if (targetEnd < 0) continue;
      target = destination(text.slice(end + 1, targetEnd)); end = targetEnd + 1;
    } else if (text[end] === "[") {
      const referenceEnd = closing(text, end, "[", "]");
      if (referenceEnd < 0) continue;
      target = references.get(referenceKey(text.slice(end + 1, referenceEnd) || alt)) ?? null; end = referenceEnd + 1;
    } else target = references.get(referenceKey(alt)) ?? null;
    if (!target) continue;
    if (wrapped && text[end] === "]") {
      if (text[end + 1] === "(") { const wrapperEnd = closingDestination(text, end + 1); if (wrapperEnd >= 0) end = wrapperEnd + 1; }
      else if (text[end + 1] === "[") { const wrapperEnd = closing(text, end + 1, "[", "]"); if (wrapperEnd >= 0) end = wrapperEnd + 1; }
    }
    tokens.push({ start: i, end, source: target, alt }); i = end - 1;
  }
  return tokens;
}
