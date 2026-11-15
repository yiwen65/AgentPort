// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = styles.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!body) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

describe("markdown reader CSS", () => {
  it("scopes the dedicated reading palettes to the preview surface", () => {
    const paper = ruleBody('.doc-panel[data-doc-theme="paper"] .doc-preview-host');
    expect(paper).toContain("background: #f7f3e8");
    expect(paper).toContain("--term-text: #3a342b");
    const night = ruleBody('.doc-panel[data-doc-theme="night"] .doc-preview-host');
    expect(night).toContain("background: #1b1f27");
    expect(night).toContain("--term-text: #d8d3c8");
  });

  it("lays out the outline rail and reading progress bar", () => {
    expect(ruleBody(".doc-toc-rail")).toContain("width: 224px");
    expect(ruleBody(".doc-progress")).toContain("transform: scaleX(0)");
    expect(ruleBody(".doc-reading-layout")).toContain("display: flex");
  });

  it("keeps code wrap, line numbers and heading anchors token-driven", () => {
    expect(ruleBody(".md-code-line-content")).toContain("white-space: pre-wrap");
    expect(ruleBody('.md-preview[data-code-wrap="off"] .md-code-line-content')).toContain(
      "white-space: pre",
    );
    expect(ruleBody(".md-code-line::before")).toContain("counter(md-code-line)");
    expect(ruleBody(".md-heading-anchor")).toContain("position: absolute");
  });
});
