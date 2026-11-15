// Markdown preview container for the in-app document viewer. Parsing lives in
// ./markdownReader (unified/remark); this file keeps the public MarkdownView
// contract, the `.md-preview` root and the delegated link handling.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "./store";
import { MarkdownImageConsent } from "./components/MarkdownImage";
import { MarkdownReaderContext, type MarkdownReaderContextValue, type MarkdownReaderLabels } from "./markdownReader/context";
import { ImageViewerProvider } from "./markdownReader/imageViewer";
import { scrollToAnchor } from "./markdownReader/links";
import { parseMarkdown } from "./markdownReader/parse";
import { renderHast } from "./markdownReader/render";
import type { MarkdownViewProps } from "./markdownReader/types";

export type { MarkdownViewProps } from "./markdownReader/types";
export type { OutlineItem } from "./markdownReader/types";

/** Above this size the reader shows an instant source preview first: the
 * CommonMark parser can take seconds on pathological 1 MiB documents. */
const RICH_MARKDOWN_LIMIT = 256 * 1024;

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
  const codeLineNumbers = useStore((state) => state.docCodeLineNumbers);
  const [richRequested, setRichRequested] = useState(false);
  const [richRendering, setRichRendering] = useState(false);
  const richTimer = useRef<number | null>(null);
  const footnoteLabel = t("ui.document.footnotes");
  const large = source.length > RICH_MARKDOWN_LIMIT && !richRequested;
  const parsed = useMemo(() => {
    if (large) {
      return {
        tree: null,
        outline: [],
        images: [],
        hasRemoteImages: false,
        sourceLines: source.replace(/\r\n?/g, "\n").split("\n"),
      };
    }
    return parseMarkdown(source, {
      footnoteLabel,
      footnoteBackLabel: (referenceIndex: number) =>
        t("ui.document.footnoteBack", { index: referenceIndex }),
    });
  }, [large, source, footnoteLabel, t]);

  useEffect(() => {
    setRichRequested(false);
    setRichRendering(false);
    if (richTimer.current !== null) {
      window.clearTimeout(richTimer.current);
      richTimer.current = null;
    }
  }, [source]);

  useEffect(() => () => {
    if (richTimer.current !== null) window.clearTimeout(richTimer.current);
  }, []);

  const requestRichRendering = useCallback(() => {
    setRichRendering(true);
    if (richTimer.current !== null) window.clearTimeout(richTimer.current);
    // Let the status paint before the synchronous parser takes the thread.
    richTimer.current = window.setTimeout(() => {
      richTimer.current = null;
      setRichRequested(true);
    }, 30);
  }, []);

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

  const content = useMemo(() => {
    if (large) {
      return renderLargeSource(
        source,
        sourceLocations,
        {
          notice: t("ui.document.largeDocumentNotice"),
          render: t("ui.document.largeDocumentRender"),
          rendering: t("ui.document.largeDocumentRendering"),
        },
        richRendering,
        requestRichRendering,
      );
    }
    return parsed.tree
      ? renderHast(parsed.tree, readerContext)
      : renderFallback(source, sourceLocations, t("ui.document.parseError"));
  }, [
    large,
    parsed.tree,
    readerContext,
    source,
    sourceLocations,
    t,
    richRendering,
    requestRichRendering,
  ]);

  return (
    <MarkdownReaderContext.Provider value={readerContext}>
      <ImageViewerProvider theme={readingTheme}>
      <div
        ref={rootRef}
        className="md-preview"
        data-code-wrap={codeWrap ? "on" : "off"}
        data-code-line-numbers={codeLineNumbers ? "on" : "off"}
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
      </ImageViewerProvider>
    </MarkdownReaderContext.Provider>
  );
}

function renderLargeSource(
  source: string,
  sourceLocations: boolean,
  labels: { notice: string; render: string; rendering: string },
  rendering: boolean,
  onRender: () => void,
) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return (
    <>
      <div className="md-large-banner" role="status" data-search-skip="true">
        <span>{labels.notice}</span>
        <button type="button" className="btn small primary" onClick={onRender} disabled={rendering}>
          {rendering ? labels.rendering : labels.render}
        </button>
      </div>
      <pre className="md-large-source">
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
