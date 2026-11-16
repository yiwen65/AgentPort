// Render a fixed allowlist of formatting-only HTML as real elements. Any raw
// node that contains an unsupported tag stays raw and is later shown as
// escaped text, so scripts, links, images and event handlers never reach React.

import type { Element, Properties, Root, Text } from "hast";

type Raw = { type: "raw"; value: string };
type Content = Element | Text | Raw;

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
const ATTRIBUTE = /\s*([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

type HtmlToken =
  | { kind: "node"; node: Content }
  | { kind: "open"; name: string; properties: Properties; void: boolean; raw: string }
  | { kind: "close"; name: string; raw: string }
  | { kind: "text"; value: string };

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

function tokenizeRawHtml(value: string): HtmlToken[] | null {
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
      tokens.push({ kind: "text", value: decodeEntities(value.slice(textStart, index)) });
    }
    if (tag.closing) {
      tokens.push({ kind: "close", name: tag.name, raw: tag.raw });
    } else {
      tokens.push({
        kind: "open",
        name: tag.name,
        properties: tagProperties(tag.name, tag.attributes),
        void: VOID_HTML_TAGS.has(tag.name) || tag.selfClosing,
        raw: tag.raw,
      });
    }
    index = tag.end;
    textStart = index;
  }
  if (textStart < value.length) {
    tokens.push({ kind: "text", value: decodeEntities(value.slice(textStart)) });
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

function parseTokens(tokens: HtmlToken[], start: number, end: number): Content[] {
  const result: Content[] = [];
  let index = start;
  while (index < end) {
    const token = tokens[index];
    if (token.kind === "node") {
      result.push(token.node);
      index += 1;
      continue;
    }
    if (token.kind === "text") {
      if (token.value) result.push({ type: "text", value: token.value });
      index += 1;
      continue;
    }
    if (token.kind === "close") {
      result.push({ type: "raw", value: token.raw });
      index += 1;
      continue;
    }
    if (token.void) {
      result.push({
        type: "element",
        tagName: token.name,
        properties: token.properties,
        children: [],
      });
      index += 1;
      continue;
    }
    const close = findMatchingClose(tokens, index + 1, token.name);
    if (close < 0 || close >= end) {
      result.push({ type: "raw", value: token.raw });
      index += 1;
      continue;
    }
    result.push({
      type: "element",
      tagName: token.name,
      properties: token.properties,
      children: parseTokens(tokens, index + 1, close) as Element["children"],
    });
    index = close + 1;
  }
  return result;
}

function transformSafeHtml(children: Content[]): Content[] {
  const tokens: HtmlToken[] = [];
  for (const child of children) {
    if (child.type === "raw") {
      const parsed = tokenizeRawHtml(child.value);
      if (parsed) {
        tokens.push(...parsed);
      } else {
        tokens.push({ kind: "node", node: child });
      }
      continue;
    }
    if (child.type === "element") {
      child.children = transformSafeHtml(child.children as Content[]) as Element["children"];
    }
    tokens.push({ kind: "node", node: child });
  }
  return parseTokens(tokens, 0, tokens.length);
}

/** Convert allowlisted inline and block HTML into real elements, including tags
 * split across raw nodes (an HTML block such as `<details>` followed by
 * Markdown content and a later `</details>`). Unsupported fragments stay raw,
 * which React Markdown renders as escaped text. */
export function rehypeSafeHtml() {
  return (tree: Root) => {
    tree.children = transformSafeHtml(tree.children as Content[]) as Root["children"];
  };
}
