// Independently authored desktop static SVG policy. CSS is reduced to a small
// set of presentation attributes, never embedded as executable/resource CSS.
const PRESENTATION = new Set(["color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "stop-color", "stop-opacity", "clip-path", "clip-rule", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "word-spacing", "display", "visibility"]);
export const LOCAL_SVG_REFERENCE = /^url\(\s*["']?(#[a-zA-Z_][\w.-]*)["']?\s*\)$/i;
function safeDeclaration(property: string, raw: string): string | null {
  if (!PRESENTATION.has(property) || /[\\@]|(?:https?:|data:|file:|\/\/)/i.test(raw)) return null;
  const trimmed = raw.trim();
  const value = trimmed.toLowerCase().endsWith("!important") ? trimmed.slice(0, -10).trimEnd() : trimmed;
  if (/url\s*\(/i.test(value)) { const match = LOCAL_SVG_REFERENCE.exec(value); return match ? `url(${match[1]})` : null; }
  if (/^(?:color|fill|stroke|stop-color)$/.test(property)) return /^(?:[a-z-]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.% ,+\/-]+\))$/i.test(value) ? value : null;
  // Plain presentation values only: no functions, blocks, markup or references.
  return /^[\w\s.,'%"+\/-]+$/.test(value) ? value : null;
}
interface StyleBudget { declarations: number; assignments: number }
function parseDeclarations(body: string, budget: StyleBudget): Map<string, string> {
  if (body.length > 32_768) throw new Error("SVG style declaration limit exceeded");
  const properties = new Map<string, string>();
  let count = 0;
  for (const declaration of body.split(";")) {
    if (!declaration.trim()) continue;
    // Count duplicates and unsupported/malformed declarations too, before
    // interpreting them. A repeated property must not amplify match work.
    if (++count > 128) throw new Error("SVG style declaration count limit exceeded");
    if (++budget.declarations > 20_000) throw new Error("SVG total declaration limit exceeded");
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = safeDeclaration(property, declaration.slice(colon + 1));
    if (value !== null) properties.set(property, value); // last valid value wins
  }
  return properties;
}
interface StyleAssignment { nodes: Element[]; properties: Map<string, string> }
function planAssignment(nodes: Element[], properties: Map<string, string>, budget: StyleBudget, plans: StyleAssignment[]) {
  const prospective = nodes.length * properties.size;
  if (budget.assignments + prospective > 200_000) throw new Error("SVG style application limit exceeded");
  budget.assignments += prospective;
  if (prospective) plans.push({ nodes, properties });
}
function stripStyleComments(source: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("/*", cursor);
    if (open < 0) { parts.push(source.slice(cursor)); break; }
    parts.push(source.slice(cursor, open));
    const close = source.indexOf("*/", open + 2);
    if (close < 0) break;
    cursor = close + 2;
  }
  return parts.join("");
}
function* staticStyleRules(text: string): Generator<{ selector: string; body: string }> {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open < 0) return;
    const close = text.indexOf("}", open + 1);
    if (close < 0) return;
    const selector = text.slice(cursor, open);
    const body = text.slice(open + 1, close);
    cursor = close + 1;
    // Nested rules are not in the supported static CSS subset.
    if (selector.includes("}") || body.includes("{")) continue;
    yield { selector, body };
  }
}

export function reduceStaticSvgStyles(xml: Document): void {
  let rules = 0;
  const declarations: Array<{ selector: string; properties: Map<string, string>; specificity: number }> = [];
  const budget: StyleBudget = { declarations: 0, assignments: 0 };
  const plans: StyleAssignment[] = [];
  const styles = [...xml.querySelectorAll("style")];
  for (const style of styles) {
    const text = stripStyleComments(style.textContent ?? "");
    // Escapes/at-rules are rejected wholesale rather than trying to interpret CSS.
    if (!/[\\@]/.test(text)) {
      // Linear delimiter scans avoid regexp backtracking on unterminated CSS.
      for (const rule of staticStyleRules(text)) {
        if (++rules > 200) throw new Error("SVG style rule limit exceeded");
        const selector = rule.selector.trim();
        // Static class/id/tag/descendant selectors only; no pseudo/attribute CSS.
        if (!selector || selector.length > 256 || !/^[\w.#,\s>+-]+$/.test(selector)) continue;
        const properties = parseDeclarations(rule.body, budget);
        for (const part of selector.split(",")) {
          if (part.trim().split(/\s*[>+]\s*|\s+/).length - 1 > 8) throw new Error("SVG selector complexity limit exceeded");
          const specificity = (part.match(/#/g)?.length ?? 0) * 100 + (part.match(/\./g)?.length ?? 0) * 10 + (part.match(/(?:^|[\s>+])\w+/g)?.length ?? 0);
          if (declarations.length >= 200) throw new Error("SVG selector limit exceeded");
          declarations.push({ selector: part.trim(), properties, specificity });
        }
      }
    }
  }
  declarations.sort((a, b) => a.specificity - b.specificity);
  for (const declaration of declarations) {
    if (!declaration.properties.size) continue;
    let nodes: Element[];
    try { nodes = [...xml.querySelectorAll(declaration.selector)]; } catch { continue; }
    planAssignment(nodes, declaration.properties, budget, plans);
  }
  const elements = [xml.documentElement, ...xml.querySelectorAll("*")];
  for (const node of elements) {
    const style = node.getAttribute("style");
    if (style && !/[\\@]/.test(style)) planAssignment([node], parseDeclarations(style, budget), budget, plans);
  }
  // All parsing and node × unique-property quotas pass before any mutations.
  for (const plan of plans) for (const node of plan.nodes) {
    for (const [property, value] of plan.properties) node.setAttribute(property, value);
  }
  for (const style of styles) style.remove();
  for (const node of elements) node.removeAttribute("style");
}

/** Bound the actual rendered expansion of local use references, not just XML
 * element count. Sanitized targets may only refer within this SVG. */
export function validateStaticSvgUseGraph(xml: Document): void {
  const ids = new Map<string, Element>();
  for (const node of xml.querySelectorAll("[id]")) {
    const id = node.getAttribute("id")!;
    if (ids.has(id)) throw new Error("Duplicate SVG id");
    ids.set(id, node);
  }
  let expanded = 0;
  function walk(node: Element, ancestors: Set<Element>, depth: number): void {
    if (++expanded > 20_000 || depth > 128) throw new Error("SVG reference expansion limit exceeded");
    if (ancestors.has(node)) throw new Error("SVG reference cycle is not supported");
    const next = new Set(ancestors); next.add(node);
    if (node.localName === "use") {
      const href = node.getAttribute("href") ?? node.getAttribute("xlink:href");
      if (!href || !/^#[a-zA-Z_][\w.-]*$/.test(href)) throw new Error("Only local SVG use references are supported");
      const target = ids.get(href.slice(1));
      if (!target) throw new Error("Missing SVG use target");
      walk(target, next, depth + 1);
    }
    for (const child of node.children) walk(child, next, depth + 1);
  }
  walk(xml.documentElement, new Set(), 0);
}
