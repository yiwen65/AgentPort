// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function rule(selector: string): string {
  const match = styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("pane drop indicator rendering", () => {
  it("keeps the overlay out of hit testing", () => {
    // The overlay shows where a dragged Session lands; it must never become
    // the drag target. When it did, mounting it under the cursor changed
    // WebKit's drag target mid-gesture, GTK answered with a dragleave for the
    // element it covered, and the overlay strobed while the drop fell through
    // to the terminal surface (Linux).
    expect(rule("\\.pane-drop-overlay")).toContain("pointer-events: none");
  });

  it("keeps both drop direction labels available", () => {
    expect(rule("\\.pane-drop-zone\\.right")).not.toBe("");
    expect(rule("\\.pane-drop-zone\\.down")).not.toBe("");
  });
});
