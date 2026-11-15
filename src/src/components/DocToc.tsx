// Outline for the active Markdown preview. Reading mode pins it as a rail;
// the docked viewer opens the same list as a drawer.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineItem } from "../markdownReader/types";

/** Pathological documents can have thousands of headings; keep the rail
 * responsive rather than rendering every entry. */
const MAX_TOC_ITEMS = 2000;

export default function DocToc({
  items,
  hostRef,
  variant,
  label,
  closeLabel,
  onSelect,
  onClose,
}: {
  items: OutlineItem[];
  hostRef: RefObject<HTMLElement | null>;
  variant: "rail" | "drawer";
  label: string;
  closeLabel: string;
  onSelect: (item: OutlineItem) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("shell");
  const visible = items.slice(0, MAX_TOC_ITEMS);
  const [active, setActive] = useState<string | null>(visible[0]?.id ?? null);
  const headingsRef = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const byId = new Map<string, HTMLElement>();
    for (const node of host.querySelectorAll<HTMLElement>("[id]")) {
      byId.set(node.id, node);
    }
    headingsRef.current = byId;
    const headings = visible
      .map((item) => ({ item, element: byId.get(item.id) }))
      .filter((entry): entry is { item: OutlineItem; element: HTMLElement } => !!entry.element);
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const hostTop = host.getBoundingClientRect().top;
      let current = visible[0]?.id ?? null;
      for (const entry of headings) {
        if (entry.element.getBoundingClientRect().top - hostTop <= 96) {
          current = entry.item.id;
        } else {
          break;
        }
      }
      setActive(current);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    host.addEventListener("scroll", schedule, { passive: true });
    return () => {
      host.removeEventListener("scroll", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [hostRef, items]);

  return (
    <aside className={`doc-toc doc-toc-${variant}`} aria-label={label}>
      <div className="doc-toc-header">
        <span>{label}</span>
        {onClose ? (
          <button type="button" className="doc-toc-close" aria-label={closeLabel} onClick={onClose}>
            ✕
          </button>
        ) : null}
      </div>
      <nav className="doc-toc-list">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`doc-toc-item${active === item.id ? " active" : ""}`}
            style={{ paddingLeft: `${10 + (item.level - 1) * 12}px` }}
            aria-current={active === item.id ? "location" : undefined}
            title={item.text}
            onClick={() => {
              headingsRef.current.get(item.id)?.scrollIntoView?.({
                block: "start",
                behavior: "smooth",
              });
              setActive(item.id);
              onSelect(item);
            }}
          >
            {item.text}
          </button>
        ))}
        {items.length > MAX_TOC_ITEMS ? (
          <div className="doc-toc-more">
            {t("ui.document.outlineTruncated", { count: MAX_TOC_ITEMS })}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
