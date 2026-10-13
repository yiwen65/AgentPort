import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderDiagram, safeMermaidSource, sanitizeDiagram } from "./mermaidRenderer";
const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: engine }));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 100"><text>人类意图</text></svg>';
beforeEach(() => { engine.initialize.mockReset(); engine.render.mockReset().mockResolvedValue({ svg }); });

describe("safe Mermaid rendering", () => {
  it("supports Chinese labels and br line breaks", () => expect(safeMermaidSource("flowchart LR\n A([人类意图]) --> B[意图心法<br/>翻译为可执行]" )).toBe(true));
  it.each(["---\nconfig: {}\n---\nflowchart LR", "%%{init: {securityLevel: 'loose'}}%%\nflowchart LR", 'flowchart LR\nclick A "https://example.com"', 'flowchart LR\nA@{img: "relative.png"}', 'flowchart LR\nA@{ "img": "relative.png" }', 'flowchart LR\nA@{ "\\x69mg": "\\x68ttps:\\x2f\\x2fattacker.example/pixel.png" }', 'flowchart LR\nA-->B; classDef A fill:u\\72l(/resource.svg#paint)', 'flowchart LR\nA[<img src="relative.png">]', 'flowchart LR\nclassDef a fill:url(remote.png)', "x".repeat(20_001)])("rejects configuration/assets/interactions or oversized input", async source => {
    expect(safeMermaidSource(source)).toBe(false);
    await expect(renderDiagram(source, "light")).rejects.toThrow(); expect(engine.render).not.toHaveBeenCalled();
  });
  it("sanitizes executable SVG, remote resources and links while retaining text and local markers", () => {
    const clean = sanitizeDiagram('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 100" onload="alert(1)"><script>alert(1)</script><foreignObject><div>html</div></foreignObject><image href="https://bad.example/image.png"/><a href="https://bad.example"><text>safe label</text></a><style>@import "https://bad.example/a.css";</style><path style="fill:url(remote.svg)"/><path style="fill:u\\72l(/resource.svg#paint)"/><path marker-end="url(#arrow)"/><animate attributeName="href" values="https://bad.example"/></svg>');
    const root = new DOMParser().parseFromString(clean, "image/svg+xml");
    expect(root.querySelector("script, foreignObject, image, a, animate, style")).toBeNull();
    expect(root.querySelector("[onload], [href], [style]")).toBeNull(); expect(clean).not.toContain("bad.example");
    expect(root.querySelector("text")?.textContent).toBe("safe label");
    expect(root.querySelector("[marker-end]")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(root.documentElement.getAttribute("width")).toBe("900");
  });
  it("serializes global initialization and cleans its measuring host even on failure", async () => {
    let finish!: (value: { svg: string }) => void;
    engine.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = renderDiagram("flowchart LR\nA-->B", "dark");
    const second = renderDiagram("sequenceDiagram\nA->>B: hello", "light");
    await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1));
    expect(engine.initialize).toHaveBeenCalledTimes(1);
    expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false, theme: "dark", maxEdges: 200 }));
    finish({ svg }); await first; await second;
    expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
    expect(document.querySelector("[data-mermaid-measure]")).toBeNull();
    engine.render.mockRejectedValueOnce(new Error("Parse failure"));
    await expect(renderDiagram("invalid", "dark")).rejects.toThrow();
    expect(document.querySelector("[data-mermaid-measure]")).toBeNull();
    await expect(renderDiagram("flowchart LR\nA-->B", "dark")).resolves.toContain("<svg");
  });
  it("skips stale jobs before touching global configuration", async () => {
    expect(await renderDiagram("flowchart LR\nA-->B", "dark", () => false)).toBeNull();
    expect(engine.initialize).not.toHaveBeenCalled();
  });
});
