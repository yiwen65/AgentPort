// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Stacking contract for the topbar click-through regression (device switcher
// trigger/menu and the PairDevice modal lost hit testing to higher-z pane
// chrome because .topbar trapped them in an isolated z-3 slot; clicks fell
// through to the terminal workspace).

const styles = readFileSync("src/styles.css", "utf8");
const devicesCss = readFileSync("src/components/devices.css", "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1];
}

describe("topbar stacking vs workspace chrome", () => {
  it("keeps the topbar above every workspace child layer", () => {
    const topbar = ruleBody(styles, ".topbar");
    expect(topbar).toContain("isolation: isolate");
    const zIndex = Number(topbar.match(/z-index:\s*(\d+)/)?.[1]);
    // Workspace children reach z-40 (pane headers, scrollbar edge targets,
    // statuslines, drop overlays); the bar must clear them all while staying
    // below menus/settings (700+). See the .topbar rule comment.
    expect(zIndex).toBeGreaterThanOrEqual(50);
    expect(zIndex).toBeLessThan(600);
    expect(topbar).toContain("clicks fall through");
  });

  it("anchors the device picker menu at the context-menu layer", () => {
    const menu = ruleBody(devicesCss, ".device-picker-menu");
    // The menu is portaled to document.body; fixed positioning (anchored via
    // inline style) plus the ctx-menu z-layer keeps it hit-testable above
    // pane chrome.
    expect(menu).toContain("position: fixed");
    const zIndex = Number(menu.match(/z-index:\s*(\d+)/)?.[1]);
    expect(zIndex).toBeGreaterThanOrEqual(700);
    expect(zIndex).toBeLessThan(1100);
  });
});
