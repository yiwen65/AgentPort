// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readMock, writeMock, revealMock, openUrlMock, openDefaultMock, insertMock, listMock, createMock } =
  vi.hoisted(() => ({
    readMock: vi.fn(),
    writeMock: vi.fn(),
    revealMock: vi.fn(),
    openUrlMock: vi.fn(),
    openDefaultMock: vi.fn(),
    insertMock: vi.fn().mockReturnValue(true),
    listMock: vi.fn(),
    createMock: vi.fn(),
  }));

vi.mock("../api", () => ({
  api: {
    readSessionDocument: readMock,
    writeSessionDocument: writeMock,
    revealInFileManager: revealMock,
    openExternalUrl: openUrlMock,
    openWithDefaultApp: openDefaultMock,
    listDocumentDirectory: listMock,
    createDocumentEntry: createMock,
  },
  errorText: (error: unknown) =>
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error),
}));

vi.mock("../terminals", () => ({
  insertTextIntoTerminal: insertMock,
}));

import { getState, setState } from "../store";
import DocumentPanel from "./DocumentPanel";

const DEMO_DOC = {
  path: "/tmp/demo/报告.md",
  content: "# 标题\n\n正文\n",
  truncated: false,
  sizeBytes: 12,
};

describe("DocumentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMock.mockResolvedValue({ ...DEMO_DOC });
    writeMock.mockResolvedValue({ path: DEMO_DOC.path, sizeBytes: 20 });
    setState({
      openDocument: { path: DEMO_DOC.path, line: null },
      docPanelExpanded: false,
      activeSessionId: "ses_quote",
      projects: [{
        id: "prj_quote",
        name: "Quote",
        rootPath: "/tmp/demo",
        gitRootPath: null,
        pinned: false,
        worktrees: [],
        sessions: [{
          id: "ses_quote",
          projectId: "prj_quote",
          worktreeId: null,
          title: "Quote",
          adapter: "codex",
          cwd: "/tmp/demo",
          lifecycle: "running",
          agentSessionId: null,
          resumePrecision: "unavailable",
          permissionMode: "native",
          transport: "pty",
          logPath: "/tmp/demo.log",
          unread: false,
          status: null,
          pinnedAt: null,
          createdAt: "2026-07-24T00:00:00Z",
        }],
      }],
    });
  });

  afterEach(() => {
    cleanup();
    setState({ openDocument: null, docPanelExpanded: false, explorerOpen: false, docTreeWidth: 184 });
  });

  async function findRawEditor() {
    // Markdown documents open in preview mode; switch to the raw editor.
    fireEvent.click(await screen.findByText("原始文本"));
    return screen.findByLabelText("文档内容编辑");
  }

  it("edits in raw mode and saves with ⌘S", async () => {
    render(<DocumentPanel />);
    const editor = await findRawEditor();
    expect((editor as HTMLTextAreaElement).value).toBe("# 标题\n\n正文\n");

    fireEvent.change(editor, { target: { value: "# 标题\n\n正文\n新增一行\n" } });
    // Dirty marker and save button appear once the draft diverges.
    const saveButton = await screen.findByText("保存");

    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith(DEMO_DOC.path, "# 标题\n\n正文\n新增一行\n");
    });
    // Saved: the save button disappears and the toast confirms.
    await waitFor(() => {
      expect(screen.queryByText("保存")).toBeNull();
      expect(getState().toasts.some((item) => item.text === "文档已保存")).toBe(true);
    });
    void saveButton;
  });

  it("shows only the tree when the explorer opens without a file", async () => {
    listMock.mockResolvedValue({ path: "/tmp/demo", truncated: false, entries: [] });
    setState({ openDocument: null, explorerOpen: true, explorerRoot: "/tmp/demo" });
    const { container } = render(<DocumentPanel />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // Tree-only: no editor column, sash visible for tree-width dragging,
    // panel hugs the default 184px tree + 1px separator.
    expect(container.querySelector(".doc-tree")).not.toBeNull();
    expect(container.querySelector(".doc-editor-column")).toBeNull();
    expect(container.querySelector(".doc-panel-resize")).not.toBeNull();
    expect(container.querySelector(".doc-panel")?.className).toContain("tree-only");
    const panelStyle = container.querySelector(".doc-panel")?.getAttribute("style") ?? "";
    expect(panelStyle).toContain("width: 185px");
    expect(panelStyle).toContain("--doc-tree-width: 184px");

    // Picking a file brings the editor area back alongside the tree.
    act(() => setState({ openDocument: { path: DEMO_DOC.path, line: null } }));
    await waitFor(() => {
      expect(container.querySelector(".doc-editor-column")).not.toBeNull();
    });
    expect(container.querySelector(".doc-tree")).not.toBeNull();
    expect(container.querySelector(".doc-panel")?.className).not.toContain("tree-only");
  });

  it("drags the sash to resize the tree in tree-only mode", async () => {
    listMock.mockResolvedValue({ path: "/tmp/demo", truncated: false, entries: [] });
    setState({ openDocument: null, explorerOpen: true, explorerRoot: "/tmp/demo", docTreeWidth: 184 });
    const { container } = render(<DocumentPanel />);
    const sash = container.querySelector(".doc-panel-resize");
    expect(sash).not.toBeNull();
    // jsdom lacks PointerEvent; a MouseEvent with a pointer* type drives the
    // same handlers (window-level move listener + React onPointerDown).
    act(() => {
      (sash as Element).dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 500 }),
      );
    });
    // Dragging the left-edge sash leftward widens the tree, clamped at 420.
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 440 }));
    });
    expect(getState().docTreeWidth).toBe(244);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0 }));
    });
    expect(getState().docTreeWidth).toBe(420);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900 }));
    });
    expect(getState().docTreeWidth).toBe(160);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
  });

  it("keeps an accessible name and tooltip on the icon-only preview tab", async () => {
    render(<DocumentPanel />);
    await screen.findByText("原始文本");
    const tab = screen.getByRole("tab", { name: "预览" });
    expect(tab.getAttribute("data-tip")).toBe("预览");
    expect(tab.querySelector("svg")).not.toBeNull();
  });

  it("does not jump back to a path:line target after saving", async () => {
    setState({
      openDocument: { path: DEMO_DOC.path, line: 1 },
    });
    render(<DocumentPanel />);
    const editor = (await findRawEditor()) as HTMLTextAreaElement;
    editor.scrollTop = 140;
    fireEvent.scroll(editor);
    fireEvent.change(editor, {
      target: { value: "# 标题\n\n正文\n新增一行\n" },
    });

    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalled();
      expect(screen.queryByText("保存")).toBeNull();
    });
    await act(async () => undefined);

    expect(editor.scrollTop).toBe(140);
  });

  it("reveals the same path:line again for a new open request", async () => {
    setState({
      openDocument: { path: DEMO_DOC.path, line: 3 },
    });
    render(<DocumentPanel />);
    const editor = (await findRawEditor()) as HTMLTextAreaElement;
    editor.scrollTop = 140;

    act(() => {
      setState({
        openDocument: { path: DEMO_DOC.path, line: 3 },
      });
    });

    await waitFor(() => expect(editor.scrollTop).not.toBe(140));
    expect(editor.selectionStart).toBe(DEMO_DOC.content.indexOf("正文"));
  });

  it("preserves CRLF line endings when saving", async () => {
    readMock.mockResolvedValue({
      ...DEMO_DOC,
      content: "one\r\ntwo\r\n",
    });
    render(<DocumentPanel />);
    const editor = await findRawEditor();
    fireEvent.change(editor, { target: { value: "one\ntwo\nthree\n" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith(DEMO_DOC.path, "one\r\ntwo\r\nthree\r\n");
    });
  });

  it("falls back to a punctuation-trimmed path when the link target is missing", async () => {
    setState({
      openDocument: { path: "/tmp/demo/报告.md，包含说明", line: null },
    });
    readMock.mockImplementation((path: string) => {
      if (path.includes("包含")) {
        return Promise.reject({
          code: "document_not_found",
          params: { path },
          technicalDetail: "missing",
          message: "missing",
        });
      }
      return Promise.resolve({ ...DEMO_DOC });
    });

    render(<DocumentPanel />);
    await findRawEditor();
    expect(readMock).toHaveBeenCalledWith("/tmp/demo/报告.md，包含说明");
    expect(readMock).toHaveBeenCalledWith("/tmp/demo/报告.md");
  });

  it("keeps truncated files read-only", async () => {
    readMock.mockResolvedValue({ ...DEMO_DOC, truncated: true });
    render(<DocumentPanel />);
    const editor = await findRawEditor();
    expect((editor as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByText("文件过大，仅显示开头部分内容")).toBeTruthy();
  });

  it("shows a friendly notice with actions for binary files", async () => {
    openDefaultMock.mockResolvedValue(undefined);
    readMock.mockRejectedValue({
      code: "document_binary",
      params: { path: "/tmp/demo/AI工具安装.pdf" },
      technicalDetail: "二进制文件不支持在文档查看器中预览",
      message: "二进制文件不支持在文档查看器中预览",
    });
    setState({
      openDocument: { path: "/tmp/demo/AI工具安装.pdf", line: null },
    });

    render(<DocumentPanel />);
    await screen.findByText("这是二进制文件，无法在这里预览");
    expect(screen.getByText(/PDF、图片、压缩包等二进制格式/)).toBeTruthy();
    expect(screen.getByText("/tmp/demo/AI工具安装.pdf")).toBeTruthy();

    fireEvent.click(screen.getByText("用默认应用打开"));
    await waitFor(() => {
      expect(openDefaultMock).toHaveBeenCalledWith("/tmp/demo/AI工具安装.pdf");
    });
  });

  it("shows a friendly notice for missing files without actions", async () => {
    readMock.mockRejectedValue({
      code: "document_not_found",
      params: { path: "/tmp/demo/gone.md" },
      technicalDetail: "missing",
      message: "missing",
    });
    setState({
      openDocument: { path: "/tmp/demo/gone.md", line: null },
    });

    render(<DocumentPanel />);
    await screen.findByText("找不到这个文件");
    expect(screen.queryByText("用默认应用打开")).toBeNull();
  });

  it("quotes an editor selection into the active terminal with line info", async () => {
    render(<DocumentPanel />);
    const editor = (await findRawEditor()) as HTMLTextAreaElement;

    // Select "正文" (line 3) in "# 标题\n\n正文\n".
    const start = DEMO_DOC.content.indexOf("正文");
    editor.setSelectionRange(start, start + 2);
    fireEvent.select(editor);

    const button = await screen.findByText(/引用所选/);
    fireEvent.click(button);

    expect(insertMock).toHaveBeenCalledWith(
      "ses_quote",
      `@${DEMO_DOC.path}:3 `,
    );
  });

  function mockEditorRect(editor: HTMLTextAreaElement) {
    // jsdom has no layout: give the editor a 400×200 box at the origin.
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("auto-scrolls while drag-selecting past the edge and stops on release", async () => {
    render(<DocumentPanel />);
    const editor = (await findRawEditor()) as HTMLTextAreaElement;
    mockEditorRect(editor);

    vi.useFakeTimers();
    try {
      fireEvent.mouseDown(editor, { button: 0 });
      // Pointer pushed 20px past the right edge with the button held.
      fireEvent.mouseMove(window, { clientX: 420, clientY: 100, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(editor.scrollLeft).toBeGreaterThan(0);

      // Back inside the editor: scrolling halts, tracking continues.
      const stoppedAt = editor.scrollLeft;
      fireEvent.mouseMove(window, { clientX: 200, clientY: 100, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(editor.scrollLeft).toBe(stoppedAt);

      // After mouseup the listeners are gone for good.
      fireEvent.mouseUp(window);
      fireEvent.mouseMove(window, { clientX: 420, clientY: 100, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(editor.scrollLeft).toBe(stoppedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores pointer drags that did not start in the editor", async () => {
    render(<DocumentPanel />);
    const editor = (await findRawEditor()) as HTMLTextAreaElement;
    mockEditorRect(editor);

    vi.useFakeTimers();
    try {
      // No mousedown on the textarea (e.g. the panel sash is being dragged):
      // a held-button move past the edge must not scroll the document.
      fireEvent.mouseMove(window, { clientX: 420, clientY: 100, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(editor.scrollLeft).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
