// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("tree-only document panel width", () => {
  it("pins the panel to the tree footprint so the tree hugs the window edge", () => {
    // The tree column is a fixed 184px; tree-only mode must give the aside an
    // explicit width (tree + 1px separator), or the width:auto panel sizes to
    // the nowrap rows' max-content and leaves a void at the window edge.
    const treeRule = styles.match(/\.doc-tree\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(treeRule).toContain("flex: 0 0 184px");
    const panelRule = styles.match(/\.doc-panel\.tree-only\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(panelRule).toContain("width: 185px");
  });
});
