import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { FileContent } from "./FileContent";
import { MermaidDiagram } from "./MermaidDiagram";
import { renderDiagram } from "./mermaidRenderer";
vi.mock("./mermaidRenderer", () => ({ renderDiagram: vi.fn() }));
const source = "flowchart LR\n A([人类意图]) --> B[第一性原理<br/>AI 是镜子]\n";
const svg = '<svg><text>人类意图</text></svg>';
beforeEach(async () => { await i18n.changeLanguage("en-US"); vi.mocked(renderDiagram).mockReset().mockResolvedValue(svg); });
afterEach(cleanup);
describe("Mermaid Markdown blocks", () => {
  it("renders fenced Mermaid as a diagram but leaves source mode and other languages literal", async () => {
    const { container, rerender } = render(<FileContent path="notes.md" content={"```mermaid\n" + source + "```"} rendered onOpen={() => {}} />);
    expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toHaveTextContent("人类意图");
    expect(renderDiagram).toHaveBeenCalledWith(source, "dark", expect.any(Function));
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector(".files-diagram-scroll")).toHaveAttribute("data-horizontal-scroll", "true");
    rerender(<FileContent path="notes.md" content={"```mermaid\n" + source + "```"} rendered={false} onOpen={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull(); expect(container.querySelector("pre")?.textContent).toContain(source);
    rerender(<FileContent path="notes.md" content={"```text\n" + source + "```"} rendered onOpen={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull(); expect(container.querySelector("pre")?.textContent).toContain(source);
  });
  it("falls back to exact source with a notice when rendering fails", async () => {
    vi.mocked(renderDiagram).mockRejectedValueOnce(new Error("Bad syntax"));
    const { container } = render(<MermaidDiagram source={source} />);
    expect(await screen.findByText(/Source is shown instead/)).toBeVisible();
    expect(container.querySelector("pre")?.textContent).toBe(source);
  });
  it("ignores obsolete results after source changes or unmounts", async () => {
    let finish!: (value: string) => void;
    vi.mocked(renderDiagram).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender, unmount } = render(<MermaidDiagram source="old" />);
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1));
    const oldCurrent = vi.mocked(renderDiagram).mock.calls[0][2]!;
    rerender(<MermaidDiagram source="new" />);
    expect(await screen.findByRole("img")).toBeVisible(); expect(oldCurrent()).toBe(false);
    await act(async () => finish('<svg><text>obsolete</text></svg>'));
    expect(screen.queryByText("obsolete")).toBeNull();
    const current = vi.mocked(renderDiagram).mock.calls[1][2]!; unmount(); expect(current()).toBe(false);
  });
});
