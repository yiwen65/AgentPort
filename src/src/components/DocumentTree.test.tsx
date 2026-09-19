// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, createMock, renameMock, duplicateMock, deleteMock, vscodeMock, revealMock, copyMock, gitMock } =
  vi.hoisted(() => ({
    listMock: vi.fn(),
    createMock: vi.fn(),
    renameMock: vi.fn(),
    duplicateMock: vi.fn(),
    deleteMock: vi.fn(),
    vscodeMock: vi.fn(),
    revealMock: vi.fn(),
    copyMock: vi.fn(),
    gitMock: vi.fn(),
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
    getGitChanges: gitMock,
  },
  copyText: copyMock,
  errorText: (error: unknown) => String(error),
}));

import { act } from "@testing-library/react";
import { openDocumentTarget } from "../documents";
import { resetTreeGitForTests } from "../docTreeGit";
import { getActiveDocumentTab, getState, resolveConfirm, setState } from "../store";
import type { GitChangeEntry, GitChangeKind } from "../types";

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
    setState({ explorerRoot: null, explorerOpen: false, docGroups: [], activeDocGroupIndex: 0, contextMenu: null, confirm: null, projects: [] });
    resetTreeGitForTests();
  });

  function gitProject() {
    setState({
      projects: [{
        id: "prj_git",
        name: "Demo",
        rootPath: ROOT,
        gitRootPath: null,
        pinned: false,
        worktrees: [],
        sessions: [],
      }],
    });
  }

  function gitEntry(path: string, kind: GitChangeKind): GitChangeEntry {
    return {
      entryToken: `t-${path}`,
      pathToken: `p-${path}`,
      displayPath: path,
      oldPathToken: null,
      displayOldPath: null,
      indexStatus: null,
      worktreeStatus: null,
      conflictCode: null,
      kind,
      submoduleState: null,
      staged: false,
      unstaged: false,
      untracked: kind === "untracked",
      ignored: kind === "ignored",
      conflicted: kind === "conflict",
    };
  }

  function gitSnapshot(entries: GitChangeEntry[]) {
    return {
      context: { checkoutRoot: ROOT },
      statusToken: "tok",
      complete: true,
      partialReason: null,
      counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflict: 0, renamed: 0, submodule: 0 },
      entries,
      observedAt: "2026-09-19T00:00:00Z",
    };
  }

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

  it("renders directories with only the chevron (no folder icon) and no path tooltip", async () => {
    const { container } = render(<DocumentTree />);
    const dirRow = (await screen.findByText("docs")).closest("button");
    // Directories have no kind icon; files keep their type icon.
    expect(dirRow?.querySelector(".doc-tree-kind")).toBeNull();
    const fileRow = (await screen.findByText("README.md")).closest("button");
    expect(fileRow?.querySelector(".doc-tree-kind.file svg")).not.toBeNull();
    // No full-path tooltip on hover anywhere.
    expect(dirRow?.getAttribute("data-tip")).toBeNull();
    expect(fileRow?.getAttribute("data-tip")).toBeNull();
    expect(container.querySelector(".doc-tree-root")?.getAttribute("data-tip")).toBeNull();
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

  it("decorates rows with git colors, badges, directory dots and dimming", async () => {
    listMock.mockImplementation((path: string) => {
      if (path === ROOT) {
        return Promise.resolve(listing(ROOT, [["src", true], ["node_modules", true], ["README.md", false]]));
      }
      if (path === `${ROOT}/src`) {
        return Promise.resolve(listing(`${ROOT}/src`, [["app.ts", false]]));
      }
      return Promise.resolve(listing(path, []));
    });
    gitMock.mockResolvedValue(gitSnapshot([
      gitEntry("README.md", "modified"),
      gitEntry("src/app.ts", "untracked"),
      gitEntry("node_modules/", "ignored"),
    ]));
    gitProject();
    const { container } = render(<DocumentTree />);

    await waitFor(() => expect(gitMock).toHaveBeenCalled());
    // Modified file: gold name class + M badge.
    const readmeRow = (await screen.findByText("README.md")).closest("button");
    expect(readmeRow?.className).toContain("git-modified");
    const badge = container.querySelector(".doc-tree-git-badge");
    expect(badge?.textContent).toBe("M");
    expect(badge?.className).toContain("git-modified");

    // Directory containing an untracked file: dot with the untracked hue.
    const srcRow = (await screen.findByText("src")).closest("button");
    const dot = srcRow?.querySelector(".doc-tree-git-dot");
    expect(dot?.className).toContain("git-untracked");

    // Ignored directory is dimmed.
    const nmRow = (await screen.findByText("node_modules")).closest("button");
    expect(nmRow?.className).toContain("git-dimmed");

    // Expanding src shows the untracked file itself.
    fireEvent.click(screen.getByText("src"));
    const appRow = (await screen.findByText("app.ts")).closest("button");
    expect(appRow?.className).toContain("git-untracked");
    expect(appRow?.querySelector(".doc-tree-git-badge")?.textContent).toBe("U");
  });

  it("stays silent when the tree root is not a git repository", async () => {
    gitMock.mockRejectedValue(new Error("not a git repository"));
    gitProject();
    const { container } = render(<DocumentTree />);
    await waitFor(() => expect(gitMock).toHaveBeenCalled());
    await screen.findByText("README.md");
    expect(container.querySelector(".doc-tree-git-badge")).toBeNull();
    expect(container.querySelector(".doc-tree-git-dot")).toBeNull();
    expect(container.querySelector(".doc-tree-row.git-modified")).toBeNull();
  });

  it("keeps expanded directories open across a manual refresh", async () => {
    render(<DocumentTree />);
    fireEvent.click(await screen.findByText("docs"));
    await screen.findByText("报告.md");

    // The next read sees a new file in docs/.
    listMock.mockImplementation((path: string) => {
      if (path === ROOT) {
        return Promise.resolve(listing(ROOT, [["src", true], ["docs", true], ["README.md", false]]));
      }
      if (path === `${ROOT}/docs`) {
        return Promise.resolve(listing(`${ROOT}/docs`, [["报告.md", false], ["新增.md", false]]));
      }
      return Promise.resolve(listing(path, []));
    });
    const docsReadsBefore = listMock.mock.calls.filter(([p]) => p === `${ROOT}/docs`).length;

    fireEvent.click(screen.getByLabelText("刷新目录树"));

    // Expanded state survives: docs/ children stay visible, and the reload
    // actually re-read the directory (the new file appears).
    await screen.findByText("新增.md");
    expect(screen.getByText("报告.md")).toBeTruthy();
    expect(
      listMock.mock.calls.filter(([p]) => p === `${ROOT}/docs`).length,
    ).toBeGreaterThan(docsReadsBefore);
  });

  it("collapses all expanded directories while keeping the root open", async () => {
    render(<DocumentTree />);
    fireEvent.click(await screen.findByText("docs"));
    await screen.findByText("报告.md");

    fireEvent.click(screen.getByLabelText("折叠全部"));
    expect(screen.queryByText("报告.md")).toBeNull();
    // Root entries remain visible.
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
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
