import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AgentIcon, hasAgentIcon } from "./AgentIcons";

const added = ["omp", "opencode", "amp", "gemini", "cline", "kiro_cli", "cursor_agent", "easy_pi", "grok_build"];
afterEach(cleanup);

describe("mobile Agent brand icons", () => {
  it.each(added)("renders the current %s artwork without interactive image behavior", agent => {
    const { container } = render(<AgentIcon agent={agent} size={30} mono className="agent-picker-glyph" />);
    expect(hasAgentIcon(agent)).toBe(true);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.style.width).toBe("30px");
    if (agent === "easy_pi") {
      const image = mark.querySelector("img")!;
      expect(image.getAttribute("src")).toContain("easy_pi.png");
      expect(image.getAttribute("draggable")).toBe("false");
      expect(image.getAttribute("alt")).toBe("");
      expect(image.style.objectFit).toBe("contain");
    } else {
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark.querySelector("script, foreignObject, image, use, a")).toBeNull();
      if (agent === "omp" || agent === "gemini") expect(mark.querySelector("linearGradient")?.children).toHaveLength(3);
      else if (!["amp", "kiro_cli"].includes(agent)) expect(mark.innerHTML).toContain("currentColor");
    }
  });

  it.each([...added.map(agent => `${agent}.${agent === "easy_pi" ? "png" : "svg"}`), "LICENSE.txt"])("keeps %s identical to desktop artwork", file => {
    expect(readFileSync(`src/assets/agent-icons/${file}`)).toEqual(readFileSync(`../src/src/assets/agent-icons/${file}`));
  });

  it("does not tint monochrome brand marks with the application accent", () => {
    const styles = readFileSync("src/features/sessions/dashboard.css", "utf8");
    expect(styles).toMatch(/\.agent-picker-glyph\s*\{[^}]*color:\s*var\(--text\)/);
  });

  it("retains brand accents in the launch picker's mono mode", () => {
    const { container } = render(<><AgentIcon agent="kimi" mono /><AgentIcon agent="amp" mono /><AgentIcon agent="kiro_cli" mono /><AgentIcon agent="gemini" mono /></>);
    for (const color of ["#1783FF", "#F34E3F", "#9046FF"]) expect(container.querySelector(`[fill="${color}"]`)).not.toBeNull();
    expect(container.querySelector('[stop-color="#207CFE"]')).not.toBeNull();
  });

  it("isolates repeated gradient references and retains unknown/Shell fallback", () => {
    const { container } = render(<><AgentIcon agent="omp" /><AgentIcon agent="omp" /></>);
    const ids = [...container.querySelectorAll("linearGradient")].map(node => node.id);
    expect(new Set(ids).size).toBe(2);
    for (const key of ["shell", "unknown", "__proto__", "toString"]) expect(hasAgentIcon(key)).toBe(false);
  });
});
