// Single tooltip instance driven by [data-tip] delegation — robust inside
// overflow:auto containers where CSS-only tooltips get clipped.

import { useEffect, useRef, useState } from "react";

interface Tip {
  x: number;
  y: number;
  text: string;
}

export default function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-tip]") as HTMLElement | null;
      const text = el?.dataset.tip;
      if (!el || !text) {
        anchorRef.current = null;
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      anchorRef.current = el;
      setTip({ x: r.left, y: r.bottom + 6, text });
    };
    const hide = () => {
      anchorRef.current = null;
      setTip(null);
    };
    // Scroll events reach document in the capture phase from whichever
    // element scrolled. Only a scroll of the anchor's own container moves the
    // tip out from under the pointer; unrelated surfaces (a busy terminal
    // viewport, another pane) must not dismiss it.
    const hideForScroll = (event: Event) => {
      const anchor = anchorRef.current;
      const target = event.target;
      if (!anchor || !(target instanceof Node) || !anchor.isConnected) {
        hide();
        return;
      }
      if (target === anchor || target.contains(anchor)) hide();
    };
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("scroll", hideForScroll, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("scroll", hideForScroll, true);
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
