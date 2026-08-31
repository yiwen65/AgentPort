// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const terminalArea = readFileSync("src/components/TerminalArea.tsx", "utf8");

function classSpecificity(selector: string): number {
  return (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
}

function ruleBody(selector: RegExp): string | undefined {
  return styles.match(selector)?.[1];
}

// The attach/replay skeleton must fully mask the terminal: xterm paints every
// intermediate replay state while the veil is up, and the default translucent
// `.term-overlay` (designed so ended sessions keep history visible) let the
// user watch the whole retained tail race by (高频刷屏).
describe("terminal attach/replay veil", () => {
  it("keeps warm restore silent until xterm renders, while cold attach uses the skeleton", () => {
    expect(terminalArea).toContain(
      "shouldShowTerminalAttachOverlay(r, warmPreview)",
    );
    expect(terminalArea).toContain("!isTerminalPreviewRendered(ses.id)");
    expect(terminalArea).toContain(
      '<div className="term-overlay term-overlay-solid" aria-hidden />',
    );
    const skeleton = terminalArea.match(
      /function SkeletonOverlay[\s\S]*?<div className="([^"]+)">/,
    )?.[1];
    expect(skeleton).toBe("term-overlay term-overlay-solid");
  });

  it("defines an opaque solid veil that out-specifics both translucent defaults", () => {
    const solid = ruleBody(/\.term-overlay\.term-overlay-solid\s*\{([^}]*)\}/);
    expect(solid).toContain("background: var(--bg)");
    // No alpha channel — the veil must hide the racing replay pixels.
    expect(solid).not.toContain("rgba(");

    const baseTranslucent = ".term-overlay {";
    expect(styles).toContain(baseTranslucent);
    expect(classSpecificity(".term-overlay.term-overlay-solid")).toBeGreaterThan(
      classSpecificity(".term-overlay"),
    );

    const lightTranslucent = ':root[data-theme="light"] .term-overlay';
    const lightSolid =
      ':root[data-theme="light"] .term-overlay.term-overlay-solid';
    expect(styles).toContain(lightTranslucent);
    const lightSolidBody = ruleBody(
      /:root\[data-theme="light"\] \.term-overlay\.term-overlay-solid\s*\{([^}]*)\}/,
    );
    expect(lightSolidBody).toContain("background: var(--bg)");
    expect(classSpecificity(lightSolid)).toBeGreaterThanOrEqual(
      classSpecificity(lightTranslucent),
    );
    // The light translucent override must not win by source order either.
    expect(styles.indexOf(lightSolid)).toBeGreaterThan(
      styles.indexOf(lightTranslucent),
    );
  });

  it("keeps the pane-local overlay reset stronger than the later base rule", () => {
    const paneSelector = ".pane-terminal-renderer > :is(.term-overlay)";
    const pane = ruleBody(
      /\.pane-terminal-renderer > :is\(\.term-overlay\)\s*\{([^}]*)\}/,
    );
    expect(pane).toContain("top: 0");
    expect(pane).toContain("padding-top: 0");
    expect(classSpecificity(paneSelector)).toBeGreaterThan(
      classSpecificity(".term-overlay"),
    );
  });

  it("keeps ended/interrupted overlays translucent (history stays visible)", () => {
    const base = ruleBody(/\.term-overlay\s*\{([^}]*)\}/);
    expect(base).toContain("rgba(");
  });
});
