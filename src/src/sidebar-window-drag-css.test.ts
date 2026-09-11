// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("sidebar reading surface", () => {
  it("uses opaque backgrounds in every theme, independent of wallpaper", () => {
    const surfaces = [...styles.matchAll(/--sidebar-glass:\s*([^;]+);/g)];
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    for (const [, color] of surfaces) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(styles).not.toMatch(/--sidebar-glass-layers:\s*linear-gradient/);
  });

  it("avoids backdrop recomposition during window dragging and text halos", () => {
    const sidebarRules = [...styles.matchAll(/(?:^|\n)([^{}]*\.sidebar)\s*\{([^}]*)\}/g)];
    for (const [, , rule] of sidebarRules) {
      expect(rule).not.toMatch(/backdrop-filter:\s*(?!none)[a-z]+\(/);
    }
    expect(styles).toMatch(/\.sidebar-scroll\s*\{\s*text-shadow: none;/);
    expect(styles).not.toMatch(/text-shadow:\s*0 0\.5px/);
  });

  it("gives session titles more room without making metadata bold", () => {
    expect(styles).toMatch(/\.tree-row\.session\s*\{[^}]*min-height: 30px;[^}]*font-size: 14px;/);
    expect(styles).toMatch(/\.session-age\s*\{[^}]*font-weight: 400;[^}]*font-variant-numeric: tabular-nums;/);
  });
});
