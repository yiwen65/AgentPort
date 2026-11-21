// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("sidebar window-drag rendering", () => {
  it("keeps the sidebar free of backdrop filters and drag-only overrides", () => {
    expect(styles).not.toContain('data-vibrancy="on"');
    expect(styles).not.toContain("body.is-window-dragging .sidebar");
    expect(styles).not.toMatch(/\.sidebar[^{]*\{[^}]*backdrop-filter/);
  });
});
