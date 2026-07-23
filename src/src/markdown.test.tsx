// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkdownView } from "./markdown";

describe("MarkdownView", () => {
  it("renders headings, emphasis, lists and fenced code", () => {
    const { container } = render(
      <MarkdownView
        source={"# 标题\n\n正文 **加粗** 与 `代码`\n\n- 项目一\n- 项目二\n\n```ts\nconst x = 1;\n```"}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("strong")?.textContent).toBe("加粗");
    expect(container.querySelector("p code")?.textContent).toBe("代码");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });

  it("renders pipe tables", () => {
    const { container } = render(
      <MarkdownView source={"| 名称 | 状态 |\n| --- | --- |\n| 构建 | 通过 |"} />,
    );
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.querySelector("td")?.textContent).toBe("构建");
  });

  it("escapes raw HTML instead of injecting it", () => {
    const { container } = render(
      <MarkdownView source={'<script>alert("x")</script>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("x")</script>');
  });

  it("only renders http(s) links and reports clicks", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <MarkdownView
        source={"[文档](https://example.com/a) 与 [本地](file:///etc/passwd) 与 [坏](javascript:alert(1))"}
        onLinkClick={onLinkClick}
      />,
    );
    const anchors = container.querySelectorAll("a.md-link");
    expect(anchors).toHaveLength(1);
    expect(container.textContent).toContain("[本地](file:///etc/passwd)");
    expect(container.textContent).toContain("[坏](javascript:alert(1))");

    fireEvent.click(screen.getByText("文档"));
    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/a");
  });
});
