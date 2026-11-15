// Remark plugins that add reader metadata to the mdast before it is converted
// to hast: GitHub alert callouts, heading ids/outline entries, stable image
// order, and math/frontmatter nodes that the renderer upgrades lazily.

import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import type { Blockquote, Heading, Image, Root } from "mdast";
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

/** Document-order image index; used by the shared lightbox navigation. */
export function remarkImageIndex(options: { images: MarkdownImageInfo[] }) {
  return (tree: Root) => {
    visit(tree, "image", (node: Image) => {
      const index = options.images.length;
      const info: MarkdownImageInfo = {
        index,
        source: node.url,
        alt: node.alt ?? "",
        title: node.title ?? null,
        line: node.position?.start.line ?? 1,
      };
      options.images.push(info);
      mergeProperties(node, { "data-image-index": index });
    });
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
