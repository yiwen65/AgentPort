// Custom SVG renderer for parsed flowcharts. Unlike the mermaid engine, every
// visual here is styled with the app's own theme tokens through CSS classes,
// so diagrams look native in both One Dark Pro and One Light Pro and follow
// theme switches with no re-render pass.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FlowGraphData, FlowNodeShape } from "../flowchart";
import { layoutFlow, type LayoutEdge, type LayoutNode } from "../flowLayout";

const LINE_HEIGHT = 20;
const ARROW_LEN = 9;
const ARROW_HALF_WIDTH = 4;

/** Smooths dagre's polyline into a quadratic path through segment midpoints. */
function edgePath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `${d} L ${points[1].x} ${points[1].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** Triangle marker at the edge tip, rotated along the final segment. */
function arrowHead(points: Array<{ x: number; y: number }>, key: string) {
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  const angle = (Math.atan2(tip.y - before.y, tip.x - before.x) * 180) / Math.PI;
  const p1 = `${-ARROW_LEN},${-ARROW_HALF_WIDTH}`;
  const p2 = `${-ARROW_LEN},${ARROW_HALF_WIDTH}`;
  return (
    <polygon
      key={key}
      className="flow-arrow"
      points={`0,0 ${p1} ${p2}`}
      transform={`translate(${tip.x} ${tip.y}) rotate(${angle})`}
    />
  );
}

function EdgeView({ edge, index }: { edge: LayoutEdge; index: number }) {
  return (
    <g key={`e${index}`} className={`flow-edge flow-edge-${edge.kind}`}>
      <path className="flow-edge-path" d={edgePath(edge.points)} />
      {edge.kind !== "open" ? arrowHead(edge.points, `a${index}`) : null}
      {edge.label && edge.labelX !== null && edge.labelY !== null ? (
        <g transform={`translate(${edge.labelX} ${edge.labelY})`}>
          {edge.label.map((line, i) => (
            <text
              key={i}
              className="flow-edge-label"
              textAnchor="middle"
              y={(i - (edge.label!.length - 1) / 2) * LINE_HEIGHT + 4.5}
            >
              {line}
            </text>
          ))}
        </g>
      ) : null}
    </g>
  );
}

function NodeShape({ node }: { node: LayoutNode }) {
  const w = node.width;
  const h = node.height;
  switch (node.shape as FlowNodeShape) {
    case "diamond":
      return (
        <polygon
          className="flow-node-shape flow-shape-decision"
          points={`0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`}
        />
      );
    case "circle":
      return <circle className="flow-node-shape" r={Math.min(w, h) / 2} />;
    case "stadium":
      return <rect className="flow-node-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />;
    case "rounded":
      return <rect className="flow-node-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={10} />;
    case "cylinder": {
      const ry = 8;
      const top = -h / 2 + ry;
      const bottom = h / 2 - ry;
      return (
        <path
          className="flow-node-shape"
          d={`M ${-w / 2} ${top} A ${w / 2} ${ry} 0 0 1 ${w / 2} ${top} L ${w / 2} ${bottom} A ${w / 2} ${ry} 0 0 1 ${-w / 2} ${bottom} Z`}
        />
      );
    }
    case "subroutine":
      return (
        <g>
          <rect className="flow-node-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={4} />
          <line className="flow-node-shape flow-sub-line" x1={-w / 2 + 7} y1={-h / 2} x2={-w / 2 + 7} y2={h / 2} />
          <line className="flow-node-shape flow-sub-line" x1={w / 2 - 7} y1={-h / 2} x2={w / 2 - 7} y2={h / 2} />
        </g>
      );
    default:
      return <rect className="flow-node-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={6} />;
  }
}

function NodeView({ node }: { node: LayoutNode }) {
  return (
    <g className="flow-node" transform={`translate(${node.x} ${node.y})`}>
      <NodeShape node={node} />
      {node.label.map((line, i) => (
        <text
          key={i}
          className="flow-node-label"
          textAnchor="middle"
          y={(i - (node.label.length - 1) / 2) * LINE_HEIGHT + 4.5}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

export default function FlowGraph({ graph }: { graph: FlowGraphData }) {
  const { t } = useTranslation("shell");
  const layout = useMemo(() => layoutFlow(graph), [graph]);
  return (
    <div className="flow-graph" role="img" aria-label={t("ui.document.diagramLabel")}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
      >
        {layout.edges.map((edge, i) => (
          <EdgeView key={`e${i}`} edge={edge} index={i} />
        ))}
        {layout.nodes.map((node) => (
          <NodeView key={node.id} node={node} />
        ))}
      </svg>
    </div>
  );
}
