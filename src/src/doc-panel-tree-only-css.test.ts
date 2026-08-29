// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("tree-only document panel width", () => {
  it("drives the tree column from --doc-tree-width so the sash can resize it", () => {
    // The sash writes --doc-tree-width on the panel; the CSS default keeps
    // the historical 184px when no override is present (SSR, tests).
    const treeRule = styles.match(/^\.doc-tree\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(treeRule).toContain("flex: 0 0 var(--doc-tree-width, 184px)");
    // No fixed pixel width anywhere on the tree-only panel: the component
    // computes tree + 1px separator inline.
    const panelRule = styles.match(/^\.doc-panel\.tree-only\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(panelRule ?? "").not.toContain("width");
  });
});
