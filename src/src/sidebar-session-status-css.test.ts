// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("sidebar session status markers", () => {
  it("hides non-working state dots while keeping their layout slot", () => {
    const rule = styles.match(
      /\.tree-row\.session \.dot:not\(\.working\)\s*\{([^}]*)\}/,
    )?.[1];

    expect(rule).toContain("visibility: hidden");
    expect(rule).not.toContain("display: none");
  });
});
