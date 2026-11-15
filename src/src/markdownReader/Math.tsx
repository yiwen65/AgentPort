// Math node: TeX source stays visible until the formula scrolls into view,
// then KaTeX renders into its own DOM node. Errors and oversized formulas
// keep the readable TeX fallback.

import { useEffect, useRef, useState } from "react";
import { loadKatex } from "./mathLoader";

const MAX_TEX_CHARS = 4096;

export default function MarkdownMath({
  tex,
  display,
  sourceLine,
}: {
  tex: string;
  display: boolean;
  sourceLine?: number;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || failed || tex.length > MAX_TEX_CHARS) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    host.replaceChildren();
    setRendered(false);
    void loadKatex()
      .then((katex) => {
        if (cancelled) return;
        try {
          katex.render(tex, host, {
            displayMode: display,
            throwOnError: false,
            trust: false,
            maxExpand: 1000,
            strict: "ignore",
          });
          setRendered(true);
        } catch {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [visible, tex, display, failed]);

  const fallback = failed || tex.length > MAX_TEX_CHARS;
  return (
    <span
      className={`md-math ${display ? "md-math-display" : "md-math-inline"}`}
      {...(sourceLine !== undefined ? { "data-source-line": sourceLine } : {})}
      data-search-skip="true"
    >
      <span ref={hostRef} className="md-math-rendered" aria-hidden={!rendered} />
      {rendered && !fallback ? null : <code className="md-math-source">{tex}</code>}
    </span>
  );
}
