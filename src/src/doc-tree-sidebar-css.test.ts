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
    expect(tree).toContain(
      "background-color: var(--doc-tree-surface, var(--sidebar-glass))",
    );
    expect(tree).toContain("var(--doc-tree-glaze, none)");
    expect(tree).toContain("var(--sidebar-glass-layers, none)");
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

  it("keeps file-state colors readable across themes and subordinate to selection", () => {
    expect(styles).toContain("--doc-git-modified: #d5b56b;");
    expect(styles).toContain("--doc-git-modified: #8a6200;");
    expect(styles).toContain("--doc-git-added: #7acb84;");
    expect(styles).toContain("--doc-git-added: #2f7d42;");
    expect(styles).toContain(".doc-tree-row.selected .doc-tree-name");
    expect(styles).toContain(".doc-tree-row.selected.git-dimmed");
  });

  it("uses sidebar-local material for tree inputs", () => {
    expect(styles).toContain("background: var(--sidebar-input);");
    expect(styles).toContain("border: 1px solid var(--sidebar-input-border);");
    expect(styles).toContain(".doc-tree-search input:focus");
    expect(ruleBody(".doc-tree-create")).toContain(
      "border-bottom: 1px solid var(--sidebar-border)",
    );
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
    expect(backdrop).toContain(
      "background-color: var(--doc-tree-surface, var(--sidebar-glass))",
    );
    expect(backdrop).toContain("var(--sidebar-top-layer-1, transparent)");
    expect(backdrop).toContain("var(--sidebar-top-layer-2, transparent)");
    expect(backdrop).toContain("z-index: 0");
    // No vertical rule in the title bar: the tree's own edge starts at the
    // panel top, below the bar.
    expect(backdrop).not.toContain("border-left");
    // The neutral surface intentionally has no decorative gradient stops.
    expect(styles).toContain("--sidebar-top-layer-1: transparent");
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
