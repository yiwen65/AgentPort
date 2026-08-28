// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
}

describe("storage cleanup layout", () => {
  it("contains large legacy inventories inside a bounded scroller", () => {
    const list = ruleBody(".legacy-log-list");
    expect(list).toContain("max-height:");
    expect(list).toContain("min-width: 0");
    expect(list).toContain("overflow: auto");
  });

  it("truncates long Session identifiers instead of widening the page", () => {
    const session = ruleBody(".legacy-log-session");
    expect(session).toContain("min-width: 0");
    expect(session).toContain("overflow: hidden");
    expect(session).toContain("text-overflow: ellipsis");
    expect(session).toContain("white-space: nowrap");
  });
});
