// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("Task Hub board layout", () => {
  it("uses the available pane for two-column issue boards", () => {
    const rule = styles.match(/\.task-center-board-columns-2\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("repeat(2, minmax(0, 1fr))");
  });
});
