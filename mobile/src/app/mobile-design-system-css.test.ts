import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAppThemeVariables } from "./appAppearance";
import { getMobileTerminalPalette, MOBILE_TERMINAL_THEME_IDS, MOBILE_TERMINAL_THEME_MODES } from "../terminal/terminalThemes";

const styles = readFileSync("src/app/styles.css", "utf8");
const dashboardStyles = readFileSync("src/features/sessions/dashboard.css", "utf8");
const modalStyles = readFileSync("src/components/modal.css", "utf8");
const terminalStyles = readFileSync("src/terminal/mobile-terminal.css", "utf8");
const workspace = readFileSync("src/features/sessions/SessionWorkspace.tsx", "utf8");

function contrast(first: string, second: string) {
  const luminance = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + .05) / (values[0] + .05);
}

describe("mobile semantic design system", () => {
  it("locks the native app viewport scale, including blank areas outside touch-action targets", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/name="viewport"[^>]*initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover/);
  });

  it("bounds the root frame and scrolls dashboard content without boundary bounce", () => {
    expect(styles).toMatch(/html, body, #root\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*touch-action:\s*pan-y;/s);
    expect(styles).toMatch(/body\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.main-content\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*none;/s);
  });

  it("disables native selection and callouts for app chrome, including body-level portals", () => {
    expect(styles).toMatch(/body\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;[^}]*-webkit-touch-callout:\s*none;/s);
  });

  it("keeps native selection and paste menus available in editable fields", () => {
    expect(styles).toMatch(/input, textarea, \[contenteditable=\"true\"\], \[contenteditable=\"plaintext-only\"\]\s*\{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;[^}]*-webkit-touch-callout:\s*default;/s);
  });

  it("preserves copyable fingerprints and xterm's own selection surface", () => {
    expect(styles).toMatch(/\.fingerprint\s*\{[^}]*-webkit-user-select:\s*all;[^}]*user-select:\s*all;[^}]*-webkit-touch-callout:\s*default;/s);
    expect(terminalStyles).toMatch(/\.mobile-terminal-surface\s*\{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s);
  });

  it("limits action-sheet close-button sizing to the direct header child", () => {
    expect(styles).not.toContain(".terminal-actions-sheet > header button");
    expect(styles).toContain(".terminal-actions-sheet > header > button");
    expect(modalStyles).toContain("grid-template-columns: minmax(0, 1fr) 36px 36px");
  });

  it("derives app colors from all six terminal palettes, without a separate app palette", () => {
    expect(styles).not.toContain("--bg: #edf3f9");
    expect(styles).not.toContain("--bg: #080f1d");
    expect(dashboardStyles).toContain("grid-template-rows: 0fr");
    expect(dashboardStyles).toContain("grid-template-rows: 1fr");
    expect(dashboardStyles).toContain("prefers-reduced-motion: reduce");
    for (const theme of MOBILE_TERMINAL_THEME_IDS) for (const mode of MOBILE_TERMINAL_THEME_MODES) {
      const palette = getMobileTerminalPalette(theme, mode);
      const variables = getAppThemeVariables(theme, mode);
      expect(variables["--bg"]).toBe(palette.xterm.background);
      expect(variables["--panel"]).toBe(palette.workspace.raisedBackground);
      expect(variables["--fill"]).toBe(palette.workspace.codeBackground);
      for (const bg of ["--bg", "--panel", "--fill"]) {
        for (const fg of ["--text", "--muted"]) expect(contrast(variables[fg], variables[bg]), `${theme}/${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const fg of ["--accent", "--mark-cyan", "--mark-blue", "--mark-violet", "--mark-dot"]) expect(contrast(variables[fg], variables[bg]), `${theme}/${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(variables["--primary-fg"], variables["--accent"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps glass on navigation while presenting list content as grouped material", () => {
    expect(styles).toMatch(/\.mobile-session-sidebar \{[^}]*background: var\(--bg\);/s);
    expect(styles).toMatch(/\.mobile-sidebar-toolbar \{[^}]*background: var\(--nav-glass\);[^}]*backdrop-filter: blur\(26px\)/s);
    expect(styles).toMatch(/\.project-group \{[^}]*border-radius: 14px;[^}]*background: var\(--panel\);/s);
    expect(styles).toMatch(/\.active-agent-list \{[^}]*gap: 8px;[^}]*margin: 12px 12px 0;/s);
    expect(styles).toMatch(/\.active-agent-list > \.v2-session-row \{[^}]*border-radius: 12px;[^}]*background: var\(--panel\);/s);
    expect(styles).toMatch(/\.v2-session-row > button \{[^}]*min-height: 48px;[^}]*align-items: center;/s);
    expect(styles).not.toContain(".session-row-meta");
  });

  it("places immersive chrome out of flow and keeps logs just below the cutout", () => {
    expect(terminalStyles).toMatch(/\.terminal-chrome-reveal,\s*\.session-workspace-header \{[^}]*position: absolute;[^}]*top: 0;/s);
    expect(terminalStyles).toContain("grid-template-columns: minmax(0, 1fr) 40% minmax(0, 1fr)");
    expect(terminalStyles).toContain(".session-workspace-header[hidden] { display: none; }");
    expect(terminalStyles).toMatch(/\.session-workspace \.mobile-terminal-surface \{[^}]*padding:\s*2px/s);
    expect(terminalStyles).toContain("prefers-reduced-motion: reduce");
    expect(styles).not.toContain(".terminal-back-button");
    expect(styles).not.toContain(".session-workspace-header {");
    expect(workspace).not.toContain("session-project-branch");
  });

  it("provides readable fallback sizes and WebKit system text roles", () => {
    expect(styles).toMatch(/\.project-toggle strong \{[^}]*font-size: 17px;/s);
    expect(styles).toMatch(/\.v2-session-row \.session-row-copy strong \{[^}]*white-space: nowrap;[^}]*font-size: 16px;/s);
    expect(styles).toMatch(/\.v2-session-row time \{[^}]*font-size: 13px;/s);
    expect(styles).toMatch(/@supports \(font: -apple-system-body\) \{[^}]*body \{ font: -apple-system-body; \}/s);
    expect(styles).toContain(".project-toggle strong { font: -apple-system-headline;");
  });

  it("preserves touch targets, accessibility fallbacks, and an opaque terminal", () => {
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[^}]*\.mobile-sidebar-toolbar \{[^}]*backdrop-filter: none;/s);
    expect(styles).toMatch(/@media \(prefers-contrast: more\)/);
    expect(styles).toMatch(/\.session-stage \{[^}]*background: var\(--terminal-bg\);/s);
    expect(styles).toMatch(/\.terminal-status-stack \{ border-bottom: 0; background: var\(--terminal-bg\); \}/);
    expect(terminalStyles).toMatch(/\.terminal-more-button \{[^}]*width: 44px;\s*height: 44px;/s);
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
    // Row layout has one owner; importing global styles after dashboard CSS
    // must not resurrect the old 10px status column around the whole button.
    expect(styles).toMatch(/\.v2-session-row \{ display: block;/);
    expect(styles).not.toContain("grid-template-columns: 10px minmax(0, 1fr) auto");
    expect(dashboardStyles).not.toMatch(/\.v2-session-row \{/);
  });
});
