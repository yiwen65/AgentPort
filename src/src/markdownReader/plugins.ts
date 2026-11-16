// Remark plugins that add reader metadata to the mdast before it is converted
// to hast: GitHub alert callouts, heading ids/outline entries, stable image
// order, and math/frontmatter nodes that the renderer upgrades lazily.

import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import type { Blockquote, Heading, Root } from "mdast";
import type {
  Element,
  ElementContent,
  Properties,
  Root as HastRoot,
  RootContent as HastRootContent,
} from "hast";
import type { AlertType, MarkdownImageInfo, OutlineItem } from "./types";

const ALERT_PATTERN = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
const ALERT_TYPES: AlertType[] = ["note", "tip", "important", "warning", "caution"];

function mergeData(node: { data?: unknown }, patch: Record<string, unknown>): void {
  const data = node.data && typeof node.data === "object" ? (node.data as Record<string, unknown>) : {};
  node.data = { ...data, ...patch };
}

function mergeProperties(node: { data?: unknown }, patch: Record<string, unknown>): void {
  const data = node.data && typeof node.data === "object" ? (node.data as Record<string, unknown>) : {};
  const properties =
    data.hProperties && typeof data.hProperties === "object"
      ? (data.hProperties as Record<string, unknown>)
      : {};
  mergeData(node, { hProperties: { ...properties, ...patch } });
}

export function isAlertType(value: string): value is AlertType {
  return (ALERT_TYPES as string[]).includes(value);
}

/** `> [!NOTE]` (and the other GitHub alert markers) become typed callouts. */
export function remarkGithubAlerts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (!first || first.type !== "paragraph") return;
      const firstChild = first.children[0];
      if (!firstChild || firstChild.type !== "text") return;
      const match = ALERT_PATTERN.exec(firstChild.value);
      if (!match) return;
      const alert = match[1].toLowerCase();
      if (!isAlertType(alert)) return;
      firstChild.value = firstChild.value.slice(match[0].length).replace(/^\n/, "");
      if (!firstChild.value) first.children.shift();
      if (first.children.length === 0) node.children.shift();
      mergeData(node, {
        hName: "div",
        hProperties: {
          className: ["md-alert", `md-alert-${alert}`],
          "data-alert": alert,
        },
      });
    });
  };
}

/** Stable heading ids (GitHub slugs) plus the outline consumed by the TOC. */
export function remarkHeadingIds(options: { outline: OutlineItem[] }) {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, "heading", (node: Heading) => {
      const text = toString(node).trim();
      if (!text) return;
      const id = slugger.slug(text);
      mergeProperties(node, { id });
      options.outline.push({
        id,
        level: node.depth,
        text,
        line: node.position?.start.line ?? 1,
      });
    });
  };
}

/** Document-order image index after reference images have been resolved.
 * Assigning it on hast also covers `imageReference` nodes, which do not
 * exist as `image` nodes in the mdast tree. */
export function rehypeImageIndex(options: { images: MarkdownImageInfo[] }) {
  return (tree: HastRoot) => {
    let index = 0;
    const walk = (node: HastRootContent): void => {
      if (node.type !== "element") return;
      if (node.tagName === "img") {
        const source = typeof node.properties?.src === "string" ? node.properties.src : "";
        const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
        const title =
          typeof node.properties?.title === "string" ? node.properties.title : null;
        node.properties = { ...node.properties, "data-image-index": index };
        options.images.push({
          index,
          source,
          alt,
          title,
          line: node.position?.start.line ?? 1,
        });
        index += 1;
      }
      for (const child of node.children) walk(child);
    };
    for (const child of tree.children) walk(child);
  };
}

/* ------------------------- safe HTML -------------------------------- */

