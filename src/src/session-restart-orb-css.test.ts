// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: RegExp): string | undefined {
  return styles.match(selector)?.[1];
}

describe("ended session restart orb", () => {
  it("keeps stopped history sharp behind the orb", () => {
    const ended = ruleBody(/\.term-pane\.ended \.xterm\s*\{([^}]*)\}/);
    expect(ended).not.toContain("blur");
    expect(ended).not.toContain("filter:");
    expect(ended).not.toContain("scale(");
  });

  it("draws one circular icon button with an entrance halo", () => {
    const orb = ruleBody(/\.session-restart-orb\s*\{([^}]*)\}/);
    expect(orb).toContain("border-radius: 50%");
    expect(orb).toContain("pointer-events: auto");
    expect(orb).toContain("animation: session-restart-orb-in");
    expect(styles).toContain("@keyframes session-restart-halo");
  });
});
