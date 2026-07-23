// Renders mermaid fenced blocks as diagrams inside the document preview.
// Mermaid is imported lazily so the large parser only loads when a document
// actually contains a diagram. Blocks that fail to parse fall back to the
// plain code view instead of breaking the whole preview.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { parseFlowchart } from "../flowchart";
import FlowGraph from "./FlowGraph";

let renderSeq = 0;

/**
 * Mermaid's built-in "dark" theme is near-black fills with black arrows —
 * unreadable on our surface. Instead, drive the "base" theme from the same
 * One Dark Pro / One Light Pro accent palette the terminal page uses:
 * translucent accent fills, accent borders, readable edge and text colors.
 */
function themeVariablesFor(theme: "dark" | "light"): Record<string, string> {
  if (theme === "light") {
    return {
      background: "transparent",
      primaryColor: "rgba(0, 122, 255, 0.08)",
      primaryBorderColor: "#007aff",
      primaryTextColor: "#111217",
      lineColor: "#5b6472",
      secondaryColor: "rgba(52, 199, 89, 0.1)",
      secondaryBorderColor: "#248a3d",
      secondaryTextColor: "#111217",
      tertiaryColor: "rgba(255, 149, 0, 0.12)",
      tertiaryBorderColor: "#c93400",
      tertiaryTextColor: "#111217",
      edgeLabelBackground: "#fafafa",
      clusterBkg: "rgba(0, 122, 255, 0.05)",
      clusterBorder: "rgba(17, 18, 23, 0.2)",
      titleColor: "#111217",
      noteBkgColor: "rgba(255, 149, 0, 0.14)",
      noteBorderColor: "#c93400",
      noteTextColor: "#111217",
      actorBkg: "rgba(0, 122, 255, 0.08)",
      actorBorder: "#007aff",
      actorTextColor: "#111217",
      actorLineColor: "#5b6472",
      signalColor: "#5b6472",
      signalTextColor: "#111217",
      labelBoxBkgColor: "rgba(0, 122, 255, 0.08)",
      labelBoxBorderColor: "#007aff",
      labelTextColor: "#111217",
      loopTextColor: "#111217",
      fontFamily: "inherit",
      fontSize: "13px",
    };
  }
  return {
    background: "transparent",
    primaryColor: "rgba(107, 140, 255, 0.16)",
    primaryBorderColor: "#6b8cff",
    primaryTextColor: "#e8ecf4",
    lineColor: "#8a97b8",
    secondaryColor: "rgba(97, 218, 178, 0.13)",
    secondaryBorderColor: "#61dab2",
    secondaryTextColor: "#e8ecf4",
    tertiaryColor: "rgba(229, 192, 123, 0.15)",
    tertiaryBorderColor: "#e5c07b",
    tertiaryTextColor: "#e8ecf4",
    edgeLabelBackground: "#282c34",
    clusterBkg: "rgba(107, 140, 255, 0.06)",
    clusterBorder: "#4a5165",
    titleColor: "#e8ecf4",
    noteBkgColor: "rgba(229, 192, 123, 0.16)",
    noteBorderColor: "#e5c07b",
    noteTextColor: "#e8ecf4",
    actorBkg: "rgba(107, 140, 255, 0.16)",
    actorBorder: "#6b8cff",
    actorTextColor: "#e8ecf4",
    actorLineColor: "#8a97b8",
    signalColor: "#8a97b8",
    signalTextColor: "#e8ecf4",
    labelBoxBkgColor: "rgba(107, 140, 255, 0.16)",
    labelBoxBorderColor: "#6b8cff",
    labelTextColor: "#e8ecf4",
    loopTextColor: "#e8ecf4",
    fontFamily: "inherit",
    fontSize: "13px",
  };
}

export default function MermaidBlock({ source }: { source: string }) {
  const { t } = useTranslation("shell");
  const theme = useStore((state) => state.themeEffective);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  // Flowcharts render with the custom token-styled renderer; every other
  // diagram type (sequence, state, …) keeps the mermaid engine path.
  const flowGraph = useMemo(() => parseFlowchart(source), [source]);

  useEffect(() => {
    if (flowGraph) return; // custom renderer owns this block
    let stale = false;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: themeVariablesFor(theme),
          flowchart: { curve: "basis" },
          // Never render raw HTML from labels — documents are untrusted.
          securityLevel: "strict",
        });
        const id = `md-mermaid-${++renderSeq}`;
        const { svg } = await mermaid.render(id, source);
        if (!stale) setSvg(svg);
      } catch {
        // Parse/layout errors fall back to the raw code block; mermaid also
        // leaves an error element in the DOM that we never attach.
        if (!stale) setFailed(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [source, theme, flowGraph]);

  if (flowGraph) {
    return <FlowGraph graph={flowGraph} />;
  }

  if (failed) {
    return (
      <pre data-lang="mermaid">
        <code>{source}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div className="md-mermaid-status">{t("ui.document.diagramLoading")}</div>;
  }
  return (
    <div
      ref={hostRef}
      className="md-mermaid"
      role="img"
      aria-label={t("ui.document.diagramLabel")}
      // Mermaid output with securityLevel "strict": label text is escaped,
      // so injecting the generated SVG carries no markup from the document.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
