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

  it("contains selection actions inside the editor column, not the whole window", () => {
    const column = styles.match(/^\.doc-editor-column\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(column).toContain("container: doc-editor / inline-size");
    const header = styles.match(/^\.doc-panel-header\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(header).toContain("flex-wrap: wrap");
    const quote = styles.match(/^\.doc-quote\s*\{([\s\S]*?)\n\}/m)?.[1];
    expect(quote).toContain("min-width: 0");
    expect(quote).toContain("max-width: 100%");
    expect(quote).toContain("text-overflow: ellipsis");
    expect(quote).toContain("overflow: hidden");
  });

  it("moves Quote Selection to its own row in narrow editor columns", () => {
    const compact = styles.match(/@container doc-editor \(max-width: 560px\)\s*\{\s*\.doc-quote\s*\{([\s\S]*?)\n  \}/)?.[1];
    expect(compact).toContain("order: 1");
    expect(compact).toContain("flex: 1 1 100%");
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
