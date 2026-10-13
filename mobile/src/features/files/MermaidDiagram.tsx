import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppAppearance } from "../../app/appAppearance";
import { renderDiagram } from "./mermaidRenderer";

export function MermaidDiagram({ source }: { source: string }) {
  const { t } = useTranslation();
  const [, , mode] = useAppAppearance();
  const [result, setResult] = useState<{ source: string; svg?: string; failed?: boolean }>();
  useEffect(() => {
    let disposed = false;
    void renderDiagram(source, mode, () => !disposed).then(svg => {
      if (!disposed && svg) setResult({ source, svg });
    }).catch(() => { if (!disposed) setResult({ source, failed: true }); });
    return () => { disposed = true; };
  }, [source, mode]);
  const current = result?.source === source ? result : undefined;
  if (current?.failed) return <div className="files-diagram-fallback"><p className="files-note" role="status">{t("files.diagramFailed")}</p><pre data-horizontal-scroll="true" tabIndex={0}><code>{source}</code></pre></div>;
  if (!current?.svg) return <p className="files-note" role="status">{t("files.diagramLoading")}</p>;
  return <div className="files-diagram-scroll" data-horizontal-scroll="true" role="region" aria-label={t("files.diagram")} tabIndex={0}><div role="img" aria-label={t("files.diagram")} dangerouslySetInnerHTML={{ __html: current.svg }} /></div>;
}
