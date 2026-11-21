// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
}

describe("expanded document panel layout", () => {
  it("keeps the raw editor full-bleed with no centered column cap", () => {
    // Long lines must use the whole window before scrolling; a fixed
    // max-width column wastes the expanded surface and truncates early.
    const rule = ruleBody(".doc-panel.expanded .doc-editor");
    expect(rule ?? "").not.toContain("max-width");
  });

  it("centers the preview reading column and lets it follow the pane", () => {
    // One measure for docked, widened and expanded panels: centered in the
    // pane and grown with the editor column (cqw) up to a readable cap, so a
    // wide window no longer leaves a narrow strip pinned to one edge.
    const prose = ruleBody(".doc-prose") ?? "";
    expect(prose).toContain("margin-inline: auto");
    expect(prose).toContain("max-width: clamp(46rem, 72cqw, 70rem)");
    expect(prose).toContain("padding: 20px clamp(24px, 4cqw, 56px) 36px");

    const preview = ruleBody(".md-preview") ?? "";
    expect(preview).toContain("margin-inline: auto");
    expect(preview).toContain("max-width: clamp(46rem, 72cqw, 70rem)");
    expect(preview).toContain("padding: 24px clamp(24px, 4cqw, 56px) 48px");
  });

  it("does not shrink the expanded preview back to the docked measure", () => {
    expect(styles).not.toContain(".doc-panel.expanded .md-preview");
  });

  it("removes a folded viewer surface like an empty document workspace", () => {
    const folded = ruleBody(".doc-panel.collapsed") ?? "";
    expect(folded).toContain("display: none");
  });
});
