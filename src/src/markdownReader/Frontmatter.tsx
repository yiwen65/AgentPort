// YAML front matter card; structured parsing is added in a later layer.

import { useTranslation } from "react-i18next";

export default function Frontmatter({
  raw,
  sourceLine,
}: {
  raw: string;
  sourceLine?: number;
}) {
  const { t } = useTranslation("shell");
  const lines = raw.split("\n");
  return (
    <details className="md-frontmatter">
      <summary>{t("ui.document.metadata")}</summary>
      <pre className="md-frontmatter-raw" data-search-skip="true">
        <code>
          {lines.map((line, index) => (
            <span
              key={index}
              {...(sourceLine !== undefined ? { "data-source-line": sourceLine + 1 + index } : {})}
            >
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </details>
  );
}
