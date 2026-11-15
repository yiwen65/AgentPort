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

  it("uses the 13px VSCode-explorer row font", () => {
    expect(ruleBody(".doc-tree-row")).toContain("font-size: 13px");
    expect(ruleBody(".doc-tree-rename-input")).toContain("font-size: 13px");
  });

  it("aligns sibling names with one shared leading slot width", () => {
    // Chevron slot (dirs) and type-icon slot (files) must be identical —
    // otherwise file names stair-step right of directory names.
    expect(ruleBody(".doc-tree-icon")).toContain("flex: 0 0 14px");
    expect(ruleBody(".doc-tree-kind")).toContain("flex: 0 0 14px");
  });

  it("keeps directories icon-free (chevron only) and file icons neutral", () => {
    // Directory rows render no kind icon at all — the chevron alone marks
    // them — so no folder-color rule may creep back in.
    expect(ruleBody(".doc-tree-kind.dir")).toBeUndefined();
    expect(ruleBody(".doc-tree-kind.file")).toContain(
      "color: var(--sidebar-text-faint)",
    );
    expect(ruleBody(".doc-tree-kind.file")).not.toContain("--amber");
  });

  it("carries the tree surface into the title bar", () => {
    const backdrop = styles.match(
      /\.topbar > \.topbar-tree-backdrop\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(backdrop).toContain("width: var(--doc-tree-topbar-width, 0px)");
    expect(backdrop).toContain("background-color: var(--sidebar-glass)");
    expect(backdrop).toContain("background-image: var(--sidebar-glass-layers, none)");
    expect(backdrop).toContain("z-index: 0");
  });

  it("collapses header actions out of layout until they are shown", () => {
    const actions = ruleBody(".doc-tree-actions");
    expect(actions).toContain("max-width: 0");
    expect(actions).toContain("overflow: hidden");
    expect(actions).toContain("pointer-events: none");
    const expanded = styles.match(
      /\.doc-tree:hover \.doc-tree-actions,[\s\S]*?\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(expanded).toContain("max-width: 180px");
    expect(expanded).toContain("pointer-events: auto");
  });
});
