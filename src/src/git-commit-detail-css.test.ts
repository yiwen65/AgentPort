import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string) {
  const start = styles.lastIndexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close);
}

describe("long commit detail layout", () => {
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
