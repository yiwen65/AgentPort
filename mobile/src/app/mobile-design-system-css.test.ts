import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/app/styles.css", "utf8");
const dashboardStyles = readFileSync("src/features/sessions/dashboard.css", "utf8");
const modalStyles = readFileSync("src/components/modal.css", "utf8");
const terminalStyles = readFileSync("src/terminal/mobile-terminal.css", "utf8");
const workspace = readFileSync("src/features/sessions/SessionWorkspace.tsx", "utf8");

describe("mobile semantic design system", () => {
  it("uses light, warm-gray semantic color roles", () => {
    expect(styles).toContain("--bg: #f3f2ef");
    expect(styles).toContain("--panel: #ffffff");
    expect(styles).toContain("--panel-strong: #eeefef");
    expect(styles).toContain("--accent: #285f9e");
    expect(styles).toContain("--success: #237548");
    expect(styles).toContain("--warning: #945a00");
    expect(styles).toContain("--danger: #b42332");
  });

  it("keeps glass on navigation while presenting list content as grouped material", () => {
    expect(styles).toMatch(/\.mobile-session-sidebar \{[^}]*background: var\(--bg\);/s);
    expect(styles).toMatch(/\.mobile-sidebar-toolbar \{[^}]*background: var\(--nav-glass\);[^}]*backdrop-filter: blur\(26px\)/s);
    expect(styles).toMatch(/\.project-group \{[^}]*border-radius: 14px;[^}]*background: var\(--panel\);/s);
    expect(styles).toMatch(/\.active-agent-list \{[^}]*border-radius: 14px;[^}]*background: var\(--panel\);/s);
  });

  it("uses low-intrusion liquid controls over the unified terminal background", () => {
    expect(styles).toMatch(/\.session-workspace-header button \{[^}]*background: transparent;[^}]*transition: transform 140ms/s);
    expect(styles).toMatch(/\.session-workspace-header button::before \{[^}]*inset: 3px;[^}]*background: linear-gradient\([^}]*backdrop-filter: blur\(18px\) saturate\(1\.18\);/s);
    expect(styles).toMatch(/\.terminal-back-button:active, \.terminal-more-button:active \{[^}]*transform: scale\(\.95\);/s);
    expect(styles).toMatch(/\.terminal-back-button:active::before, \.terminal-more-button:active::before \{[^}]*background: var\(--terminal-control-active-bg, rgba\(255, 255, 255, \.105\)\);/s);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*transition: none !important;/s);
  });

  it("provides readable fallback sizes and WebKit system text roles", () => {
    expect(styles).toMatch(/\.project-toggle strong \{[^}]*font-size: 17px;/s);
    expect(styles).toMatch(/\.v2-session-row strong \{[^}]*font-size: 16px;/s);
    expect(styles).toMatch(/\.v2-session-row time \{[^}]*font-size: 13px;/s);
    expect(styles).toMatch(/@supports \(font: -apple-system-body\) \{[^}]*body \{ font: -apple-system-body; \}/s);
    expect(styles).toContain(".project-toggle strong { font: -apple-system-headline;");
  });

  it("preserves touch targets, accessibility fallbacks, and an opaque terminal", () => {
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[^}]*\.mobile-sidebar-toolbar \{[^}]*backdrop-filter: none;/s);
    expect(styles).toMatch(/@media \(prefers-contrast: more\)/);
    expect(styles).toMatch(/\.session-stage \{[^}]*background: var\(--terminal-bg\);/s);
    expect(styles).toMatch(/\.session-workspace-header \{[^}]*border-bottom: 0;[^}]*background: var\(--terminal-bg\);[^}]*backdrop-filter: none;/s);
    expect(styles).toMatch(/\.terminal-status-stack \{ border-bottom: 0; background: var\(--terminal-bg\); \}/);
    expect(styles).toMatch(/\.terminal-back-button, \.terminal-more-button \{ width: 44px; height: 44px;/);
    expect(styles).toMatch(/\.terminal-mode-options label > span \{ min-height: 44px;/);
    expect(styles).toMatch(/\.mobile-terminal-theme-choice-body \{ min-height: 78px;/);
    expect(styles).toContain("outline: 3px solid var(--terminal-accent)");
    expect(styles).toMatch(/\.mobile-terminal-theme-copy strong \{[^}]*overflow-wrap: anywhere;/s);
    expect(styles).toContain("--terminal-bg: #282c34");
    expect(terminalStyles).toMatch(/\.mobile-terminal-spike \{[^}]*background: var\(--terminal-bg\);/s);
    expect(terminalStyles).toContain("background: var(--terminal-panel, rgba(44, 44, 46, .94));");
    expect(workspace).toContain("useState(15)");
    expect(dashboardStyles).toContain("min-width: 44px; min-height: 44px");
    expect(dashboardStyles).not.toContain("100dvh");
    expect(modalStyles).toContain("env(safe-area-inset-bottom)");
    expect(modalStyles).toContain("max-height: 100%");
    expect(modalStyles).toContain("prefers-reduced-transparency: reduce");
    expect(styles).not.toContain(".agent-launch-strip");
    expect(styles).not.toContain(".mobile-workspace-caption");
  });
});
