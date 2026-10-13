import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileTreeIcon } from "./FileTreeIcon";

describe("FileTreeIcon", () => {
  it.each([ ["main.TS", "TS"], ["script.js", "JS"], ["config.json", "{}"], ["AGENTS.md", "↓"], ["README.md", "i"], ["package.json", "npm"], ["lib.rs", "R"] ])("uses a type glyph for %s", (name, glyph) => {
    const { container } = render(<FileTreeIcon name={name} directory={false} />);
    expect(container.querySelector("text")).toHaveTextContent(glyph);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
  it.each([ ["photo.png", "image"], ["backup.zip", "archive"], ["unknown.xyz", "file"], ["constructor", "file"], ["__proto__", "file"], ["file.constructor", "file"] ])("provides a safe fallback for %s", (name, kind) => {
    const { container } = render(<FileTreeIcon name={name} directory={false} />);
    expect(container.querySelector("svg")).toHaveAttribute("data-file-icon", kind);
    expect(container.querySelector("path, rect")).not.toBeNull();
  });
  it("changes the directory chevron on expansion", () => {
    const { container, rerender } = render(<FileTreeIcon name="src" directory />);
    const collapsed = container.querySelector("path")?.getAttribute("d");
    rerender(<FileTreeIcon name="src" directory expanded />);
    expect(container.querySelector("path")?.getAttribute("d")).not.toBe(collapsed);
    expect(container.querySelector("svg")).toHaveAttribute("data-file-icon", "directory");
  });
});
