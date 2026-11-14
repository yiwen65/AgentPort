// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: RegExp): string | undefined {
  return styles.match(selector)?.[1];
}

// An ended/interrupted Session still paints its terminal. The workspace
// surface behind the pane gutters and the underlapped titlebar strip must be
// the terminal's own background; the idle tone otherwise shows as horizontal
// bands above and below the xterm.
describe("terminal surface seam", () => {
  it("paints ended workspace states with the live terminal surface", () => {
    const ended = ruleBody(
      /\.app\[data-workspace-state="ended"\]\s*\{([^}]*)\}/,
    );
    expect(ended).toContain("--workspace-current: var(--workspace-live)");

    const live = ruleBody(
      /\.app\[data-workspace-state="live"\]\s*\{([^}]*)\}/,
    );
    expect(live).toContain("--workspace-current: var(--workspace-live)");
  });
});
