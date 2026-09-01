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

  it("widens the preview/prose reading column with the window", () => {
    // The preview keeps a readable measure, but it follows the window up to
    // a generous cap instead of the docked panel's fixed 780px column.
    const rule = ruleBody(".doc-panel.expanded .doc-prose");
    expect(rule).toContain("max-width: 1120px");
    expect(rule).toContain("margin-inline: auto");
    expect(rule).toContain("padding-inline: clamp(24px, 5vw, 64px)");
  });
});
