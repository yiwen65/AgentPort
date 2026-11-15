// hast → React renderer. It never produces HTML strings; raw HTML nodes are
// rendered as text. Every source-text leaf is annotated with its original
// line so the preview selection can be quoted back as `path:line`.

import { createElement, type CSSProperties, type ReactNode } from "react";
import type { Element, Properties, Root as HastRoot, RootContent, Text as HastText } from "hast";
import MarkdownImage from "../components/MarkdownImage";
import MermaidBlock from "../components/MermaidBlock";
import CodeBlock from "./CodeBlock";
import Frontmatter from "./Frontmatter";
import MarkdownMath from "./Math";
import { isAlertType } from "./plugins";
import { resolveDocumentLink } from "./links";
import type { AlertType } from "./types";
import type { MarkdownReaderContextValue } from "./context";

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function propertiesOf(node: Element): Properties {
  return node.properties ?? {};
}

function property(node: Element, name: string): string | undefined {
  const value = propertiesOf(node)[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function numberProperty(node: Element, name: string): number | undefined {
  const value = propertiesOf(node)[name];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function classes(node: Element): string[] {
  const value: unknown = propertiesOf(node).className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function textOf(node: RootContent): string {
  if (node.type === "text" || node.type === "raw") return node.value;
  if (node.type !== "element") return "";
  return node.children.map(textOf).join("");
}

function elementProps(node: Element): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const id = property(node, "id");
  if (id) props.id = id;
  const className = classes(node).join(" ");
  if (className) props.className = className;
  const title = property(node, "title");
  if (title) props.title = title;
  const start = propertiesOf(node).start;
  if (typeof start === "number") props.start = start;
  for (const [name, value] of Object.entries(propertiesOf(node))) {
    if (name.startsWith("data-") || name.startsWith("aria-")) props[name] = value;
  }
  return props;
}

function codeContentStartLine(startLine: number, sourceLines: string[]): number {
  const line = sourceLines[startLine - 1] ?? "";
  return /^\s{0,3}(`{3,}|~{3,})/.test(line) ? startLine + 1 : startLine;
}

export function renderHast(root: HastRoot, context: MarkdownReaderContextValue): ReactNode {
  return root.children.map((child, index) => renderNode(child, `md${index}`, context));
}

function renderNode(
  node: RootContent,
  key: string,
  context: MarkdownReaderContextValue,
  inheritedLine?: number,
): ReactNode {
  if (node.type === "text") return renderText(node, key, context, inheritedLine);
  if (node.type === "raw") return renderRaw(node, key, context);
  if (node.type === "element") return renderElement(node, key, context, inheritedLine);
  return null;
}

function renderChildren(
  node: Element,
  key: string,
  context: MarkdownReaderContextValue,
  inheritedLine?: number,
): ReactNode[] {
  return node.children.map((child, index) =>
    renderNode(child, `${key}-${index}`, context, inheritedLine),
  );
}

function renderText(
  node: HastText,
  key: string,
  context: MarkdownReaderContextValue,
  inheritedLine?: number,
): ReactNode {
  const value = node.value;
  if (!value) return null;
  // Generated separator text (table rows, footnote wrappers) has no position;
  // rendering it as a span would also break table nesting.
  if (node.position?.start.line === undefined && value.trim() === "") return null;
  const line = node.position?.start.line ?? inheritedLine;
  if (!context.sourceLocations) return value.replace(/\n/g, " ");
  if (line === undefined) {
    return value.trim() === "" ? null : value.replace(/\n/g, " ");
  }
  const lines = value.split("\n");
  if (lines.length === 1) {
    return (
      <span key={key} data-source-line={line}>
        {value}
      </span>
    );
  }
  return lines.map((part, index) => (
    <span key={`${key}-l${index}`} data-source-line={line + index}>
      {part}
      {index < lines.length - 1 ? " " : ""}
    </span>
  ));
}

function renderRaw(
  node: { value: string; position?: HastText["position"] },
  key: string,
  context: MarkdownReaderContextValue,
): ReactNode {
  const line = node.position?.start.line;
  if (!context.sourceLocations || line === undefined) {
    return node.value.replace(/\n/g, " ");
  }
  const lines = node.value.split("\n");
  return lines.map((part, index) => (
    <span key={`${key}-l${index}`} data-source-line={line + index}>
      {part}
      {index < lines.length - 1 ? "\n" : ""}
    </span>
  ));
}

function renderElement(
  node: Element,
  key: string,
  context: MarkdownReaderContextValue,
  inheritedLine?: number,
): ReactNode {
  const tag = node.tagName;
  const line = node.position?.start.line ?? inheritedLine;
  const classNames = classes(node);
  const children = renderChildren(node, key, context, line);

  if (tag === "pre") return renderPre(node, key, context);
  if (tag === "a") return renderLink(node, key, context, children, line);
  if (tag === "img") return renderImage(node, key, context);
  if (HEADING_TAGS.has(tag)) return renderHeading(node, tag, key, context, children);
  if (tag === "table") {
    return (
      <div key={key} className="md-table-scroll">
        <table>{children}</table>
      </div>
    );
  }
  if (tag === "th" || tag === "td") {
    const align = property(node, "align");
    const style: CSSProperties | undefined =
      align === "left" || align === "center" || align === "right"
        ? { textAlign: align }
        : undefined;
    return createElement(tag, { key, ...elementProps(node), style }, children);
  }
  if (tag === "input") return renderInput(node, key);
  if (classNames.includes("md-math-inline") || classNames.includes("md-math-display")) {
    return renderMath(node, key, context, classNames.includes("md-math-display"));
  }
  if (classNames.includes("md-frontmatter")) {
    return renderFrontmatter(node, key, context);
  }
  if (classNames.includes("md-alert")) {
    return renderAlert(node, key, context, children);
  }
  if (
    tag === "section" &&
    (propertiesOf(node).dataFootnotes === true || propertiesOf(node)["data-footnotes"] === true)
  ) {
    return <section key={key} className="md-footnotes">{children}</section>;
  }
  return createElement(tag, { key, ...elementProps(node) }, children);
}

function renderPre(node: Element, key: string, context: MarkdownReaderContextValue): ReactNode {
  const codeChild = node.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  if (!codeChild) {
    return (
      <pre key={key} className={classes(node).join(" ") || undefined}>
        {renderChildren(node, key, context, node.position?.start.line)}
      </pre>
    );
  }
  const rawCode = textOf(codeChild);
  // mdast-util-to-hast appends one formatting newline to the code text.
  const code = rawCode.endsWith("\n") ? rawCode.slice(0, -1) : rawCode;
  const lang = classes(codeChild)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length) ?? "";
  const startLine = codeChild.position?.start.line ?? node.position?.start.line ?? 1;
  const contentStart = context.sourceLocations
    ? codeContentStartLine(startLine, context.sourceLines)
    : undefined;
  if (["mermaid", "flowchart"].includes(lang.toLowerCase())) {
    return <MermaidBlock key={key} source={code} sourceLine={contentStart} />;
  }
  return <CodeBlock key={key} code={code} lang={lang} sourceLine={contentStart} />;
}

function renderLink(
  node: Element,
  key: string,
  context: MarkdownReaderContextValue,
  children: ReactNode[],
  inheritedLine?: number,
): ReactNode {
  const href = property(node, "href") ?? "";
  const meaningful = node.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  const imageOnly =
    meaningful.length === 1 && meaningful[0].type === "element" && meaningful[0].tagName === "img";
  if (imageOnly) return renderChildren(node, key, context, inheritedLine);

  if (/^https?:\/\//i.test(href)) {
    return (
      <a key={key} className="md-link" href={href} data-href={href}>
        {children}
      </a>
    );
  }
  if (href.startsWith("#")) {
    let anchor = href.slice(1);
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      // Keep the raw fragment.
    }
    return (
      <a key={key} className="md-anchor-link" href={href} data-anchor={anchor}>
        {children}
      </a>
    );
  }
  if (context.linkContext) {
    const resolved = resolveDocumentLink(href, context.linkContext);
    if (resolved.kind === "external") {
      return (
        <a key={key} className="md-link" href={resolved.href} data-href={resolved.href}>
          {children}
        </a>
      );
    }
    if (resolved.kind === "document") {
      return (
        <a
          key={key}
          className="md-doc-link"
          href={href}
          data-doc-path={resolved.path}
          data-doc-line={resolved.line ?? undefined}
          data-doc-anchor={resolved.anchor ?? undefined}
        >
          {children}
        </a>
      );
    }
    if (resolved.kind === "unresolved" && resolved.reason === "outside-root") {
      return (
        <span key={key} className="md-link-blocked" data-tip={context.labels.linkOutsideRoot}>
          {literalLink(node, href)}
        </span>
      );
    }
  }
  return literalLink(node, href);
}

function literalLink(node: Element, href: string): string {
  const title = property(node, "title");
  return `[${textOf(node)}](${href}${title ? ` "${title}"` : ""})`;
}

function renderImage(node: Element, key: string, context: MarkdownReaderContextValue): ReactNode {
  const source = property(node, "src") ?? "";
  const alt = property(node, "alt") ?? "";
  const title = property(node, "title");
  const imageIndex = numberProperty(node, "data-image-index");
  const sourceLine = context.sourceLocations ? node.position?.start.line : undefined;
  return (
    <MarkdownImage
      key={key}
      source={source}
      alt={alt}
      title={title}
      imageIndex={imageIndex}
      sourceLine={sourceLine}
      session={context.imageSession}
    />
  );
}

function renderHeading(
  node: Element,
  tag: string,
  key: string,
  context: MarkdownReaderContextValue,
  children: ReactNode[],
): ReactNode {
  const id = property(node, "id");
  const classNames = classes(node);
  const footnoteLabel = classNames.includes("sr-only") || id === "footnote-label";
  const text = textOf(node).trim();
  const anchor =
    id && !footnoteLabel && context.onCopyHeadingLink ? (
      <button
        key={`${key}-anchor`}
        type="button"
        className="md-heading-anchor"
        aria-label={context.labels.copyHeadingLink}
        data-tip={context.labels.copyHeadingLink}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          context.onCopyHeadingLink?.(text, id);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6.2 9.8l3.6-3.6M7.1 4.6l.9-.9a2.6 2.6 0 013.7 3.7l-.9.9M8.9 11.4l-.9.9a2.6 2.6 0 01-3.7-3.7l.9-.9"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    ) : null;
  return createElement(tag, { key, ...(id ? { id } : {}) }, children, anchor);
}

function renderInput(node: Element, key: string): ReactNode {
  const type = property(node, "type");
  if (type === "checkbox") {
    return (
      <input
        key={key}
        type="checkbox"
        className="md-task-checkbox"
        disabled
        defaultChecked={propertiesOf(node).checked === true}
        data-search-skip="true"
      />
    );
  }
  return createElement("input", { key, ...elementProps(node) });
}

function renderMath(
  node: Element,
  key: string,
  context: MarkdownReaderContextValue,
  display: boolean,
): ReactNode {
  const tex = property(node, "data-tex") ?? property(node, "dataTex") ?? textOf(node);
  const sourceLine =
    numberProperty(node, "data-source-line") ?? node.position?.start.line;
  return (
    <MarkdownMath
      key={key}
      tex={tex}
      display={display}
      sourceLine={context.sourceLocations ? sourceLine : undefined}
    />
  );
}

function renderFrontmatter(node: Element, key: string, context: MarkdownReaderContextValue): ReactNode {
  const sourceLine =
    numberProperty(node, "data-source-line") ?? node.position?.start.line;
  return (
    <Frontmatter
      key={key}
      raw={textOf(node)}
      sourceLine={context.sourceLocations ? sourceLine : undefined}
    />
  );
}

function renderAlert(
  node: Element,
  key: string,
  context: MarkdownReaderContextValue,
  children: ReactNode[],
): ReactNode {
  const requested = property(node, "data-alert") ?? "note";
  const type: AlertType = isAlertType(requested) ? requested : "note";
  return (
    <div key={key} className={`md-alert md-alert-${type}`} data-alert={type}>
      <div className="md-alert-title" data-search-skip="true">
        <span className="md-alert-dot" aria-hidden="true" />
        {context.labels.alert[type]}
      </div>
      {children}
    </div>
  );
}
