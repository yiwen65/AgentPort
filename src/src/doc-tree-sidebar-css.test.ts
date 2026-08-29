// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

describe("document tree sidebar design language", () => {
  it("shares the sidebar glass surface tokens", () => {
    const tree = ruleBody(".doc-tree");
    expect(tree).toContain("background-color: var(--sidebar-glass)");
    expect(tree).toContain("background-image: var(--sidebar-glass-layers, none)");
    expect(tree).toContain("border-left: 1px solid var(--sidebar-border)");
    expect(tree).not.toContain("--bg-panel");
  });

  it("marks selection with the sidebar frosted chip, not a bare accent bar", () => {
    const selected = ruleBody(".doc-tree-row.selected");
    expect(selected).toContain("background: var(--sidebar-row-active)");
    expect(selected).toContain("var(--sidebar-active-ring)");
    expect(selected).not.toContain("inset 2px 0 0");
  });

  it("keeps entry icons neutral (no loud amber folders)", () => {
    expect(ruleBody(".doc-tree-kind.dir")).toContain("color: var(--sidebar-icon)");
    expect(ruleBody(".doc-tree-kind.dir")).not.toContain("--amber");
    expect(ruleBody(".doc-tree-kind.file")).toContain(
      "color: var(--sidebar-text-faint)",
    );
  });
});
