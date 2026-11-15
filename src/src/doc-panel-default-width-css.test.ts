// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("document panel default width", () => {
  it("shares the terminal page evenly until the sash is dragged", () => {
    const rule = styles.match(/\.doc-panel\.auto-width\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(rule).toContain("width: max(50%, 320px)");
  });
});
