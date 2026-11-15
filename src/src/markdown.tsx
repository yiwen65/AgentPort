// Markdown preview container for the in-app document viewer. Parsing lives in
// ./markdownReader (unified/remark); this file keeps the public MarkdownView
// contract, the `.md-preview` root and the delegated link handling.

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "./store";
import { MarkdownImageConsent } from "./components/MarkdownImage";
import { MarkdownReaderContext, type MarkdownReaderContextValue, type MarkdownReaderLabels } from "./markdownReader/context";
import { scrollToAnchor } from "./markdownReader/links";
import { parseMarkdown } from "./markdownReader/parse";
import { renderHast } from "./markdownReader/render";
import type { MarkdownViewProps } from "./markdownReader/types";

export type { MarkdownViewProps } from "./markdownReader/types";
export type { OutlineItem } from "./markdownReader/types";

/** Renders Markdown source to React nodes for the document preview pane. */
export function MarkdownView({
  source,
  sourceLocations = false,
  imageSession,
  linkContext,
  onLinkClick,
  onOpenDocument,
  onOutlineChange,
  onCopyText,
  onCopyHeadingLink,
  onNotice,
  readingTheme = "terminal",
}: MarkdownViewProps) {
  const { t } = useTranslation("shell");
  const rootRef = useRef<HTMLDivElement>(null);
  const codeWrap = useStore((state) => state.docCodeWrap);
  const footnoteLabel = t("ui.document.footnotes");
  const parsed = useMemo(
    () =>
      parseMarkdown(source, {
        footnoteLabel,
        footnoteBackLabel: (referenceIndex: number) =>
          t("ui.document.footnoteBack", { index: referenceIndex }),
      }),
    [source, footnoteLabel, t],
  );

  const labels = useMemo<MarkdownReaderLabels>(
    () => ({
      alert: {
        note: t("ui.document.alertNote"),
        tip: t("ui.document.alertTip"),
        important: t("ui.document.alertImportant"),
        warning: t("ui.document.alertWarning"),
        caution: t("ui.document.alertCaution"),
      },
      copyHeadingLink: t("ui.document.copyHeadingLink"),
      linkOutsideRoot: t("ui.document.linkOutsideRoot"),
    }),
    [t],
  );

  const readerContext = useMemo<MarkdownReaderContextValue>(
    () => ({
      sourceLocations,
      sourceLines: parsed.sourceLines,
      linkContext,
      imageSession,
      readingTheme,
      labels,
      onCopyText,
      onCopyHeadingLink,
      onOpenDocument,
    }),
    [
      sourceLocations,
      parsed.sourceLines,
      linkContext,
      imageSession,
      readingTheme,
      labels,
      onCopyText,
      onCopyHeadingLink,
      onOpenDocument,
    ],
  );

  useEffect(() => {
    onOutlineChange?.(parsed.outline);
  }, [onOutlineChange, parsed.outline]);

  const content = useMemo(
    () => (parsed.tree ? renderHast(parsed.tree, readerContext) : renderFallback(source, sourceLocations, t("ui.document.parseError"))),
    [parsed.tree, readerContext, source, sourceLocations, t],
  );

  return (
    <MarkdownReaderContext.Provider value={readerContext}>
      <div
        ref={rootRef}
        className="md-preview"
        data-code-wrap={codeWrap ? "on" : "off"}
        onClick={(event) => {
          const target = event.target as Element | null;
          const documentLink = target?.closest<HTMLAnchorElement>("a.md-doc-link");
          if (documentLink) {
            event.preventDefault();
            const path = documentLink.dataset.docPath;
            if (!path) return;
            const rawLine = documentLink.dataset.docLine;
            const parsedLine = rawLine ? Number.parseInt(rawLine, 10) : Number.NaN;
            onOpenDocument?.({
              path,
              line: Number.isSafeInteger(parsedLine) && parsedLine > 0 ? parsedLine : null,
              anchor: documentLink.dataset.docAnchor ?? null,
            });
            return;
          }
          const anchorLink = target?.closest<HTMLAnchorElement>("a.md-anchor-link");
          if (anchorLink) {
            event.preventDefault();
            const anchor = anchorLink.dataset.anchor;
            if (anchor && rootRef.current && !scrollToAnchor(rootRef.current, anchor)) {
              onNotice?.(t("ui.document.anchorMissing"));
            }
            return;
          }
          const externalLink = target?.closest<HTMLAnchorElement>("a.md-link");
          if (externalLink) {
            event.preventDefault();
            const href = externalLink.dataset.href ?? externalLink.getAttribute("href");
            if (href) onLinkClick?.(href);
          }
        }}
      >
        {parsed.hasRemoteImages && imageSession ? (
          <MarkdownImageConsent session={imageSession} />
        ) : null}
        {content}
      </div>
    </MarkdownReaderContext.Provider>
  );
}

function renderFallback(source: string, sourceLocations: boolean, notice: string) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return (
    <>
      <div className="md-parse-error" role="status" data-search-skip="true">
        {notice}
      </div>
      <pre className="md-parse-error-source">
        <code>
          {lines.map((line, index) => (
            <span
              key={index}
              {...(sourceLocations ? { "data-source-line": index + 1 } : {})}
            >
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </>
  );
}
