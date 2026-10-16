// Minimal, safe Markdown renderer for the in-app document viewer.
//
// It produces React nodes directly instead of an HTML string, so raw HTML in
// a document is always escaped by React. The feature set targets
// agent-generated reports: headings, paragraphs, emphasis, code, fences,
// lists, quotes, tables, rules and http(s) links.

import { createElement, Fragment, type ReactNode } from "react";
import MermaidBlock from "./components/MermaidBlock";
import MarkdownImage, { MarkdownImageConsent } from "./components/MarkdownImage";
import type { MarkdownImageSession } from "./markdownImages";
import { extractImageReferences, markdownImageTokens, type ImageReferences } from "./markdownImageGrammar";

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function sourceLineAt(text: string, line: number | undefined, offset: number): number | undefined {
  return line === undefined ? undefined : line + text.slice(0, offset).split("\n").length - 1;
}

/** Keep soft line breaks visually unchanged while retaining source provenance.
 * Split literal runs, not Markdown syntax: emphasis can span source lines. */
function renderLiteral(text: string, key: string, sourceLine?: number): ReactNode {
  if (sourceLine === undefined) return text.replace(/\n/g, " ");
  const lines = text.split("\n");
  return lines.map((line, index) => createElement("span", {
    key: `${key}-l${index}`, "data-source-line": sourceLine + index,
  }, line + (index < lines.length - 1 ? " " : "")));
}

/** Parses inline emphasis/code/links into React nodes. Raw markup remains escaped. */
function renderTextInline(text: string, keyPrefix: string, sourceLine?: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  INLINE_PATTERN.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  let line = sourceLine;
  const displayText = text.replace(/\n/g, " ");
  while ((match = INLINE_PATTERN.exec(displayText)) !== null) {
    const before = text.slice(last, match.index);
    if (before) nodes.push(renderLiteral(before, `${keyPrefix}-plain${index}`, line));
    line = sourceLineAt(before, line, before.length);
    const key = `${keyPrefix}-${index++}`;
    const [full, code, strongA, strongB, emA, emB, , linkText, href] = match;
    const matchIndex = match.index;
    const raw = text.slice(matchIndex, matchIndex + full.length);
    const literal = (value: string, prefix = 0) => renderLiteral(value, key, sourceLineAt(raw, line, prefix));
    if (code) {
      nodes.push(createElement("code", { key }, literal(raw.slice(1, -1), 1)));
    } else if (strongA || strongB) {
      nodes.push(createElement("strong", { key }, literal(raw.slice(2, -2), 2)));
    } else if (emA || emB) {
      nodes.push(createElement("em", { key }, literal(raw.slice(1, -1), 1)));
    } else if (linkText !== undefined && href !== undefined) {
      if (isSafeHref(href)) {
        nodes.push(
          createElement(
            "a",
            { key, href, className: "md-link", "data-href": href },
            literal(linkText ? raw.slice(1, 1 + linkText.length) : href, 1),
          ),
        );
      } else {
        // Non-http links (file:, javascript:, …) render as literal text.
        nodes.push(literal(raw));
      }
    }
    line = sourceLineAt(raw, line, raw.length);
    last = match.index + full.length;
  }
  if (last < text.length) nodes.push(renderLiteral(text.slice(last), `${keyPrefix}-end`, line));
  return nodes;
}

export function renderInline(text: string, keyPrefix: string, references: ImageReferences = new Map(), session?: MarkdownImageSession, sourceLine?: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let line = sourceLine;
  for (const [index, token] of markdownImageTokens(text.replace(/\n/g, " "), references).entries()) {
    nodes.push(...renderTextInline(text.slice(last, token.start), `${keyPrefix}-t${index}`, line));
    nodes.push(createElement(MarkdownImage, { key: `${keyPrefix}-image${index}`, source: token.source, alt: token.alt, session }));
    line = sourceLineAt(text.slice(last, token.end), line, token.end - last);
    last = token.end;
  }
  nodes.push(...renderTextInline(text.slice(last), `${keyPrefix}-tail`, line));
  return nodes;
}

