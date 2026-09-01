// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

describe("document panel body scroll model", () => {
  it("lays the body out as a clipping column flex container", () => {
    // Without this the raw editor sizes to the document height, the textarea
    // never scrolls internally, and its horizontal scrollbar sits past the
    // last line — unreachable without scrolling the whole document first.
    const rule = ruleBody(".doc-panel-body");
    expect(rule).toContain("display: flex");
    expect(rule).toContain("flex-direction: column");
    expect(rule).toContain("overflow: hidden");
  });

  it("lets the textarea scroll internally on both axes", () => {
    expect(ruleBody(".doc-editor-textarea")).toContain("overflow: auto");
    const editor = ruleBody(".doc-editor");
    expect(editor).toContain("flex: 1");
    expect(editor).toContain("min-height: 0");
  });

  it("makes the preview host its own scroll container", () => {
    const rule = ruleBody(".doc-preview-host");
    expect(rule).toContain("flex: 1");
    expect(rule).toContain("min-height: 0");
    expect(rule).toContain("overflow: auto");
  });
});
