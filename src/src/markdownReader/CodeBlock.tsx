// Fenced code block with lazy Shiki highlighting and reader controls.
// Source lines stay one-by-one annotated so preview selections still map to
// the file; line numbers are CSS-generated and never enter the text content.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ThemedToken } from "@shikijs/types";
import { setDocCodeLineNumbers, setDocCodeWrap } from "../docReadingPrefs";
import { useStore } from "../store";
import type { CodeThemeName } from "./codeHighlighter";
import { useMarkdownReader } from "./context";

const TEST_ENVIRONMENT =
  (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test";

function codeThemeFor(
  readingTheme: "terminal" | "paper" | "night",
  effective: "light" | "dark",
): CodeThemeName {
  if (readingTheme === "paper") return "min-light";
  if (readingTheme === "night") return "vitesse-dark";
  return effective === "dark" ? "github-dark-default" : "github-light-default";
}

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  const flags = token.fontStyle ?? 0;
  if (flags & 1) style.fontStyle = "italic";
  if (flags & 2) style.fontWeight = 600;
  if (flags & 4) style.textDecoration = "underline";
  return Object.keys(style).length > 0 ? style : undefined;
}

export default function CodeBlock({
  code,
  lang,
  sourceLine,
}: {
  code: string;
  lang: string;
  sourceLine?: number;
}) {
  const { t } = useTranslation("shell");
  const reader = useMarkdownReader();
  const lineNumbers = useStore((state) => state.docCodeLineNumbers);
  const wrap = useStore((state) => state.docCodeWrap);
  const readingTheme = useStore((state) => state.docReadingTheme);
  const effectiveTheme = useStore((state) => state.themeEffective);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const themeName = codeThemeFor(readingTheme, effectiveTheme);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTokens(null);
    if (!visible || !lang || TEST_ENVIRONMENT) return;
    let cancelled = false;
    // Dynamic import keeps the Shiki core/engine out of the startup chunk.
    void import("./codeHighlighter")
      .then(({ highlightCode }) => highlightCode(code, lang, themeName))
      .then((next) => {
        if (!cancelled) setTokens(next);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, code, lang, themeName]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      let copiedOk: boolean | void = true;
      if (reader.onCopyText) copiedOk = await reader.onCopyText(code);
      else if (navigator.clipboard) await navigator.clipboard.writeText(code);
      else copiedOk = false;
      if (copiedOk === false) return;
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard failures stay silent; the button simply does not confirm.
    }
  };

  const lines = code.split("\n");
  const highlighted = tokens && tokens.length === lines.length ? tokens : null;
  return (
    <div ref={hostRef} className="md-code" data-lang={lang || undefined}>
      <div className="md-code-toolbar" data-search-skip="true">
        <span className="md-code-lang">{lang || t("ui.document.codePlainText")}</span>
        <div className="md-code-actions">
          <button
            type="button"
            className="md-code-action"
            aria-pressed={lineNumbers}
            aria-label={t("ui.document.codeLineNumbers")}
            data-tip={t("ui.document.codeLineNumbers")}
            onClick={() => setDocCodeLineNumbers(!lineNumbers)}
          >
            #
          </button>
          <button
            type="button"
            className="md-code-action"
            aria-pressed={wrap}
            aria-label={t("ui.document.codeWrap")}
            data-tip={t("ui.document.codeWrap")}
            onClick={() => setDocCodeWrap(!wrap)}
          >
            ↵
          </button>
          <button
            type="button"
            className="md-code-action md-code-copy"
            onClick={() => void copy()}
            aria-label={copied ? t("ui.document.codeCopied") : t("ui.document.codeCopy")}
            data-tip={copied ? t("ui.document.codeCopied") : t("ui.document.codeCopy")}
          >
            {copied ? "✓" : "⧉"}
          </button>
        </div>
      </div>
      <pre className="md-code-pre" data-lang={lang || undefined}>
        <code>
          {lines.map((line, index) => (
            <CodeLine
              key={index}
              sourceLine={sourceLine}
              index={index}
              last={index === lines.length - 1}
              tokens={highlighted ? (highlighted[index] ?? null) : null}
            >
              {line}
            </CodeLine>
          ))}
        </code>
      </pre>
    </div>
  );
}

function CodeLine({
  sourceLine,
  index,
  last,
  tokens,
  children,
}: {
  sourceLine?: number;
  index: number;
  last: boolean;
  tokens: ThemedToken[] | null;
  children: ReactNode;
}) {
  return (
    <span
      className="md-code-line"
      {...(sourceLine !== undefined ? { "data-source-line": sourceLine + index } : {})}
    >
      <span className="md-code-line-content">
        {tokens
          ? tokens.map((token, tokenIndex) => (
              <span key={tokenIndex} style={tokenStyle(token)}>
                {token.content}
              </span>
            ))
          : children}
      </span>
      {last ? null : <span className="md-code-newline" aria-hidden="true">{"\n"}</span>}
    </span>
  );
}
