import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { FileContent } from "./FileContent";

const table = "| Path | Origin | Purpose |\n| :--- | :---: | ---: |\n| `codex/` | openai/codex | Reference: agent implementation |\n| docs/ | Local | Handoff / task documents |";
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);
describe("Markdown tables", () => {
  it("parses pipe tables into semantic rows and cells with alignment", () => {
    render(<FileContent path="AGENTS.md" content={table} rendered onOpen={() => {}} />);
    const rendered = screen.getByRole("table");
    expect(screen.getAllByRole("columnheader").map(el => el.textContent)).toEqual(["Path", "Origin", "Purpose"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("cell")).toHaveLength(6);
    expect(rendered.querySelector("code")).toHaveTextContent("codex/");
    expect(screen.getByRole("columnheader", { name: "Origin" })).toHaveStyle({ textAlign: "center" });
    expect(screen.getByRole("columnheader", { name: "Purpose" })).toHaveStyle({ textAlign: "right" });
    expect(rendered.parentElement).toHaveAttribute("data-horizontal-scroll", "true");
    expect(rendered.parentElement).toHaveAttribute("tabindex", "0");
  });
  it("keeps table source literal in source mode and fenced code", () => {
    const { rerender } = render(<FileContent path="AGENTS.md" content={table} rendered={false} onOpen={() => {}} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe(table);
    rerender(<FileContent path="AGENTS.md" content={"```md\n" + table + "\n```"} rendered onOpen={() => {}} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain(table);
  });
  it("preserves safe links, escaped pipes and disabled remote resources inside tables", () => {
    const { container } = render(<FileContent path="docs/readme.md" content={'| File | Value |\n| --- | --- |\n| [source](../src/main.ts) | a\\|b |\n| [external](https://example.com) | ![remote](https://example.com/image.png) |\n| https://example.com | Autolink stays blocked |\n| <script>alert(1)</script> | <img src="https://example.com/image.png" /> |'} rendered onOpen={() => {}} />);
    expect(screen.getByRole("table")).toHaveTextContent("a|b");
    expect(screen.getByRole("link", { name: "source" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "external" })).toBeNull();
    expect(container.querySelector("script, img, iframe, a[href]")).toBeNull();
  });
});
