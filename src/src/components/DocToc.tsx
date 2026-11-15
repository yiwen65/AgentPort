// Outline for the active Markdown preview. Reading mode pins it as a rail;
// the docked viewer opens the same list as a drawer.

import { useEffect, useState, type RefObject } from "react";
import type { OutlineItem } from "../markdownReader/types";

function findHeading(root: HTMLElement, id: string): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>("[id]")) {
    if (node.id === id) return node;
  }
  return null;
}

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
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const hostTop = host.getBoundingClientRect().top;
      let current = items[0]?.id ?? null;
      for (const item of items) {
        const heading = findHeading(host, item.id);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top - hostTop <= 96) current = item.id;
        else break;
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
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`doc-toc-item${active === item.id ? " active" : ""}`}
            style={{ paddingLeft: `${10 + (item.level - 1) * 12}px` }}
            aria-current={active === item.id ? "location" : undefined}
            title={item.text}
            onClick={() => {
              const host = hostRef.current;
              if (host) {
                findHeading(host, item.id)?.scrollIntoView?.({
                  block: "start",
                  behavior: "smooth",
                });
              }
              setActive(item.id);
              onSelect(item);
            }}
          >
            {item.text}
          </button>
        ))}
      </nav>
    </aside>
  );
}
