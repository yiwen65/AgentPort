import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { FileContent } from "./FileContent";

const table = "| Path | Origin | Purpose |\n| :--- | :---: | ---: |\n| `codex/` | openai/codex | Reference: agent implementation |\n| docs/ | Local | Handoff / task documents |";
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);
describe("Markdown safe HTML", () => {
  it("renders allowlisted inline HTML such as sub, kbd and br", () => {
    const { container } = render(<FileContent path="docs/readme.md" content={'<sub>图注 H<sub>2</sub>O</sub>\n\n按 <kbd title="Control">Ctrl</kbd> + C<br>换行'} rendered onOpen={() => {}} />);
    const sub = container.querySelector("sub");
    expect(sub?.textContent).toBe("图注 H2O");
    expect(sub?.querySelector("sub")?.textContent).toBe("2");
    const kbd = container.querySelector("kbd");
    expect(kbd?.textContent).toBe("Ctrl");
    expect(kbd).toHaveAttribute("title", "Control");
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });
  it("renders safe block HTML such as details/summary around Markdown", () => {
    const { container } = render(<FileContent path="docs/readme.md" content={"<details open>\n<summary>开发与源码</summary>\n\n正文 **加粗**\n\n</details>\n\n<div>外框 <b>重点</b></div>"} rendered onOpen={() => {}} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute("open");
    expect(details?.querySelector("summary")?.textContent).toBe("开发与源码");
    expect(details?.querySelector("strong")?.textContent).toBe("加粗");
    expect(container.querySelector("div")?.textContent).toContain("外框 重点");
    expect(container.textContent).not.toContain("<details>");
    expect(container.textContent).not.toContain("</details>");
    expect(container.textContent).not.toContain("<summary>");
  });
  it("keeps unsupported or unclosed HTML as escaped text", () => {
    const { container } = render(<FileContent path="docs/readme.md" content={'<a href="javascript:alert(1)">链接</a> <img src="x">\n\n<div>\n<img src="x" onerror="alert(1)">\n</div>\n\n<sub>未闭合'} rendered onOpen={() => {}} />);
    expect(container.querySelector("a, img")).toBeNull();
    expect(container.textContent).toContain('<a href="javascript:alert(1)">链接</a>');
    expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(container.querySelector("sub")).toBeNull();
    expect(container.textContent).toContain("<sub>未闭合");
    expect(container.querySelector("script")).toBeNull();
  });
});

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
