// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function classSpecificity(selector: string): number {
  return (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
}

describe("sidebar window-drag rendering", () => {
  it("lets the drag override disable the themed backdrop filter", () => {
    const themedSelector =
      ':root[data-vibrancy="on"][data-theme="dark"] .sidebar';
    const dragSelector =
      ':root[data-vibrancy="on"] body.is-window-dragging .sidebar';

    expect(styles).toContain(themedSelector);
    expect(styles).toContain(dragSelector);
    expect(classSpecificity(dragSelector)).toBeGreaterThanOrEqual(
      classSpecificity(themedSelector),
    );

    const dragRule = styles.match(
      /:root\[data-vibrancy="on"\] body\.is-window-dragging \.sidebar\s*\{([^}]*)\}/,
    )?.[1];
    expect(dragRule).toContain("backdrop-filter: none");
    expect(dragRule).toContain("-webkit-backdrop-filter: none");
  });
});
