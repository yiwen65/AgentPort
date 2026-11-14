import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

describe("AI Provider settings action row spacing", () => {
  it("separates the save/clear buttons from the form above and the privacy note below", () => {
    const rule = styles
      .split(".commit-ai-settings-actions {")[1]
      ?.split("}")[0];
    expect(rule, "missing .commit-ai-settings-actions rule").toBeDefined();
    expect(rule).toMatch(/margin:\s*20px\s+0\s+22px;/);
  });
});
