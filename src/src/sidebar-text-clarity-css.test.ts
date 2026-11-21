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
});
