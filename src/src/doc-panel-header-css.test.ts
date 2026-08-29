// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("document panel header tab strip", () => {
  it("never shrink-clips the mode tabs", () => {
    // The strip's overflow:hidden clips content when the flex item shrinks;
    // the file name is the truncatable element, so the tabs opt out of
    // shrinking (the eye icon was being cut on its right edge).
    const rule = styles.match(/^\.doc-panel-modes\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(rule).toContain("flex: 0 0 auto");
    const name = styles.match(/^\.doc-panel-name\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(name).toContain("text-overflow: ellipsis");
  });
});
