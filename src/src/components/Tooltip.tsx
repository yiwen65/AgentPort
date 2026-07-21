// Single tooltip instance driven by [data-tip] delegation — robust inside
// overflow:auto containers where CSS-only tooltips get clipped.

import { useEffect, useState } from "react";

interface Tip {
  x: number;
  y: number;
  text: string;
}

export default function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const show = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el) {
        setTip(null);
        return;
      }
      const text = el.dataset.tip;
      if (!text) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setTip({ x: r.left, y: r.bottom + 6, text });
    };
    const hide = () => setTip(null);
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  const left = Math.max(8, Math.min(tip.x, window.innerWidth - 336));
  return (
    <div className="tooltip-host" style={{ left, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  );
}
