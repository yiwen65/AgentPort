// dagre layout for parsed flowcharts, with CJK-aware text metrics so node
// boxes fit their labels without a DOM measurement pass (which also keeps
// layout deterministic in tests).
import dagre from "dagre";
import type { FlowDirection, FlowGraphData, FlowNodeShape } from "./flowchart";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: FlowNodeShape;
  label: string[];
}

export interface LayoutEdge {
  from: string;
  to: string;
  kind: FlowGraphData["edges"][number]["kind"];
  label: string[] | null;
  labelX: number | null;
  labelY: number | null;
  points: Array<{ x: number; y: number }>;
}

export interface FlowLayout {
  direction: FlowDirection;
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

const FONT_SIZE = 13;
const LINE_HEIGHT = 20;
const PAD_X = 16;
const PAD_Y = 10;

function charWidth(char: string): number {
  // CJK ideographs, kana, hangul and full-width forms take the full em box.
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(char)
    ? FONT_SIZE
    : FONT_SIZE * 0.56;
}

export function measureLines(lines: string[]): { width: number; height: number } {
  const textWidth = lines.reduce(
    (max, line) => Math.max(max, [...line].reduce((sum, c) => sum + charWidth(c), 0)),
    0,
  );
  return { width: textWidth, height: Math.max(1, lines.length) * LINE_HEIGHT };
}

function nodeBox(shape: FlowNodeShape, label: string[]): { width: number; height: number } {
  const text = measureLines(label);
  switch (shape) {
    case "diamond":
      // A diamond inscribes its text: both axes grow to keep the label clear.
      return {
        width: text.width * 1.9 + PAD_X * 2,
        height: text.height * 1.7 + PAD_Y * 2,
      };
    case "circle": {
      const side = Math.ceil(Math.hypot(text.width, text.height)) + PAD_Y * 2;
      return { width: side, height: side };
    }
    case "stadium":
      return {
        width: text.width + PAD_X * 2 + 18,
        height: text.height + PAD_Y * 2,
      };
    case "subroutine":
      return {
        width: text.width + PAD_X * 2 + 16,
        height: text.height + PAD_Y * 2,
      };
    case "cylinder":
      return {
        width: text.width + PAD_X * 2,
        height: text.height + PAD_Y * 2 + 14,
      };
    default:
      return { width: text.width + PAD_X * 2, height: text.height + PAD_Y * 2 };
  }
}

export function layoutFlow(graph: FlowGraphData): FlowLayout {
  const g = new dagre.graphlib.Graph();
  const horizontal = graph.direction === "LR" || graph.direction === "RL";
  g.setGraph({
    rankdir: graph.direction,
    nodesep: horizontal ? 26 : 34,
    ranksep: horizontal ? 64 : 52,
    edgesep: 14,
    marginx: 16,
    marginy: 16,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    const box = nodeBox(node.shape, node.label);
    g.setNode(node.id, { width: box.width, height: box.height });
  }
  for (const edge of graph.edges) {
    const labelBox = edge.label ? measureLines(edge.label) : { width: 0, height: 0 };
    g.setEdge(edge.from, edge.to, {
      width: labelBox.width + 12,
      height: labelBox.height,
      labelpos: "c",
    });
  }
  dagre.layout(g);

  const nodes: LayoutNode[] = graph.nodes.map((node) => {
    const placed = g.node(node.id);
    return {
      id: node.id,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      shape: node.shape,
      label: node.label,
    };
  });
  const edges: LayoutEdge[] = graph.edges.map((edge) => {
    const placed = g.edge(edge.from, edge.to);
    return {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label,
      labelX: edge.label && placed ? placed.x : null,
      labelY: edge.label && placed ? placed.y : null,
      points: placed?.points ?? [],
    };
  });

  const info = g.graph();
  return {
    direction: graph.direction,
    width: Math.max(1, info.width ?? 1),
    height: Math.max(1, info.height ?? 1),
    nodes,
    edges,
  };
}
