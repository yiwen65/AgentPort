import { describe, expect, it } from "vitest";
import { parseFlowchart } from "./flowchart";
describe("parseFlowchart", () => {
  it("parses shapes, directions and edge labels", () => {
    const graph = parseFlowchart(
      [
        "flowchart TB",
        "  Out([AI 输出]) --> Type{内容类型}",
        "  Type -- 事实 --> V1[查来源]",
        "  Type -- 代码 --> V2[跑测试]",
        "  V1 --> Pass{通过?}",
        "  Pass -- 否 --> Retry[回到迭代]",
        "  Pass -->|是| Accept([采纳为结论])",
      ].join("\n"),
    );
    expect(graph).not.toBeNull();
    expect(graph!.direction).toBe("TB");
    expect(graph!.nodes).toHaveLength(7);
    const byId = new Map(graph!.nodes.map((n) => [n.id, n]));
    expect(byId.get("Out")!.shape).toBe("stadium");
    expect(byId.get("Type")!.shape).toBe("diamond");
    expect(byId.get("V1")!.shape).toBe("rect");
    expect(byId.get("V1")!.label).toEqual(["查来源"]);
    expect(graph!.edges).toHaveLength(6);
    expect(graph!.edges.find((e) => e.from === "Type" && e.to === "V1")!.label).toEqual(["事实"]);
    expect(graph!.edges.find((e) => e.from === "Pass" && e.to === "Accept")!.label).toEqual(["是"]);
  });

  it("supports chains, & forks, edge kinds and comments", () => {
    const graph = parseFlowchart(
      [
        "graph LR",
        "  %% a comment",
        "  A --> B & C",
        "  B -.-> D[( 数据库 )]",
        "  C ==> D",
        "  A --- E[[ 子程序 ]]",
        "  F(( 圆 )) --- G( 圆角 )",
      ].join("\n"),
    );
    expect(graph).not.toBeNull();
    expect(graph!.direction).toBe("LR");
    const kinds = new Map(graph!.edges.map((e) => [`${e.from}->${e.to}`, e.kind]));
    expect(kinds.get("A->B")).toBe("arrow");
    expect(kinds.get("A->C")).toBe("arrow");
    expect(kinds.get("B->D")).toBe("dotted");
    expect(kinds.get("C->D")).toBe("thick");
    expect(kinds.get("A->E")).toBe("open");
    const byId = new Map(graph!.nodes.map((n) => [n.id, n]));
    expect(byId.get("D")!.shape).toBe("cylinder");
    expect(byId.get("E")!.shape).toBe("subroutine");
    expect(byId.get("F")!.shape).toBe("circle");
    expect(byId.get("G")!.shape).toBe("rounded");
  });

  it("splits <br/> in labels and strips quotes", () => {
    const graph = parseFlowchart('flowchart TD\n  A["第一行<br/>第二行"] --> B{满意?}');
    expect(graph).not.toBeNull();
    expect(graph!.direction).toBe("TB");
    expect(graph!.nodes.find((n) => n.id === "A")!.label).toEqual(["第一行", "第二行"]);
    expect(graph!.nodes.find((n) => n.id === "B")!.label).toEqual(["满意?"]);
  });

  it("returns null for non-flowchart sources and unsupported constructs", () => {
    expect(parseFlowchart("sequenceDiagram\n  A->>B: hi")).toBeNull();
    expect(parseFlowchart("flowchart TB\n  subgraph s\n  A --> B\n  end")).toBeNull();
    expect(parseFlowchart("flowchart TB\n  classDef x fill:#f00\n  A --> B")).toBeNull();
    expect(parseFlowchart("flowchart TB\n  A --> B\n  style A fill:#f00")).toBeNull();
  });
});
