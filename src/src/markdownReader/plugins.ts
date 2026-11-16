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

/* --------------------- safe inline HTML ------------------------------- */

const SAFE_INLINE_TAGS = new Set([
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
]);
const VOID_INLINE_TAGS = new Set(["br", "wbr"]);
const OPEN_TAG = /^<([a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>$/i;
const CLOSE_TAG = /^<\/([a-z][a-z0-9]*)\s*>$/i;
const ATTRIBUTE = /([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

interface OpenTag {
  name: string;
  properties: Properties;
  void: boolean;
}

function parseOpenTag(value: string): OpenTag | null {
  const match = OPEN_TAG.exec(value);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!SAFE_INLINE_TAGS.has(name)) return null;
  // Keep only presentation-free attributes; event handlers and URLs never
  // reach React. `title` is the only attribute the reader styles.
  const properties: Properties = {};
  for (const attribute of match[2].matchAll(ATTRIBUTE)) {
    if (attribute[1].toLowerCase() === "title") {
      properties.title = attribute[2] ?? attribute[3] ?? "";
    }
  }
  return { name, properties, void: VOID_INLINE_TAGS.has(name) || /\/>$/.test(value) };
}

function findCloseTag(children: ElementContent[], from: number, name: string): number {
  let depth = 1;
  for (let index = from; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== "raw") continue;
    const close = CLOSE_TAG.exec(child.value);
    if (close && close[1].toLowerCase() === name) {
      depth -= 1;
      if (depth === 0) return index;
      continue;
    }
    const open = parseOpenTag(child.value);
    if (open && !open.void && open.name === name) depth += 1;
  }
  return -1;
}

function transformInlineHtml(children: ElementContent[]): ElementContent[] {
  const result: ElementContent[] = [];
  let index = 0;
  while (index < children.length) {
    const child = children[index];
    const open = child.type === "raw" ? parseOpenTag(child.value) : null;
    if (open) {
      if (open.void) {
        result.push({
          type: "element",
          tagName: open.name,
          properties: open.properties,
          children: [],
          position: child.position,
        });
        index += 1;
        continue;
      }
      const close = findCloseTag(children, index + 1, open.name);
      if (close >= 0) {
        const nested = transformInlineHtml(children.slice(index + 1, close));
        const element: Element = {
          type: "element",
          tagName: open.name,
          properties: open.properties,
          children: nested,
          position: child.position,
        };
        result.push(element);
        index = close + 1;
        continue;
      }
    }
    if (child.type === "element") {
      child.children = transformInlineHtml(child.children);
    }
    result.push(child);
    index += 1;
  }
  return result;
}

/** Render a narrow allowlist of inline HTML (`<sub>`, `<kbd>`, `<br>`, …) as
 * real elements. Everything else stays a raw node, which the React renderer
 * shows as escaped text, so documents cannot inject scripts, links, images or
 * event handlers. */
export function rehypeSafeInlineHtml() {
  return (tree: HastRoot) => {
    tree.children = transformInlineHtml(tree.children as ElementContent[]);
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
