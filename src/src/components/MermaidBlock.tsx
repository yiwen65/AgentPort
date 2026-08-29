// Renders mermaid fenced blocks as diagrams inside the document preview.
// Mermaid is imported lazily so the large parser only loads when a document
// actually contains a diagram. Blocks that fail to parse fall back to the
// plain code view instead of breaking the whole preview.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore, type EffectiveTheme } from "../store";
import { parseFlowchart } from "../flowchart";
import { getTerminalPalette } from "../terminalThemes";
import type { TerminalThemeId } from "../types";
import FlowGraph from "./FlowGraph";

let renderSeq = 0;

/** Mermaid's built-in dark theme can produce black arrows on dark fills.
 * Drive its base theme from the same selected palette as xterm instead. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const alphaHex = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alphaHex}`;
}

function themeVariablesFor(
  terminalTheme: TerminalThemeId,
  mode: EffectiveTheme,
): Record<string, string> {
  const { xterm, workspace } = getTerminalPalette(terminalTheme, mode);
  const text = workspace.headingForeground;
  return {
    background: "transparent",
    primaryColor: withAlpha(xterm.blue, 0.14),
    primaryBorderColor: xterm.blue,
    primaryTextColor: text,
    lineColor: workspace.mutedForeground,
    secondaryColor: withAlpha(xterm.green, 0.13),
    secondaryBorderColor: xterm.green,
    secondaryTextColor: text,
    tertiaryColor: withAlpha(xterm.yellow, 0.14),
    tertiaryBorderColor: xterm.yellow,
    tertiaryTextColor: text,
    edgeLabelBackground: xterm.background,
    clusterBkg: withAlpha(xterm.blue, 0.06),
    clusterBorder: workspace.border,
    titleColor: text,
    noteBkgColor: withAlpha(xterm.yellow, 0.15),
    noteBorderColor: xterm.yellow,
    noteTextColor: text,
    actorBkg: withAlpha(xterm.blue, 0.14),
    actorBorder: xterm.blue,
    actorTextColor: text,
    actorLineColor: workspace.mutedForeground,
    signalColor: workspace.mutedForeground,
    signalTextColor: text,
    labelBoxBkgColor: withAlpha(xterm.blue, 0.14),
    labelBoxBorderColor: xterm.blue,
    labelTextColor: text,
    loopTextColor: text,
    fontFamily: "inherit",
    fontSize: "13px",
  };
}

export default function MermaidBlock({ source }: { source: string }) {
  const { t } = useTranslation("shell");
  const theme = useStore((state) => state.themeEffective);
  const terminalTheme = useStore(
    (state) => state.settings?.terminalTheme ?? "one",
  );
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
          themeVariables: themeVariablesFor(terminalTheme, theme),
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
  }, [source, theme, terminalTheme, flowGraph]);

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
