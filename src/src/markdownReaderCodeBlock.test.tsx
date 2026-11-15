// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "./markdown";
import { setState } from "./store";

describe("MarkdownView code blocks", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setState({ docCodeLineNumbers: false, docCodeWrap: true });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    setState({ docCodeLineNumbers: false, docCodeWrap: true });
  });

  it("renders the code toolbar and toggles global preferences", async () => {
    const { container } = render(<MarkdownView source={"```ts\nconst x = 1;\n```"} />);
    expect(container.querySelector(".md-code-lang")?.textContent).toBe("ts");
    expect(container.querySelectorAll(".md-code-line")).toHaveLength(1);
    const preview = () => container.querySelector(".md-preview");
    expect(preview()?.getAttribute("data-code-line-numbers")).toBe("off");
    expect(preview()?.getAttribute("data-code-wrap")).toBe("on");

    fireEvent.click(screen.getByLabelText("行号"));
    await waitFor(() =>
      expect(preview()?.getAttribute("data-code-line-numbers")).toBe("on"),
    );
    fireEvent.click(screen.getByLabelText("自动换行"));
    await waitFor(() => expect(preview()?.getAttribute("data-code-wrap")).toBe("off"));
  });

  it("copies the raw code through the reader callback", async () => {
    const copy = vi.fn().mockResolvedValue(true);
    render(<MarkdownView source={"```ts\nconst x = 1;\n```"} onCopyText={copy} />);
    fireEvent.click(screen.getByLabelText("复制代码"));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("const x = 1;"));
    expect(await screen.findByLabelText("已复制")).not.toBeNull();
  });
});
