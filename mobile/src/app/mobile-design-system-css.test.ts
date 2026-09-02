import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/app/styles.css", "utf8");
const terminalStyles = readFileSync("src/terminal/mobile-terminal.css", "utf8");
const workspace = readFileSync("src/features/sessions/SessionWorkspace.tsx", "utf8");

describe("mobile semantic design system", () => {
  it("uses neutral iOS-dark-inspired semantic color roles", () => {
    expect(styles).toContain("--bg: #000000");
    expect(styles).toContain("--panel: #1c1c1e");
    expect(styles).toContain("--panel-strong: #2c2c2e");
    expect(styles).toContain("--accent: #0a84ff");
    expect(styles).toContain("--success: #30d158");
    expect(styles).toContain("--warning: #ff9f0a");
    expect(styles).toContain("--danger: #ff453a");
  });

  it("keeps glass on navigation while presenting list content as grouped material", () => {
    expect(styles).toMatch(/\.mobile-session-sidebar \{[^}]*background: var\(--bg\);/s);
    expect(styles).toMatch(/\.mobile-sidebar-toolbar \{[^}]*background: var\(--nav-glass\);[^}]*backdrop-filter: blur\(26px\)/s);
    expect(styles).toMatch(/\.project-group \{[^}]*border-radius: 14px;[^}]*background: var\(--panel\);/s);
    expect(styles).toMatch(/\.active-agent-list \{[^}]*border-radius: 14px;[^}]*background: var\(--panel\);/s);
  });

  it("provides readable fallback sizes and WebKit system text roles", () => {
    expect(styles).toMatch(/\.mobile-workspace-caption strong \{[^}]*font-size: 28px;/s);
    expect(styles).toMatch(/\.project-toggle strong \{[^}]*font-size: 17px;/s);
    expect(styles).toMatch(/\.v2-session-row strong \{[^}]*font-size: 16px;/s);
    expect(styles).toMatch(/\.v2-session-row time \{[^}]*font-size: 13px;/s);
    expect(styles).toMatch(/@supports \(font: -apple-system-body\) \{[^}]*body \{ font: -apple-system-body; \}/s);
    expect(styles).toContain(".mobile-workspace-caption strong { font: -apple-system-title1;");
    expect(styles).toContain(".project-toggle strong { font: -apple-system-headline;");
  });

  it("preserves touch targets, accessibility fallbacks, and an opaque terminal", () => {
    expect(styles).toMatch(/\.agent-launch-strip button \{ width: 44px; height: 44px;/);
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[^}]*\.mobile-sidebar-toolbar \{[^}]*backdrop-filter: none;/s);
    expect(styles).toMatch(/@media \(prefers-contrast: more\)/);
    expect(styles).toMatch(/\.session-stage \{[^}]*background: var\(--terminal-bg\);/s);
    expect(terminalStyles).toMatch(/\.mobile-terminal-spike \{[^}]*background: var\(--terminal-bg\);/s);
    expect(workspace).toContain("useState(15)");
  });
});
