// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readMock, writeMock, revealMock, openUrlMock, openDefaultMock, insertMock } =
  vi.hoisted(() => ({
    readMock: vi.fn(),
    writeMock: vi.fn(),
    revealMock: vi.fn(),
    openUrlMock: vi.fn(),
    openDefaultMock: vi.fn(),
    insertMock: vi.fn().mockReturnValue(true),
  }));

vi.mock("../api", () => ({
  api: {
    readSessionDocument: readMock,
    writeSessionDocument: writeMock,
    revealInFileManager: revealMock,
    openExternalUrl: openUrlMock,
    openWithDefaultApp: openDefaultMock,
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
          createdAt: "2026-07-24T00:00:00Z",
        }],
      }],
    });
  });

  afterEach(() => {
    cleanup();
    setState({ openDocument: null, docPanelExpanded: false });
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
      `@${DEMO_DOC.path}#3\n正文\n`,
    );
  });
});
