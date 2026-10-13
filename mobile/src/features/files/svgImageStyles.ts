// Static SVG presentation only: never hand document CSS to the image renderer.
const properties = new Set(["fill", "stroke", "color", "opacity", "fill-opacity", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "fill-rule", "clip-rule", "clip-path", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "word-spacing", "stop-color", "stop-opacity", "display", "visibility"]);
function valueFor(name: string, value: string): string | undefined {
  value = value.replace(/\s*!important\s*$/i, "").trim();
  if (!properties.has(name) || /[\\@]|https?:|data:|file:|\/\//i.test(value)) return;
  if (/url\s*\(/i.test(value)) return /^url\(\s*["']?#[\w.-]+["']?\s*\)$/i.test(value) ? value : undefined;
  if (["fill", "stroke", "color", "stop-color"].includes(name)) return /^(#[\da-f]{3,8}|[a-z-]+|(?:rgba?|hsla?)\([\d\s.%+,/-]+\))$/i.test(value) ? value : undefined;
  return /^[\p{L}\p{N}\s.,'%"+/-]+$/u.test(value) ? value : undefined;
}
export function staticImageStyles(document: Document): void {
  let tokens = 0; let writes = 0; let cssLength = 0; let selectors = 0;
  const apply = (targets: Element[], source: string) => {
    if (source.length > 32_768) throw { code: "invalid_image" };
    const entries = source.split(";"); tokens += entries.length;
    if (tokens > 2048) throw { code: "invalid_image" };
    const reduced = new Map<string, string>();
    for (const entry of entries) {
      const colon = entry.indexOf(":"); if (colon < 1) continue;
      const name = entry.slice(0, colon).trim().toLowerCase(); const value = valueFor(name, entry.slice(colon + 1));
      if (value !== undefined) reduced.set(name, value);
    }
    writes += targets.length * reduced.size;
    if (writes > 200_000) throw { code: "invalid_image" };
    for (const target of targets) for (const [name, value] of reduced) target.setAttribute(name, value);
  };
  const rules: { selector: string; body: string; priority: number }[] = [];
  for (const style of [...document.querySelectorAll("style")]) {
    const raw = style.textContent ?? ""; cssLength += raw.length;
    if (cssLength > 65_536) throw { code: "invalid_image" };
    const pieces: string[] = []; let cursor = 0;
    while (cursor < raw.length) {
      const start = raw.indexOf("/*", cursor);
      if (start < 0) { pieces.push(raw.slice(cursor)); break; }
      pieces.push(raw.slice(cursor, start)); const end = raw.indexOf("*/", start + 2);
      if (end < 0) throw { code: "invalid_image" }; cursor = end + 2;
    }
    const source = pieces.join("");
    if (!/[\\@]/.test(source)) { let position = 0;
      while (position < source.length) {
      const start = source.indexOf("{", position); if (start < 0) { if (source.slice(position).trim()) throw { code: "invalid_image" }; break; }
      const end = source.indexOf("}", start + 1); const nested = source.indexOf("{", start + 1);
      if (end < 0 || (nested >= 0 && nested < end)) throw { code: "invalid_image" };
      const selectorText = source.slice(position, start); const body = source.slice(start + 1, end); position = end + 1;
      for (const item of selectorText.split(",")) {
        const selector = item.trim(); if (!selector || selector.length > 256 || !/^[\w.#\s>+-]+$/.test(selector) || selector.split(/[\s>+]+/).length > 8) continue;
        if (++selectors > 200) throw { code: "invalid_image" };
        rules.push({ selector, body, priority: (selector.match(/#/g)?.length ?? 0) * 100 + (selector.match(/\./g)?.length ?? 0) * 10 });
      }
      }
    }
    style.remove();
  }
  for (const rule of rules.sort((a, b) => a.priority - b.priority)) {
    let targets: Element[]; try { targets = [...document.querySelectorAll(rule.selector)]; } catch { continue; }
    apply(targets, rule.body);
  }
  for (const element of [document.documentElement, ...document.querySelectorAll("*")]) {
    const inline = element.getAttribute("style"); if (inline) apply([element], inline);
    element.removeAttribute("style");
  }
}
