// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("sidebar text clarity", () => {
  it("keeps the sidebar opaque without a backdrop blur", () => {
    expect(styles).toContain("--sidebar-glass: #292a2f;");
    expect(styles).toContain("--sidebar-glass: #f4f4f5;");
    expect(styles).not.toContain('data-vibrancy="on"');
    expect(styles).not.toMatch(/\.sidebar[^{]*\{[^}]*backdrop-filter/);
  });

  it("removes text halos without enlarging session rows", () => {
    expect(styles).toMatch(/\.sidebar-scroll\s*\{\s*text-shadow: none;/);
    expect(styles).not.toMatch(/text-shadow:\s*0 0\.5px/);
    expect(styles).toMatch(/\.tree-row\.session\s*\{[^}]*font-size: 13px;[^}]*font-weight: 500;/);
    expect(styles).toMatch(/\.tree-row\.project\s*\{[^}]*font-size: 13px;[^}]*font-weight: 600;/);
  });

  it("uses spacing rather than divider rules between project rows", () => {
    const groups = styles.match(
      /\.tree-project \+ \.tree-project\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(groups).toContain("margin-top: 4px");
    expect(groups).not.toContain("border-top");
    expect(styles).toMatch(
      /\.tree-project \+ \.tree-project\.unpinned-start\s*\{[^}]*margin-top: 14px;/,
    );
  });

  it("keeps the pinned-project marker subordinate to the project label", () => {
    expect(styles).toContain("--sidebar-pin: rgba(220, 211, 190, 0.62);");
    expect(styles).toContain("--sidebar-pin: rgba(76, 68, 52, 0.58);");
    expect(styles).toMatch(
      /\.project-pin-indicator\s*\{[^}]*color: var\(--sidebar-pin\);[^}]*opacity: 0\.82;/,
    );
    expect(styles).not.toMatch(
      /\.project-pin-indicator\s*\{[^}]*color: var\(--accent\);/,
    );
  });
});
