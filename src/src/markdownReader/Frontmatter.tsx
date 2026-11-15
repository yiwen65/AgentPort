// YAML front matter card. Parsing is lazy (the `yaml` module only loads when
// a document actually has front matter); oversized or invalid input keeps the
// source view with its line annotations.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const MAX_PARSE_CHARS = 64 * 1024;

interface Entry {
  key: string;
  value: string;
  complex: boolean;
}

export default function Frontmatter({
  raw,
  sourceLine,
}: {
  raw: string;
  sourceLine?: number;
}) {
  const { t } = useTranslation("shell");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [rawOnly, setRawOnly] = useState(false);

  useEffect(() => {
    if (raw.length > MAX_PARSE_CHARS) {
      setRawOnly(true);
      return;
    }
    let cancelled = false;
    void import("yaml")
      .then(({ parse }) => {
        if (cancelled) return;
        const parsed = parse(raw, { maxAliasCount: 10 });
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setRawOnly(true);
          return;
        }
        setEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
            const simple =
              value === null ||
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean";
            return {
              key,
              value: simple
                ? String(value ?? "null")
                : JSON.stringify(value, null, 2) ?? String(value),
              complex: !simple,
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setRawOnly(true);
      });
    return () => {
      cancelled = true;
    };
  }, [raw]);

  const lines = raw.split("\n");
  return (
    <details className="md-frontmatter">
      <summary>{t("ui.document.metadata")}</summary>
      {rawOnly || entries === null ? (
        <pre className="md-frontmatter-raw">
          <code>
            {lines.map((line, index) => (
              <span
                key={index}
                {...(sourceLine !== undefined
                  ? { "data-source-line": sourceLine + 1 + index }
                  : {})}
              >
                {line}
                {index < lines.length - 1 ? "\n" : ""}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <dl className="md-frontmatter-grid" data-search-skip="true">
          {entries.map((entry) => (
            <div key={entry.key} className="md-frontmatter-row">
              <dt>{entry.key}</dt>
              <dd>{entry.complex ? <pre>{entry.value}</pre> : entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
