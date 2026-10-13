import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

for (const [name, language] of Object.entries({ javascript, typescript, json, rust, python, bash, css, xml, yaml, markdown })) hljs.registerLanguage(name, language);
const extensions: Record<string, string> = { js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", json: "json", rs: "rust", py: "python", sh: "bash", bash: "bash", css: "css", html: "xml", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown" };
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** Resolve only relative text-document links; the service remains the realpath security boundary. */
export function localFileLink(source: string, href: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || /^[\/\\]/.test(decoded) || /[:\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  const parts = source.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export function HighlightedCode({ content, language }: { content: string; language?: string }) {
  // Bound synchronous highlighter work; large files remain readable/copyable as plain text.
  const html = useMemo(() => language && hljs.getLanguage(language) && content.length <= 100_000
    ? hljs.highlight(content, { language, ignoreIllegals: true }).value : undefined, [content, language]);
  return <code className="files-code" {...(html === undefined ? {} : { dangerouslySetInnerHTML: { __html: html } })}>{html === undefined ? content : undefined}</code>;
}

export const FileContent = memo(function FileContent({ path, content, rendered, onOpen }: { path: string; content: string; rendered: boolean; onOpen: (path: string) => void }) {
  const { t } = useTranslation();
  // Renderer functions are React component types. Recreating them on a menu
  // or progress update would remount code blocks and lose native scroll/selection.
  const components = useMemo<Components>(() => ({
      img: ({ alt }) => <span className="files-blocked-resource">[{t("files.imageBlocked")}{alt ? `: ${alt}` : ""}]</span>,
      a: ({ href, children }) => {
        const target = localFileLink(path, href ?? "");
        return target ? <button type="button" role="link" className="files-document-link" onClick={() => onOpen(target)}>{children}</button>
          : <span title={t("files.linkBlocked")}>{children} <small>({t("files.linkBlocked")})</small></span>;
      },
      pre: ({ children }) => <pre data-horizontal-scroll="true" tabIndex={0}>{children}</pre>,
      code: ({ className, children }) => <HighlightedCode content={String(children)} language={/language-([\w-]+)/.exec(className ?? "")?.[1]} />,
  }), [onOpen, path, t]);
  if (!rendered || !isMarkdown(path)) return <pre className="files-source" data-horizontal-scroll="true" tabIndex={0}><HighlightedCode content={content} language={extensions[path.split(".").pop()?.toLowerCase() ?? ""]} /></pre>;
  return <article className="files-markdown"><ReactMarkdown skipHtml components={components}>{content}</ReactMarkdown></article>;
});