type Block = (
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[]; itemLines: number[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" }
) & { line: number };

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
  let paragraphLine = 1;
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n"), line: paragraphLine });
      paragraph.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const sourceLine = i + 1;

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
      blocks.push({ kind: "code", lang: fence[1], lines: code, line: sourceLine });
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
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2], line: sourceLine });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule", line: sourceLine });
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
      blocks.push({ kind: "quote", lines: quote, line: sourceLine });
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      flushParagraph();
      const ordered = OL_ITEM.test(line);
      const pattern = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      const itemLines: number[] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        itemLines.push(i + 1);
        items.push(item[2]);
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !pattern.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ kind: "list", ordered, items, itemLines, line: sourceLine });
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
      blocks.push({ kind: "table", header, rows, line: sourceLine });
      continue;
    }

    if (paragraph.length === 0) paragraphLine = sourceLine;
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

function renderBlocks(blocks: Block[], references: ImageReferences, session?: MarkdownImageSession, sourceLocations = false): ReactNode[] {
  const inline = (text: string, key: string, line: number) => renderInline(text, key, references, session, sourceLocations ? line : undefined);
  return blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.kind) {
      case "heading":
        return createElement(
          `h${block.level}` as "h1",
          { key },
          inline(block.text, key, block.line),
        );
      case "paragraph":
        return createElement("p", { key }, inline(block.text, key, block.line));
      case "code":
        // Diagram fences render as images; everything else stays code.
        if (["mermaid", "flowchart"].includes(block.lang.toLowerCase())) {
          return createElement(MermaidBlock, { key, source: block.lines.join("\n"), sourceLine: sourceLocations ? block.line + 1 : undefined });
        }
        return createElement(
          "pre",
          { key, "data-lang": block.lang || undefined },
          createElement("code", null, sourceLocations ? block.lines.map((line, index) => createElement("span", {
            key: `${key}-l${index}`, "data-source-line": block.line + 1 + index,
          }, line + (index < block.lines.length - 1 ? "\n" : ""))) : block.lines.join("\n")),
        );
      case "quote":
        return createElement(
          "blockquote",
          { key },
          block.lines.map((line, i) =>
            createElement(
              "p",
              { key: `${key}-q${i}` },
              inline(line, `${key}-q${i}`, block.line + i),
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
              inline(item, `${key}-i${i}`, block.itemLines[i]),
            ),
          ),
        );
      case "table":
        return createElement(
          "table",
          { key, className: [...block.header, ...block.rows.flat()].some((cell) => markdownImageTokens(cell, references).length > 0) ? "md-image-table" : undefined },
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
                  inline(cell, `${key}-h${i}`, block.line),
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
                    inline(cell, `${key}-r${r}c${c}`, block.line + 2 + r),
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
  imageSession,
  sourceLocations = false,
}: {
  source: string;
  sourceLocations?: boolean;
  onLinkClick?: (href: string) => void;
  imageSession?: MarkdownImageSession;
}) {
  const parsed = extractImageReferences(source);
  const blockData = parseBlocks(parsed.source);
  const blocks = renderBlocks(blockData, parsed.references, imageSession, sourceLocations);
  const hasRemoteImages = blockData.some((block) => {
    const texts = block.kind === "code" || block.kind === "rule" ? [] : "text" in block ? [block.text] : block.kind === "table" ? [...block.header, ...block.rows.flat()] : block.kind === "list" ? block.items : block.lines;
    return texts.some((text) => markdownImageTokens(text.replace(/\n/g, " "), parsed.references).some((token) => /^https:\/\//i.test(token.source)));
  });
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
      {hasRemoteImages && imageSession ? <MarkdownImageConsent session={imageSession} /> : null}
      {blocks.length ? blocks : <Fragment />}
    </div>
  );
}
