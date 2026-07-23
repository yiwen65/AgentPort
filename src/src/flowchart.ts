// Parser for the mermaid flowchart/graph subset that agents actually emit:
// node shapes, typed edges with labels, chains and `&` forks. Anything
// outside the subset (subgraphs, classDef, style directives, other diagram
// types) returns null so the caller can fall back to the mermaid engine.
export type FlowDirection = "TB" | "BT" | "LR" | "RL";

export type FlowNodeShape =
  | "rect"
  | "rounded"
  | "stadium"
  | "diamond"
  | "circle"
  | "cylinder"
  | "subroutine";

export type FlowEdgeKind = "arrow" | "open" | "dotted" | "thick";

export interface FlowNode {
  id: string;
  /** Display lines (`<br/>` in the source is already split). */
  label: string[];
  shape: FlowNodeShape;
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string[] | null;
  kind: FlowEdgeKind;
}

export interface FlowGraphData {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const HEADER = /^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\s*$/i;
const UNSUPPORTED =
  /^\s*(subgraph|end\b|classDef|class\b|style\b|linkStyle|click\b|accTitle|accDescr|direction\b)/;

const ID = "[A-Za-z0-9_\\-\\u4e00-\\u9fff]+";
const NODE_REF = new RegExp(
  `^(${ID})\\s*` +
    `(?:\\[\\[([^\\]]*)\\]\\]|\\(\\(([^)]*)\\)\\)|\\(\\[([^\\]]*)\\]\\)|\\[\\(([^)]*)\\)\\]|` +
    `\\[([^\\]]*)\\]|\\(([^)]*)\\)|\\{([^}]*)\\})?`,
);

interface EdgeToken {
  kind: FlowEdgeKind;
  label: string | null;
}

const EDGE_PATTERNS: Array<{ re: RegExp; kind: FlowEdgeKind; label?: number }> = [
  { re: /^-->\s*\|([^|]*)\|/, kind: "arrow", label: 1 },
  { re: /^---\s*\|([^|]*)\|/, kind: "open", label: 1 },
  { re: /^-\.->\s*\|([^|]*)\|/, kind: "dotted", label: 1 },
  { re: /^==>\s*\|([^|]*)\|/, kind: "thick", label: 1 },
  { re: /^-\.\s+(.+?)\s+\.->/, kind: "dotted", label: 1 },
  { re: /^==\s+(.+?)\s+==>/, kind: "thick", label: 1 },
  { re: /^--\s+(.+?)\s+-->/, kind: "arrow", label: 1 },
  { re: /^--\s+(.+?)\s+---/, kind: "open", label: 1 },
  { re: /^--([^>\s|][^>]*?)-->/, kind: "arrow", label: 1 },
  { re: /^-\.->/, kind: "dotted" },
  { re: /^-->/, kind: "arrow" },
  { re: /^---/, kind: "open" },
  { re: /^==>/, kind: "thick" },
];

function splitLabel(raw: string): string[] {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }
  return text
    .split(/<br\s*\/?>/i)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface ParsedRef {
  id: string;
  label: string[] | null;
  shape: FlowNodeShape | null;
}

function parseNodeRef(input: string): { ref: ParsedRef; rest: string } | null {
  const match = NODE_REF.exec(input);
  if (!match) return null;
  const [, id, sub, circle, stadium, cylinder, rect, rounded, diamond] = match;
  const rawLabel = sub ?? circle ?? stadium ?? cylinder ?? rect ?? rounded ?? diamond;
  const shape: FlowNodeShape | null = sub !== undefined
    ? "subroutine"
    : circle !== undefined
      ? "circle"
      : stadium !== undefined
        ? "stadium"
        : cylinder !== undefined
          ? "cylinder"
          : rect !== undefined
            ? "rect"
            : rounded !== undefined
              ? "rounded"
              : diamond !== undefined
                ? "diamond"
                : null;
  return {
    ref: {
      id,
      label: rawLabel !== undefined && rawLabel.trim() !== "" ? splitLabel(rawLabel) : null,
      shape,
    },
    rest: input.slice(match[0].length),
  };
}

function parseEdge(input: string): { edge: EdgeToken; rest: string } | null {
  for (const { re, kind, label } of EDGE_PATTERNS) {
    const match = re.exec(input);
    if (match) {
      return {
        edge: { kind, label: label ? match[label].trim() : null },
        rest: input.slice(match[0].length),
      };
    }
  }
  return null;
}

/** Parses one statement line into node updates and edges. Returns null when
 * the line cannot be fully consumed (unsupported syntax). */
function parseStatement(
  statement: string,
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
): boolean {
  const register = (ref: ParsedRef) => {
    const existing = nodes.get(ref.id);
    nodes.set(ref.id, {
      id: ref.id,
      label: ref.label ?? existing?.label ?? [ref.id],
      shape: ref.shape ?? existing?.shape ?? "rect",
    });
  };

  let rest = statement;
  const first = parseNodeRef(rest);
  if (!first) return false;
  register(first.ref);
  let sources: ParsedRef[] = [first.ref];
  rest = first.rest;

  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest === "") return true;

    // `A --> B & C` — fork more targets onto the same edge.
    if (rest.startsWith("&")) {
      const next = parseNodeRef(rest.slice(1).replace(/^\s+/, ""));
      if (!next) return false;
      register(next.ref);
      sources.push(next.ref);
      rest = next.rest;
      continue;
    }

    const edge = parseEdge(rest);
    if (!edge) return false;
    rest = edge.rest.replace(/^\s+/, "");
    const target = parseNodeRef(rest);
    if (!target) return false;
    register(target.ref);
    rest = target.rest;

    const targets: ParsedRef[] = [target.ref];
    for (;;) {
      const ahead = rest.replace(/^\s+/, "");
      if (!ahead.startsWith("&")) break;
      const next = parseNodeRef(ahead.slice(1).replace(/^\s+/, ""));
      if (!next) return false;
      register(next.ref);
      targets.push(next.ref);
      rest = next.rest;
    }

    for (const from of sources) {
      for (const to of targets) {
        edges.push({
          from: from.id,
          to: to.id,
          label: edge.edge.label ? splitLabel(edge.edge.label) : null,
          kind: edge.edge.kind,
        });
      }
    }
    sources = targets;
  }
}

/**
 * Parses mermaid flowchart/graph source. Returns null for anything outside
 * the supported subset so callers can fall back to the mermaid engine.
 */
export function parseFlowchart(source: string): FlowGraphData | null {
  const lines = source
    .split("\n")
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line !== "");
  const header = lines.length ? HEADER.exec(lines[0]) : null;
  if (!header) return null;
  const direction = (header[1].toUpperCase() === "TD" ? "TB" : header[1].toUpperCase()) as FlowDirection;

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  for (const line of lines.slice(1)) {
    if (UNSUPPORTED.test(line)) return null;
    if (!parseStatement(line, nodes, edges)) return null;
  }
  if (nodes.size === 0) return null;
  return { direction, nodes: [...nodes.values()], edges };
}
