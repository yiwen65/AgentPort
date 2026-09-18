// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, createMock, renameMock, duplicateMock, deleteMock, vscodeMock, revealMock, copyMock } =
  vi.hoisted(() => ({
    listMock: vi.fn(),
    createMock: vi.fn(),
    renameMock: vi.fn(),
    duplicateMock: vi.fn(),
    deleteMock: vi.fn(),
    vscodeMock: vi.fn(),
    revealMock: vi.fn(),
    copyMock: vi.fn(),
  }));

vi.mock("../api", () => ({
  api: {
    listDocumentDirectory: listMock,
    createDocumentEntry: createMock,
    renameDocumentEntry: renameMock,
    duplicateDocumentEntry: duplicateMock,
    deleteDocumentEntry: deleteMock,
    openInVsCode: vscodeMock,
    revealInFileManager: revealMock,
  },
  copyText: copyMock,
  errorText: (error: unknown) => String(error),
}));

import { act } from "@testing-library/react";
import { openDocumentTarget } from "../documents";
import { getActiveDocumentTab, getState, resolveConfirm, setState } from "../store";

/** Active viewer tab as `{path, line}` (mirrors the old `openDocument`). */
function openedDoc() {
  const tab = getActiveDocumentTab(getState());
  return tab ? { path: tab.path, line: tab.pendingLine } : null;
}
import DocumentTree from "./DocumentTree";

const ROOT = "/tmp/demo";

function listing(path: string, entries: Array<[string, boolean]>) {
  return {
    path,
    truncated: false,
    entries: entries.map(([name, isDir]) => ({
      name,
      path: `${path}/${name}`,
      isDir,
    })),
  };
}

describe("DocumentTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockImplementation((path: string) => Promise.resolve({ path }));
    listMock.mockImplementation((path: string) => {
      if (path === ROOT) {
        return Promise.resolve(listing(ROOT, [["src", true], ["docs", true], ["README.md", false]]));
      }
      if (path === `${ROOT}/docs`) {
        return Promise.resolve(listing(`${ROOT}/docs`, [["报告.md", false]]));
      }
      return Promise.resolve(listing(path, []));
    });
    setState({ explorerRoot: ROOT, explorerOpen: true, docGroups: [] });
  });

  afterEach(() => {
    cleanup();
    setState({ explorerRoot: null, explorerOpen: false, docGroups: [], activeDocGroupIndex: 0, contextMenu: null, confirm: null });
  });

  function menuItems() {
    return (getState().contextMenu?.items ?? []).filter((item) => !item.separator);
  }

  it("opens a VSCode-style context menu on right-click", async () => {
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    const labels = menuItems().map((item) => item.label);
    expect(labels).toEqual([
      "新建文件",
      "新建文件夹",
      "在右侧分栏打开",
      "在 VS Code 中打开",
      "复制路径",
      "复制相对路径",
      "在文件管理器中显示",
      "重命名",
      "创建副本",
      "删除",
    ]);
    const items = menuItems();
    expect(items[items.length - 1]?.danger).toBe(true);
  });

  it("copies absolute and root-relative paths", async () => {
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    menuItems().find((item) => item.label === "复制路径")?.action?.();
    expect(copyMock).toHaveBeenCalledWith(`${ROOT}/README.md`);
    menuItems().find((item) => item.label === "复制相对路径")?.action?.();
    expect(copyMock).toHaveBeenCalledWith("README.md");
  });

  it("renames inline via the menu and repoints the open document", async () => {
    renameMock.mockResolvedValue({ path: `${ROOT}/读我.md` });
    openDocumentTarget({ path: `${ROOT}/README.md`, line: null });
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    menuItems().find((item) => item.label === "重命名")?.action?.();
    const input = await screen.findByDisplayValue("README.md");
    fireEvent.change(input, { target: { value: "读我.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(renameMock).toHaveBeenCalledWith(`${ROOT}/README.md`, `${ROOT}/读我.md`),
    );
    await waitFor(() => expect(openedDoc()?.path).toBe(`${ROOT}/读我.md`));
  });

  it("duplicates an entry and reloads the parent directory", async () => {
    duplicateMock.mockResolvedValue({ path: `${ROOT}/README copy.md` });
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    const before = listMock.mock.calls.filter(([path]) => path === ROOT).length;
    menuItems().find((item) => item.label === "创建副本")?.action?.();
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledWith(`${ROOT}/README.md`));
    await waitFor(() =>
      expect(listMock.mock.calls.filter(([path]) => path === ROOT).length).toBeGreaterThan(before),
    );
  });

  it("deletes an entry after danger confirmation and closes the open document", async () => {
    openDocumentTarget({ path: `${ROOT}/README.md`, line: null });
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    menuItems().find((item) => item.label === "删除")?.action?.();
    await waitFor(() => expect(getState().confirm).not.toBeNull());
    expect(getState().confirm?.danger).toBe(true);
    act(() => resolveConfirm(true));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(`${ROOT}/README.md`));
    expect(getState().docGroups).toEqual([]);
  });

  it("loads the root directory and expands directories lazily", async () => {
    render(<DocumentTree />);
    // Dirs first, then files (backend order is preserved).
    await screen.findByText("src");
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(1);

    expect(screen.queryByText("报告.md")).toBeNull();
    fireEvent.click(screen.getByText("docs"));
    await screen.findByText("报告.md");
    expect(listMock).toHaveBeenCalledWith(`${ROOT}/docs`);
  });

  it("opens files into the document viewer", async () => {
    render(<DocumentTree />);
    fireEvent.click(await screen.findByText("README.md"));
    expect(openedDoc()).toEqual({
      path: `${ROOT}/README.md`,
      line: null,
    });
  });

  it("marks the open file as selected", async () => {
    render(<DocumentTree />);
    const row = await screen.findByText("README.md");
    fireEvent.click(row);
    expect(row.closest("button")?.className).toContain("selected");
  });

  it("creates a file under the clicked directory and opens it", async () => {
    render(<DocumentTree />);
    // Choose docs/ as the active directory.
    fireEvent.click(await screen.findByText("docs"));
    await screen.findByText("报告.md");

    fireEvent.click(screen.getByLabelText("新建文件"));
    const input = await screen.findByLabelText("新建文件", { selector: "input" });
    fireEvent.change(input, { target: { value: "notes/周会.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith(`${ROOT}/docs/notes/周会.md`, "file");
    });
    // Parent listing reloads and the new file opens in the editor.
    expect(listMock).toHaveBeenCalledWith(`${ROOT}/docs`);
    expect(openedDoc()).toEqual({
      path: `${ROOT}/docs/notes/周会.md`,
      line: null,
    });
  });

  it("creates a directory without opening the editor", async () => {
    render(<DocumentTree />);
    await screen.findByText("src");

    fireEvent.click(screen.getByLabelText("新建文件夹"));
    const input = await screen.findByLabelText("新建文件夹", { selector: "input" });
    fireEvent.change(input, { target: { value: "backups" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith(`${ROOT}/backups`, "dir");
    });
    expect(getState().docGroups).toEqual([]);
  });

  it("rejects invalid names without calling the backend", async () => {
    render(<DocumentTree />);
    await screen.findByText("src");

    fireEvent.click(screen.getByLabelText("新建文件"));
    const input = await screen.findByLabelText("新建文件", { selector: "input" });
    fireEvent.change(input, { target: { value: "../escape.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText("名称无效：不能包含空片段、. 或 ..");
    expect(createMock).not.toHaveBeenCalled();
  });
});
