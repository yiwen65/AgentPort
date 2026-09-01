// Minimal, safe Markdown renderer for the in-app document viewer.
//
// It produces React nodes directly instead of an HTML string, so raw HTML in
// a document is always escaped by React. The feature set targets
// agent-generated reports: headings, paragraphs, emphasis, code, fences,
// lists, quotes, tables, rules and http(s) links.

import { createElement, Fragment, type ReactNode } from "react";
import MermaidBlock from "./components/MermaidBlock";

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Parses inline emphasis/code/links into React nodes. Plain text passes
 * through untouched, so raw markup is always rendered literally. */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  INLINE_PATTERN.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${index++}`;
    const [full, code, strongA, strongB, emA, emB, , linkText, href] = match;
    if (code) {
      nodes.push(createElement("code", { key }, code.slice(1, -1)));
    } else if (strongA || strongB) {
      nodes.push(createElement("strong", { key }, full.slice(2, -2)));
    } else if (emA || emB) {
      nodes.push(createElement("em", { key }, full.slice(1, -1)));
    } else if (linkText !== undefined && href !== undefined) {
      if (isSafeHref(href)) {
        nodes.push(
          createElement(
            "a",
            { key, href, className: "md-link", "data-href": href },
            linkText || href,
          ),
        );
      } else {
        // Non-http links (file:, javascript:, …) render as literal text.
        nodes.push(full);
      }
    }
    last = match.index + full.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (or run off the end)
      blocks.push({ kind: "code", lang: fence[1], lines: code });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length) {
        const item = QUOTE.exec(lines[i]);
        if (!item) break;
        quote.push(item[1]);
        i += 1;
      }
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      flushParagraph();
      const ordered = OL_ITEM.test(line);
      const pattern = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        items.push(item[2]);
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !pattern.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Pipe table: a header row followed by a separator row.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1])
    ) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.kind) {
      case "heading":
        return createElement(
          `h${block.level}` as "h1",
          { key },
          renderInline(block.text, key),
        );
      case "paragraph":
        return createElement("p", { key }, renderInline(block.text, key));
      case "code":
        // Diagram fences render as images; everything else stays code.
        if (["mermaid", "flowchart"].includes(block.lang.toLowerCase())) {
          return createElement(MermaidBlock, { key, source: block.lines.join("\n") });
        }
        return createElement(
          "pre",
          { key, "data-lang": block.lang || undefined },
          createElement("code", null, block.lines.join("\n")),
        );
      case "quote":
        return createElement(
          "blockquote",
          { key },
          block.lines.map((line, i) =>
            createElement(
              "p",
              { key: `${key}-q${i}` },
              renderInline(line, `${key}-q${i}`),
            ),
          ),
        );
      case "list":
        return createElement(
          block.ordered ? "ol" : "ul",
          { key },
          block.items.map((item, i) =>
            createElement(
              "li",
              { key: `${key}-i${i}` },
              renderInline(item, `${key}-i${i}`),
            ),
          ),
        );
      case "table":
        return createElement(
          "table",
          { key },
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              block.header.map((cell, i) =>
                createElement(
                  "th",
                  { key: `${key}-h${i}` },
                  renderInline(cell, `${key}-h${i}`),
                ),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            block.rows.map((row, r) =>
              createElement(
                "tr",
                { key: `${key}-r${r}` },
                row.map((cell, c) =>
                  createElement(
                    "td",
                    { key: `${key}-r${r}c${c}` },
                    renderInline(cell, `${key}-r${r}c${c}`),
                  ),
                ),
              ),
            ),
          ),
        );
      case "rule":
        return createElement("hr", { key });
    }
  });
}

/** Renders Markdown source to React nodes for the document preview pane. */
export function MarkdownView({
  source,
  onLinkClick,
}: {
  source: string;
  onLinkClick?: (href: string) => void;
}) {
  const blocks = renderBlocks(parseBlocks(source));
  return (
    <div
      className="md-preview"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a.md-link");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute("data-href");
        if (href) onLinkClick?.(href);
      }}
    >
      {blocks.length ? blocks : <Fragment />}
    </div>
  );
}
