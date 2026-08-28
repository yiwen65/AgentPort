import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string, from = 0) {
  const start = styles.indexOf(selector, from);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close);
}

describe("fullscreen Settings centering", () => {
  it("centers the header, every section, and the dirty-action row in the workspace", () => {
    const mediaStart = styles.indexOf("@media (min-width: 1200px)");
    expect(mediaStart, "missing fullscreen Settings breakpoint").toBeGreaterThanOrEqual(0);

    const centeredGutter = /padding-inline:\s*max\(48px,\s*calc\(\(100% - 690px\) \/ 2\)\)/;
    expect(ruleBody(".settings-page-header", mediaStart)).toMatch(centeredGutter);
    expect(ruleBody(".settings-content", mediaStart)).toMatch(centeredGutter);
    expect(ruleBody(".settings-page-footer", mediaStart)).toMatch(centeredGutter);

    expect(ruleBody(".settings-content > *", mediaStart)).toMatch(/width:\s*100%/);
  });
});
