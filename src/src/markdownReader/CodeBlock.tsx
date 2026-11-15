// Fenced code block shell. Highlighting is added in a later layer; the source
// lines stay one-by-one annotated so preview selections still map to the file.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownReader } from "./context";

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
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

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
  return (
    <div className="md-code" data-lang={lang || undefined}>
      <div className="md-code-toolbar" data-search-skip="true">
        <span className="md-code-lang">{lang || t("ui.document.codePlainText")}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={() => void copy()}
          aria-label={copied ? t("ui.document.codeCopied") : t("ui.document.codeCopy")}
          data-tip={copied ? t("ui.document.codeCopied") : t("ui.document.codeCopy")}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>
      <pre className="md-code-pre" data-lang={lang || undefined}>
        <code>
          {lines.map((line, index) => (
            <CodeLine key={index} sourceLine={sourceLine} index={index} last={index === lines.length - 1}>
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
  children,
}: {
  sourceLine?: number;
  index: number;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className="md-code-line"
      {...(sourceLine !== undefined ? { "data-source-line": sourceLine + index } : {})}
    >
      {children}
      {last ? null : "\n"}
    </span>
  );
}
