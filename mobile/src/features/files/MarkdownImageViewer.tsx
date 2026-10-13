import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import type { ImageAsset } from "./markdownImageAssets";

const bound = (scale: number) => Math.min(8, Math.max(0.25, scale));
export function MarkdownImageViewer({ asset, alt, onClose }: { asset: ImageAsset; alt: string; onClose: () => void }) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const points = useRef(new Map<number, { x: number; y: number }>());
  const previous = useRef<{ x: number; y: number; span: number }>();
  const sample = () => {
    const positions = [...points.current.values()];
    return { x: positions.reduce((sum, p) => sum + p.x, 0) / positions.length, y: positions.reduce((sum, p) => sum + p.y, 0) / positions.length,
      span: positions.length > 1 ? Math.hypot(positions[0].x - positions[1].x, positions[0].y - positions[1].y) : 0 };
  };
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); setView(old => ({ ...old, scale: bound(old.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)) })); };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  return <Modal title={alt} onClose={onClose} className="markdown-image-viewer">
    <div className="markdown-image-viewer-tools"><button type="button" aria-label={t("images.zoomOut")} onClick={() => setView(old => ({ ...old, scale: bound(old.scale / 1.5) }))}>−</button><button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>{t("images.reset")}</button><button type="button" aria-label={t("images.zoomIn")} onClick={() => setView(old => ({ ...old, scale: bound(old.scale * 1.5) }))}>＋</button></div>
    <div ref={viewport} className="markdown-image-viewport" data-no-page-swipe="true" onDoubleClick={() => setView(old => ({ ...old, scale: old.scale === 1 ? 2 : 1 }))}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); points.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); previous.current = sample(); event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => {
        if (!points.current.has(event.pointerId)) return; event.preventDefault(); event.stopPropagation();
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); const now = sample(); const last = previous.current; previous.current = now;
        if (last) setView(old => ({ scale: now.span && last.span ? bound(old.scale * now.span / last.span) : old.scale, x: old.x + now.x - last.x, y: old.y + now.y - last.y }));
      }}
      onPointerUp={event => { event.stopPropagation(); points.current.delete(event.pointerId); previous.current = points.current.size ? sample() : undefined; }}
      onPointerCancel={() => { points.current.clear(); previous.current = undefined; }}
      onLostPointerCapture={event => { points.current.delete(event.pointerId); previous.current = points.current.size ? sample() : undefined; }}>
      <img src={asset.url} alt={alt} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
  </Modal>;
}
