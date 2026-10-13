import DOMPurify from "dompurify";

// Project Markdown is untrusted. No per-document configuration, interactions,
// external assets or CSS resource loads; diagrams exceeding bounds stay source.
export function safeMermaidSource(source: string): boolean {
  return source.length <= 20_000 && !/^\s*---/.test(source) && !/%%\s*\{/.test(source)
    && !/(?:https?:|data:|javascript:|file:|ftp:|\/\/|@import|url\s*\(|\bimg\s*:|<\s*(?:img|image|iframe|object|link|script)\b)/i.test(source)
    // Asset metadata is YAML and can encode keys/URLs. Do not try to police
    // its raw spelling: this read-only surface rejects metadata and custom CSS.
    && !/@\s*\{|\b(?:classDef|linkStyle|style)\b/i.test(source)
    && !/^\s*click\b/im.test(source);
}

export function sanitizeDiagram(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ["foreignObject", "image", "a", "use", "script", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href", "target"],
  });
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) throw new Error("Invalid diagram output");
  const unsafeCss = (value: string) => /\\|@import/i.test(value) || [...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(match => !/^["']?#[\w:.-]+["']?$/.test(match[1].trim()));
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "style" && unsafeCss(element.textContent ?? "")) element.remove();
    for (const attribute of [...element.attributes]) {
      if (unsafeCss(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  for (const attribute of [...root.attributes]) if (unsafeCss(attribute.value)) root.removeAttribute(attribute.name);
  const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    root.setAttribute("width", String(box[2])); root.setAttribute("height", String(box[3]));
    root.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(root);
}

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();
export function renderDiagram(source: string, mode: "light" | "dark", current: () => boolean = () => true): Promise<string | null> {
  if (!safeMermaidSource(source)) return Promise.reject(new Error("Unsupported diagram source"));
  const work = queue.then(async () => {
    if (!current()) return null;
    const { default: mermaid } = await import("mermaid");
    if (!current()) return null;
    // Mermaid owns global configuration. Initialize and render in the same
    // serialized job, so concurrent blocks cannot mix theme/security settings.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mode === "dark" ? "dark" : "default", htmlLabels: false,
      flowchart: { htmlLabels: false }, maxTextSize: 20_000, maxEdges: 200, suppressErrorRendering: true });
    const host = document.createElement("div");
    host.dataset.mermaidMeasure = "true";
    host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`mobile-mermaid-${++sequence}`, source, host);
      return current() ? sanitizeDiagram(svg) : null;
    } finally { host.remove(); }
  });
  queue = work.catch(() => undefined);
  return work;
}
