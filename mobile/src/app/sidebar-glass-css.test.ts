import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/app/styles.css", "utf8");

describe("mobile source-list glass material", () => {
  it("shares the desktop sidebar's smoked glass, hierarchy, and selection treatment", () => {
    expect(styles).toContain("--sidebar-glass: rgba(13, 13, 19, 0.65)");
    expect(styles).toContain("--sidebar-row-active: rgba(107, 140, 255, 0.24)");
    expect(styles).toMatch(/\.mobile-session-sidebar \{[^}]*background-color: var\(--sidebar-glass\);[^}]*background-image: var\(--sidebar-glass-layers\);[^}]*backdrop-filter: blur\(28px\) saturate\(1\.4\) brightness\(0\.82\);/s);
    expect(styles).toMatch(/\.project-group \{ background: transparent; \}/);
    expect(styles).toMatch(/\.v2-session-row:has\([^}]*background: var\(--sidebar-row-active\);[^}]*var\(--sidebar-active-ring\)/s);
  });

  it("keeps the terminal opaque and supplies a solid reduced-transparency fallback", () => {
    expect(styles).toMatch(/\.session-stage \{[^}]*background: #18181e;/s);
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[^}]*\.mobile-session-sidebar \{[^}]*background-color: #202027;[^}]*backdrop-filter: none;/s);
  });
});
