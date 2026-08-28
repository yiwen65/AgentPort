// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("document preview text selection", () => {
  it("opts the preview host back into text selection", () => {
    // Global chrome rule disables selection; the document preview is
    // read-only content that must stay selectable for copy/quote.
    expect(styles).toMatch(/body\s*\{[^}]*user-select:\s*none/);
    const hostRule = styles.match(/\.doc-preview-host\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(hostRule).toContain("-webkit-user-select: text");
    expect(hostRule).toContain("user-select: text");
  });
});
