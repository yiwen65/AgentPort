// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ADDED_AGENT_IDS } from "../agentCapabilities";
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
const styles = readFileSync("src/styles.css", "utf8");
import { AgentIcon, hasAgentIcon } from "./AgentIcons";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("new Agent brand icons", () => {
  it.each(ADDED_AGENT_IDS)("renders %s as an inert, theme-compatible brand mark", (agent) => {
    const { container, rerender } = render(<AgentIcon agent={agent} size={30} />);
    expect(hasAgentIcon(agent)).toBe(true);
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      rerender(<AgentIcon agent={agent} size={30} mono={theme === "light"} />);
      const mark = container.querySelector(".themed-agent-icon");
      expect(mark?.getAttribute("aria-hidden")).toBe("true");
      expect((mark as HTMLElement).style.width).toBe("30px");
      if (agent === "easy_pi") {
        const image = mark?.querySelector("img");
        expect(image?.getAttribute("src")).toContain("easy_pi.png");
        expect(image?.getAttribute("alt")).toBe("");
        expect(image?.getAttribute("draggable")).toBe("false");
        expect(image?.getAttribute("width")).toBe("30");
        expect(mark?.querySelector("svg")).toBeNull();
        continue;
      }
      expect(mark?.querySelectorAll("svg").length).toBe(1);
      if (agent === "omp") {
        expect(mark?.querySelectorAll("linearGradient stop")).toHaveLength(3);
        expect(mark?.querySelector("rect")).toBeNull(); // No opaque background.
      } else {
        expect(mark?.innerHTML).toContain("currentColor");
      }
      expect(mark?.innerHTML).toContain("Copyright (c) 2023 LobeHub");
      expect(mark?.innerHTML).toContain("Permission is hereby granted");
      expect(mark?.querySelector("script, foreignObject, image, use, a")).toBeNull();
      expect(mark?.innerHTML).not.toMatch(/\son\w+=/i);
    }
  });

  it("isolates Omp gradients across repeated and hidden icon instances", () => {
    const { container } = render(<><AgentIcon agent="omp" /><AgentIcon agent="omp" mono /></>);
    const icons = [...container.querySelectorAll("svg")];
    const ids = icons.map((icon) => icon.querySelector("linearGradient")!.id);
    expect(new Set(ids).size).toBe(2);
    icons.forEach((icon, index) => {
      expect(icon.querySelector("path")?.getAttribute("fill")).toBe(`url(#${ids[index]})`);
      expect(icon.innerHTML).not.toContain("__AGENT_ICON_ID__");
    });
  });

  it("connects the new mono marks to distinct application theme foregrounds", () => {
    // jsdom does not evaluate CSS custom properties or paint SVG. This checks
    // the actual theme contract; real App rendering is a separate release gate.
    expect(styles).toMatch(/\.themed-agent-icon\s*\{[^}]*color:\s*var\(--text\)/);
    expect(styles).toMatch(/--text:\s*#f3f5fb/);
    expect(styles).toMatch(/:root\[data-theme="light"\]\s*\{[^}]*--text:\s*#111217/);
  });

  it("keeps original Pi distinct from easy-pi and rejects unknown brand keys", () => {
    const { container, rerender } = render(<AgentIcon agent="pi" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector(".themed-agent-icon")).toBeNull();
    rerender(<AgentIcon agent="easy_pi" />);
    expect(container.querySelector(".themed-agent-icon")).toBeTruthy();
    for (const agent of ["unknown", "toString", "__proto__"]) {
      expect(hasAgentIcon(agent)).toBe(false);
      rerender(<AgentIcon agent={agent} />);
      expect(container.innerHTML).toBe("");
    }
  });
});
