// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("sidebar text clarity on glass", () => {
  it("preserves translucent surfaces and backdrop blur in both themes", () => {
    expect(styles).toContain("--sidebar-glass: rgba(13, 13, 19, 0.65);");
    expect(styles).toContain("--sidebar-glass: rgba(250, 250, 253, 0.55);");
    for (const theme of ["dark", "light"]) {
      const rule = styles.split(`:root[data-vibrancy="on"][data-theme="${theme}"] .sidebar {`)[1]?.split("}")[0];
      expect(rule).toContain("backdrop-filter: blur(28px)");
    }
  });

  it("removes text halos without enlarging session rows", () => {
    expect(styles).toMatch(/\.sidebar-scroll\s*\{\s*text-shadow: none;/);
    expect(styles).not.toMatch(/text-shadow:\s*0 0\.5px/);
    expect(styles).toMatch(/\.tree-row\.session\s*\{[^}]*font-size: 13px;[^}]*font-weight: 500;/);
    expect(styles).toMatch(/\.tree-row\.project\s*\{[^}]*font-size: 13px;[^}]*font-weight: 600;/);
  });
});
