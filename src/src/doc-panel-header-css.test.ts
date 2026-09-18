// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("document panel header tab strip", () => {
  it("never shrink-clips the mode tabs", () => {
    // The strip's overflow:hidden clips content when the flex item shrinks;
    // the file tabs truncate/scroll instead, so the mode tabs opt out of
    // shrinking (the eye icon was being cut on its right edge).
    const rule = styles.match(/^\.doc-panel-modes\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(rule).toContain("flex: 0 0 auto");
  });

  it("truncates long file names inside their tab", () => {
    const name = styles.match(/^\.doc-tab-name\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("overflow: hidden");
  });

  it("scrolls the tab strip horizontally instead of wrapping", () => {
    const strip = styles.match(/^\.doc-tabs\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(strip).toContain("overflow-x: auto");
    expect(strip).toContain("overflow-y: hidden");
  });

  it("marks preview tabs in italic (VSCode kept-open semantics)", () => {
    const preview = styles.match(/^\.doc-tab\.preview \.doc-tab-name\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(preview).toContain("font-style: italic");
  });
});
