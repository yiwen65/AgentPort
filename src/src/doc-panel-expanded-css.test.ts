// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
}

describe("expanded document panel centering", () => {
  it("caps and centers the raw editor column", () => {
    const rule = ruleBody(".doc-panel.expanded .doc-editor");
    expect(rule).toContain("max-width: 828px");
    expect(rule).toContain("margin-inline: auto");
  });

  it("centers the preview/prose reading column", () => {
    const rule = ruleBody(".doc-panel.expanded .doc-prose");
    expect(rule).toContain("margin-inline: auto");
  });
});