const SAFE_HTML_TAGS = new Set([
  "sub",
  "sup",
  "kbd",
  "mark",
  "small",
  "ins",
  "del",
  "u",
  "s",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "span",
  "abbr",
  "cite",
  "q",
  "br",
  "wbr",
  "details",
  "summary",
  "div",
  "p",
  "blockquote",
  "hr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "figure",
  "figcaption",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const VOID_HTML_TAGS = new Set(["br", "wbr", "hr"]);
const ATTRIBUTE =
  /\s*([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

type NodePosition = ElementContent["position"];

type HtmlToken =
  | { kind: "node"; node: ElementContent }
  | {
      kind: "open";
      name: string;
      properties: Properties;
      void: boolean;
      raw: string;
      position: NodePosition;
    }
  | { kind: "close"; name: string; raw: string; position: NodePosition }
  | { kind: "text"; value: string; position: NodePosition };

interface ScannedTag {
  name: string;
  raw: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: string;
  end: number;
}

function decodeEntities(value: string): string {
  return value.replace(ENTITY, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1].toLowerCase() === "x"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function scanTag(value: string, start: number): ScannedTag | null {
  let index = start + 1;
  const closing = value[index] === "/";
  if (closing) index += 1;
  const nameStart = index;
  while (/[a-z0-9-]/i.test(value[index] ?? "")) index += 1;
  if (index === nameStart) return null;
  const name = value.slice(nameStart, index).toLowerCase();
  let quote = "";
  let end = index;
  for (; end < value.length; end += 1) {
    const char = value[end];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") break;
  }
  if (end >= value.length) return null;
  const attributes = value.slice(index, end);
  if (closing && attributes.trim()) return null;
  return {
    name,
    raw: value.slice(start, end + 1),
    closing,
    selfClosing: !closing && /\/\s*$/.test(attributes),
    attributes,
    end: end + 1,
  };
}

function tagProperties(name: string, attributes: string): Properties {
  // Attributes other than `title` and the boolean `open` are dropped, so
  // event handlers, URLs and style never reach React.
  const properties: Properties = {};
  for (const attribute of attributes.matchAll(ATTRIBUTE)) {
    const attributeName = attribute[1].toLowerCase();
    if (attributeName === "title") {
      properties.title = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    } else if (attributeName === "open" && name === "details") {
      properties.open = true;
    }
  }
  return properties;
}

function positionAt(base: NodePosition, raw: string, offset: number): NodePosition {
  if (!base?.start.line) return undefined;
  let line = base.start.line;
  for (let index = 0; index < offset; index += 1) {
    if (raw[index] === "\n") line += 1;
  }
  const point = { line, column: 1, offset: (base.start.offset ?? 0) + offset };
  return { start: point, end: point };
}

function tokenizeRawHtml(value: string, position: NodePosition): HtmlToken[] | null {
  const tokens: HtmlToken[] = [];
  let index = 0;
  let textStart = 0;
  while (index < value.length) {
    if (value[index] !== "<") {
      index += 1;
      continue;
    }
    if (value.startsWith("<!--", index)) return null;
    const tag = scanTag(value, index);
    if (!tag || !SAFE_HTML_TAGS.has(tag.name)) return null;
    if (textStart < index) {
      tokens.push({
        kind: "text",
        value: decodeEntities(value.slice(textStart, index)),
        position: positionAt(position, value, textStart),
      });
    }
    if (tag.closing) {
      tokens.push({
        kind: "close",
        name: tag.name,
        raw: tag.raw,
        position: positionAt(position, value, index),
      });
    } else {
      tokens.push({
        kind: "open",
        name: tag.name,
        properties: tagProperties(tag.name, tag.attributes),
        void: VOID_HTML_TAGS.has(tag.name) || tag.selfClosing,
        raw: tag.raw,
        position: positionAt(position, value, index),
      });
    }
    index = tag.end;
    textStart = index;
  }
  if (textStart < value.length) {
    tokens.push({
      kind: "text",
      value: decodeEntities(value.slice(textStart)),
      position: positionAt(position, value, textStart),
    });
  }
  return tokens;
}

function findMatchingClose(tokens: HtmlToken[], from: number, name: string): number {
  let depth = 1;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "open" && !token.void && token.name === name) {
      depth += 1;
    } else if (token.kind === "close" && token.name === name) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseTokens(tokens: HtmlToken[], start: number, end: number): ElementContent[] {
  const result: ElementContent[] = [];
  let index = start;
  while (index < end) {
    const token = tokens[index];
    if (token.kind === "node") {
      result.push(token.node);
      index += 1;
      continue;
    }
    if (token.kind === "text") {
      if (token.value) {
        result.push({ type: "text", value: token.value, position: token.position });
      }
      index += 1;
      continue;
    }
    if (token.kind === "close") {
      result.push({ type: "raw", value: token.raw, position: token.position });
      index += 1;
      continue;
    }
    if (token.void) {
      result.push({
        type: "element",
        tagName: token.name,
        properties: token.properties,
        children: [],
        position: token.position,
      });
      index += 1;
      continue;
    }
    const close = findMatchingClose(tokens, index + 1, token.name);
    if (close < 0 || close >= end) {
      result.push({ type: "raw", value: token.raw, position: token.position });
      index += 1;
      continue;
    }
    const element: Element = {
      type: "element",
      tagName: token.name,
      properties: token.properties,
      children: parseTokens(tokens, index + 1, close),
      position: token.position,
    };
    result.push(element);
    index = close + 1;
  }
  return result;
}

function transformSafeHtml(children: ElementContent[]): ElementContent[] {
  const tokens: HtmlToken[] = [];
  for (const child of children) {
    if (child.type === "raw") {
      const parsed = tokenizeRawHtml(child.value, child.position);
      if (parsed) {
        tokens.push(...parsed);
      } else {
        tokens.push({ kind: "node", node: child });
      }
      continue;
    }
    if (child.type === "element") {
      child.children = transformSafeHtml(child.children);
    }
    tokens.push({ kind: "node", node: child });
  }
  return parseTokens(tokens, 0, tokens.length);
}

/** Render allowlisted inline and block HTML as real elements, including tags
 * split across raw nodes (an HTML block such as `<details>` followed by
 * Markdown content and a later `</details>`). Any raw node that contains an
 * unsupported tag stays a raw node, which the React renderer escapes, so
 * documents cannot inject scripts, links, images or event handlers. */
export function rehypeSafeHtml() {
  return (tree: HastRoot) => {
    tree.children = transformSafeHtml(tree.children as ElementContent[]);
  };
}

/** Math and frontmatter have no default mdast-to-hast handler; describe the
 * elements they should become so the React renderer can lazily upgrade them. */
export function remarkReaderNodes() {
  return (tree: Root) => {
    visit(tree, (node) => {
      const value = "value" in node && typeof node.value === "string" ? node.value : "";
      if (node.type === "inlineMath" || node.type === "math") {
        const display = node.type === "math";
        mergeData(node, {
          hName: display ? "div" : "span",
          hProperties: {
            className: [display ? "md-math-display" : "md-math-inline"],
            "data-tex": value,
            ...(node.position ? { "data-source-line": node.position.start.line } : {}),
          },
        });
        return;
      }
      if (node.type === "yaml") {
        // mdast-util-to-hast has an explicit `yaml: ignore` handler, so a
        // custom type is required for data.hName to take effect.
        (node as unknown as { type: string }).type = "readerYaml";
        mergeData(node, {
          hName: "div",
          hProperties: {
            className: ["md-frontmatter"],
            ...(node.position ? { "data-source-line": node.position.start.line } : {}),
          },
          hChildren: [{ type: "text", value }],
        });
      }
    });
  };
}
