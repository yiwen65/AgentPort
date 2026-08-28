// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

describe("font zoom CSS wiring", () => {
  it("scales the document raw editor and gutter together", () => {
    expect(ruleBody(".doc-editor-textarea")).toContain(
      "calc(12px * var(--doc-font-scale, 1))",
    );
    expect(ruleBody(".doc-editor-gutter")).toContain(
      "calc(12px * var(--doc-font-scale, 1))",
    );
  });

  it("scales the document preview and prose", () => {
    expect(ruleBody(".md-preview")).toContain(
      "font-size: calc(13px * var(--doc-font-scale, 1))",
    );
    expect(ruleBody(".doc-prose")).toContain(
      "font-size: calc(13px * var(--doc-font-scale, 1))",
    );
  });

  it("scales the pi timeline with the terminal zoom var", () => {
    expect(ruleBody(".pi-rpc-event pre")).toContain(
      "calc(12px * var(--term-font-scale, 1))",
    );
    expect(ruleBody(".pi-rpc-composer textarea")).toContain(
      "calc(13px * var(--term-font-scale, 1))",
    );
  });
});
