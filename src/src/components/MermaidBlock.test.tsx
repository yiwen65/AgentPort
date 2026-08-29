// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

import MermaidBlock from "./MermaidBlock";
import { MarkdownView } from "../markdown";
import { setState } from "../store";
import type { Settings } from "../types";

const FLOW = "flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const SETTINGS: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "dark",
  terminalTheme: "one",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: false,
  agentOrder: ["shell"],
  agentHidden: [],
  telemetryEnabled: false,
};

describe("MermaidBlock", () => {
  afterEach(() => {
    cleanup();
    setState({ settings: null, dialog: null, themeEffective: "dark" });
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

  it("defers hidden Mermaid work and preserves its SVG through the final refresh", async () => {
    const sequence = "sequenceDiagram\n  A->>B: 你好";
    const refresh = deferred<{ svg: string }>();
    mermaidMock.render
      .mockResolvedValueOnce({ svg: "<svg><text>initial</text></svg>" })
      .mockReturnValueOnce(refresh.promise);
    setState({
      settings: { ...SETTINGS },
      dialog: null,
      themeEffective: "dark",
    });
    const { container } = render(<MermaidBlock source={sequence} />);

    await waitFor(() => expect(container.textContent).toContain("initial"));
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);

    act(() => setState({ dialog: { kind: "settings" } }));
    act(() =>
      setState({ settings: { ...SETTINGS, terminalTheme: "graphite" } }),
    );
    act(() =>
      setState({ settings: { ...SETTINGS, terminalTheme: "aurora" } }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("initial");

    act(() => setState({ dialog: null }));
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain("initial");
    expect(container.querySelector(".md-mermaid-status")).toBeNull();
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          primaryBorderColor: "#60a5fa",
        }),
      }),
    );

    await act(async () => {
      refresh.resolve({ svg: "<svg><text>final</text></svg>" });
      await refresh.promise;
    });
    expect(container.textContent).toContain("final");
    expect(container.textContent).not.toContain("initial");
  });

  it("clears a stale SVG when the diagram source changes", async () => {
    const initial = "sequenceDiagram\n  A->>B: initial";
    const updated = "sequenceDiagram\n  A->>B: updated";
    const refresh = deferred<{ svg: string }>();
    mermaidMock.render
      .mockResolvedValueOnce({ svg: "<svg><text>initial</text></svg>" })
      .mockReturnValueOnce(refresh.promise);
    const { container, rerender } = render(<MermaidBlock source={initial} />);

    await waitFor(() => expect(container.textContent).toContain("initial"));
    rerender(<MermaidBlock source={updated} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));

    expect(container.textContent).not.toContain("initial");
    expect(container.querySelector(".md-mermaid-status")).toBeTruthy();

    await act(async () => {
      refresh.resolve({ svg: "<svg><text>updated</text></svg>" });
      await refresh.promise;
    });
    expect(container.textContent).toContain("updated");
  });

  it("ignores an in-flight SVG that resolves after Settings opens", async () => {
    const sequence = "sequenceDiagram\n  A->>B: pending";
    const pending = deferred<{ svg: string }>();
    mermaidMock.render
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ svg: "<svg><text>final</text></svg>" });
    setState({
      settings: { ...SETTINGS },
      dialog: null,
      themeEffective: "dark",
    });
    const { container } = render(<MermaidBlock source={sequence} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));

    act(() => setState({ dialog: { kind: "settings" } }));
    await act(async () => {
      pending.resolve({ svg: "<svg><text>stale</text></svg>" });
      await pending.promise;
    });

    expect(container.textContent).not.toContain("stale");
    act(() =>
      setState({ settings: { ...SETTINGS, terminalTheme: "aurora" } }),
    );
    act(() => setState({ dialog: null }));

    await waitFor(() => expect(container.textContent).toContain("final"));
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
  });

  it("ignores an in-flight parse failure after Settings opens", async () => {
    const sequence = "sequenceDiagram\n  A->>B: pending failure";
    const pending = deferred<{ svg: string }>();
    mermaidMock.render
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ svg: "<svg><text>recovered</text></svg>" });
    setState({
      settings: { ...SETTINGS },
      dialog: null,
      themeEffective: "dark",
    });
    const { container } = render(<MermaidBlock source={sequence} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));

    act(() => setState({ dialog: { kind: "settings" } }));
    await act(async () => {
      pending.reject(new Error("stale parse failure"));
      await pending.promise.catch(() => undefined);
    });

    expect(container.querySelector("pre[data-lang='mermaid']")).toBeNull();
    act(() => setState({ dialog: null }));
    await waitFor(() => expect(container.textContent).toContain("recovered"));
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
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
