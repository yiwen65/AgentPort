// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

import MermaidBlock from "./MermaidBlock";
import { MarkdownView } from "../markdown";

const FLOW = "flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]";

describe("MermaidBlock", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders flowcharts with the custom token-styled renderer", async () => {
    const { container } = render(<MermaidBlock source={FLOW} />);

    await waitFor(() => {
      expect(container.querySelector(".flow-graph svg")).toBeTruthy();
    });
    // The mermaid engine is not involved for flowchart sources.
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".flow-node").length).toBe(3);
    expect(container.querySelectorAll(".flow-edge-path").length).toBe(2);
    expect(container.querySelectorAll(".flow-arrow").length).toBe(2);
    expect(container.textContent).toContain("开始");
    expect(container.textContent).toContain("判断");
    // Edge label uses the halo-styled label class.
    expect(container.querySelector(".flow-edge-label")?.textContent).toBe("是");
  });

  it("keeps non-flowchart diagrams on the mermaid engine", async () => {
    const sequence = "sequenceDiagram\n  A->>B: 你好";
    mermaidMock.render.mockResolvedValue({ svg: "<svg><text>节点</text></svg>" });
    const { container } = render(<MermaidBlock source={sequence} />);

    await waitFor(() => {
      expect(container.querySelector(".md-mermaid svg")).toBeTruthy();
    });
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "base",
        securityLevel: "strict",
        themeVariables: expect.objectContaining({
          primaryBorderColor: expect.any(String),
          lineColor: expect.any(String),
          edgeLabelBackground: expect.any(String),
        }),
      }),
    );
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.any(String), sequence);
    expect(container.querySelector(".md-mermaid")?.getAttribute("role")).toBe("img");
  });

  it("falls back to the code block when the diagram fails to parse", async () => {
    mermaidMock.render.mockRejectedValue(new Error("Parse error"));
    const { container } = render(<MermaidBlock source={"not a diagram"} />);

    await waitFor(() => {
      expect(container.querySelector("pre[data-lang='mermaid'] code")).toBeTruthy();
    });
    expect(container.querySelector(".md-mermaid")).toBeNull();
  });

  it("MarkdownView routes mermaid fences to the custom renderer", async () => {
    const source = "上文\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n下文";
    const { container } = render(<MarkdownView source={source} />);

    await waitFor(() => {
      expect(container.querySelector(".flow-graph")).toBeTruthy();
    });
    expect(mermaidMock.render).not.toHaveBeenCalled();
    // Ordinary code fences still render as code.
    const plain = render(<MarkdownView source={"```ts\nconst x = 1;\n```"} />);
    expect(plain.container.querySelector("pre code")?.textContent).toBe("const x = 1;");
    expect(plain.container.querySelector(".flow-graph")).toBeNull();
  });
});
