import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string, last = true) {
  const needle = `${selector} {`;
  const start = last ? styles.lastIndexOf(needle) : styles.indexOf(needle);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close);
}

describe("Git Center history layout", () => {
  it("uses a three-column hierarchy for history, detail, and diff", () => {
    const history = ruleBody(".git-center-body.history", false);
    expect(history).toMatch(/grid-template-columns:\s*minmax\(260px,\s*24%\)\s+minmax\(300px,\s*31%\)\s+minmax\(0,\s*1fr\)/);
    expect(ruleBody(".git-commit-patch-panel")).toMatch(/display:\s*flex/);
  });

  it("bounds the commit patch so its virtualized rows do not expand the whole panel", () => {
    expect(ruleBody(".git-commit-detail-panel")).toMatch(/display:\s*flex/);
    expect(ruleBody(".git-commit-detail-panel")).toMatch(/flex-direction:\s*column/);

    const patch = ruleBody(".git-commit-patch");
    expect(patch).toMatch(/display:\s*flex/);
    expect(patch).toMatch(/flex:\s*1 1 auto/);
    expect(patch).toMatch(/overflow:\s*auto/);

    const diff = ruleBody(".git-commit-patch .git-diff-code");
    expect(diff).toMatch(/min-height:\s*0/);
    expect(diff).toMatch(/flex:\s*1 1 auto/);
  });
});
