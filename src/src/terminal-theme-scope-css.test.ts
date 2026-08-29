// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = styles.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!body) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

describe("terminal theme CSS scope", () => {
  it("keeps Git Center's under-titlebar surface on app-theme tokens", () => {
    const surface = ruleBody(".git-surface");
    expect(surface).toContain("var(--bg-panel)");
    expect(surface).toContain("var(--bg)");
    expect(surface).toContain("background: var(--git-surface)");
    expect(surface).not.toMatch(/--(?:bg-term|workspace-current|term-)/);

    const diff = ruleBody(".git-diff-code");
    expect(diff).toContain("var(--bg-active)");
    expect(diff).not.toContain("var(--bg-term)");
  });

  it("uses terminal tokens for the terminal canvas and document reading surfaces", () => {
    expect(ruleBody(".term-host")).toContain("background: var(--bg-term)");
    expect(ruleBody(".md-preview")).toContain("color: var(--term-text)");
    expect(ruleBody(".md-preview pre")).toContain("background: var(--term-code-bg)");
    expect(ruleBody(".flow-graph")).toContain("background: var(--term-surface-raised)");
  });
});
