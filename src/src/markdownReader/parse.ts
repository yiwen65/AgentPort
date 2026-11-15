// Synchronous Markdown parsing for the document reader. The pipeline emits
// hast (never an HTML string); raw HTML is kept as raw nodes so the React
// renderer can show it as escaped text, preserving the viewer's safety model.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import type { Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import {
  rehypeImageIndex,
  remarkGithubAlerts,
  remarkHeadingIds,
  remarkReaderNodes,
} from "./plugins";
import type { MarkdownImageInfo, OutlineItem, ParsedMarkdown } from "./types";

export interface ParseMarkdownOptions {
  footnoteLabel: string;
  footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number) => string;
}

/* ------------------- image destination compatibility ------------------- */

/** Earlier builds accepted `![alt](path with spaces.png)` even though
 * CommonMark requires angle brackets. Wrap only those destinations, outside
 * fenced and inline code, so agent-authored reports keep rendering. The
 * rewrite never adds or removes lines, so source line mapping is unchanged. */
export function normalizeImageDestinations(source: string): string {
  const lines = source.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (marker) {
      const next = { char: marker[1][0], length: marker[1].length };
      if (!fence) fence = next;
      else if (fence.char === next.char && next.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    lines[index] = normalizeImageLine(lines[index]);
  }
  return lines.join("\n");
}

function normalizeImageLine(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") {
      out += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      let runEnd = index + 1;
      while (line[runEnd] === "`") runEnd += 1;
      const delimiter = line.slice(index, runEnd);
      const close = line.indexOf(delimiter, runEnd);
      if (close >= 0) {
        out += line.slice(index, close + delimiter.length);
        index = close + delimiter.length;
        continue;
      }
      out += delimiter;
      index = runEnd;
      continue;
    }
    if (char === "!" && line[index + 1] === "[") {
      const altEnd = closingBracket(line, index + 1);
      if (altEnd >= 0 && line[altEnd + 1] === "(") {
        const destEnd = closingParen(line, altEnd + 1);
        if (destEnd >= 0) {
          out += `${line.slice(index, altEnd + 2)}${wrapDestination(line.slice(altEnd + 2, destEnd))})`;
          index = destEnd + 1;
          continue;
        }
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return index;
  }
  return -1;
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  let angle = false;
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (angle) {
      if (char === ">") angle = false;
      continue;
    }
    if (char === "<") {
      angle = true;
      continue;
    }
    if ((char === '"' || char === "'") && /\s/.test(text[index - 1] ?? "")) {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function wrapDestination(inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed || trimmed.startsWith("<")) return inner;
  const title = /^([\s\S]*?)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))\s*$/.exec(trimmed);
  const path = (title ? title[1] : trimmed).trim();
  if (!/\s/.test(path) || path.includes("<") || path.includes(">")) return inner;
  return `<${path}>${title ? title[2] : ""}`;
}

/* ----------------------------- pipeline ------------------------------- */

export function parseMarkdown(source: string, options: ParseMarkdownOptions): ParsedMarkdown {
  const normalized = source.replace(/\r\n?/g, "\n");
  const sourceLines = normalized.split("\n");
  const outline: OutlineItem[] = [];
  const images: MarkdownImageInfo[] = [];
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter)
      .use(remarkMath)
      .use(remarkGithubAlerts)
      .use(remarkHeadingIds, { outline })
      .use(remarkReaderNodes)
      .use(remarkRehype, {
        allowDangerousHtml: true,
        footnoteLabel: options.footnoteLabel,
        footnoteBackLabel: options.footnoteBackLabel,
      })
      .use(rehypeImageIndex, { images });
    const tree = processor.runSync(
      processor.parse(normalizeImageDestinations(normalized)) as MdastRoot,
    ) as HastRoot;
    return {
      tree,
      outline,
      images,
      hasRemoteImages: images.some((image) => /^https:\/\//i.test(image.source)),
      sourceLines,
    };
  } catch {
    return { tree: null, outline, images, hasRemoteImages: false, sourceLines };
  }
}
