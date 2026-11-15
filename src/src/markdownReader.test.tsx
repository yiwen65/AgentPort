// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownView } from "./markdown";
import { normalizeImageDestinations } from "./markdownReader/parse";

describe("MarkdownView advanced syntax", () => {
  it("renders GFM task lists, strikethrough, aligned tables and autolinks", () => {
    const { container } = render(
      <MarkdownView
        source={
          "~~删除~~\n\n- [x] 完成\n- [ ] 未完成\n\n" +
          "| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |\n\n看 www.example.com"
        }
      />,
    );
    expect(container.querySelector("del")?.textContent).toBe("删除");
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[0].defaultChecked).toBe(true);
    expect(boxes[1].defaultChecked).toBe(false);
    const cells = container.querySelectorAll<HTMLElement>("th");
    expect(cells[0].style.textAlign).toBe("left");
    expect(cells[1].style.textAlign).toBe("center");
    expect(cells[2].style.textAlign).toBe("right");
    const autolink = container.querySelector<HTMLAnchorElement>("a.md-link");
    expect(autolink?.getAttribute("href")).toContain("example.com");
  });

  it("renders nested lists", () => {
    const { container } = render(<MarkdownView source={"- 一\n  - 二\n- 三"} />);
    expect(container.querySelectorAll("ul li")).toHaveLength(3);
    expect(container.querySelector("ul ul li")?.textContent).toBe("二");
  });

  it("renders GitHub alerts with the reader chrome", () => {
    const { container } = render(
      <MarkdownView source={"> [!WARNING]\n> 小心操作\n\n> [!TIP]\n> 小技巧"} />,
    );
    const warning = container.querySelector(".md-alert-warning");
    expect(warning).not.toBeNull();
    expect(warning?.querySelector(".md-alert-title")?.textContent).toContain("警告");
    expect(warning?.textContent).toContain("小心操作");
    expect(container.querySelector(".md-alert-tip")?.textContent).toContain("小技巧");
  });

  it("renders footnotes with a localized label", () => {
    const { container } = render(
      <MarkdownView source={"正文[^1]\n\n[^1]: 脚注内容"} />,
    );
    expect(container.querySelector(".md-footnotes")?.textContent).toContain("脚注内容");
    expect(container.querySelector(".md-footnotes")?.textContent).toContain("脚注");
  });

  it("renders inline and block math wrappers with source lines", () => {
    const { container } = render(
      <MarkdownView source={"行内 $a^2$\n\n$$\nx = 1\n$$"} sourceLocations />,
    );
    const inline = container.querySelector(".md-math-inline");
    expect(inline?.textContent).toBe("a^2");
    expect(inline?.getAttribute("data-source-line")).toBe("1");
    const display = container.querySelector(".md-math-display");
    expect(display?.textContent).toContain("x = 1");
  });

  it("collapses YAML front matter into a metadata card", () => {
    const { container } = render(
      <MarkdownView source={"---\ntitle: 测试\ntags: [a, b]\n---\n\n# 标题"} sourceLocations />,
    );
    const details = container.querySelector("details.md-frontmatter");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe("元数据");
    expect(details?.textContent).toContain("title: 测试");
    expect(details?.querySelector("[data-source-line='2']")?.textContent).toContain("title");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("标题");
    expect(heading?.querySelector("[data-source-line='6']")).not.toBeNull();
  });

  it("still escapes raw HTML", () => {
    const { container } = render(
      <MarkdownView source={'<script>alert("x")</script>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("x")</script>');
  });

  it("keeps image destinations with spaces working", () => {
    const { container } = render(<MarkdownView source={"![示意图](some file.png)"} />);
    expect(container.querySelector(".md-image")).not.toBeNull();
    expect(container.textContent).toContain("示意图");
  });
});

describe("normalizeImageDestinations", () => {
  it("wraps space-containing destinations, including titles", () => {
    expect(normalizeImageDestinations("![a](x y.png)")).toBe("![a](<x y.png>)");
    expect(normalizeImageDestinations('![a](x y.png "标题")')).toBe('![a](<x y.png> "标题")');
  });

  it("leaves angle destinations and code alone", () => {
    expect(normalizeImageDestinations("![a](<x y.png>)")).toBe("![a](<x y.png>)");
    expect(normalizeImageDestinations("`![a](x y.png)`")).toBe("`![a](x y.png)`");
    expect(normalizeImageDestinations("```\n![a](x y.png)\n```")).toBe(
      "```\n![a](x y.png)\n```",
    );
  });
});
