// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, searchMock, createMock, renameMock, duplicateMock, deleteMock, vscodeMock, revealMock, copyMock, gitMock, ignoreMock } =
  vi.hoisted(() => ({
    listMock: vi.fn(),
    searchMock: vi.fn(),
    createMock: vi.fn(),
    renameMock: vi.fn(),
    duplicateMock: vi.fn(),
    deleteMock: vi.fn(),
    vscodeMock: vi.fn(),
    revealMock: vi.fn(),
    copyMock: vi.fn(),
    gitMock: vi.fn(),
    ignoreMock: vi.fn(),
  }));

vi.mock("../api", () => ({
  api: {
    listDocumentDirectory: listMock,
    searchDocumentFiles: searchMock,
    createDocumentEntry: createMock,
    renameDocumentEntry: renameMock,
    duplicateDocumentEntry: duplicateMock,
    deleteDocumentEntry: deleteMock,
    addDocumentEntryToGitignore: ignoreMock,
    openInVsCode: vscodeMock,
    revealInFileManager: revealMock,
    getGitChanges: gitMock,
  },
  listDocumentDirectoryForDevice: (path: string) => listMock(path),
  searchDocumentFilesForDevice: (path: string, query: string) =>
    searchMock(path, query),
  createDocumentEntryForDevice: (path: string, kind: "file" | "dir") =>
    createMock(path, kind),
  renameDocumentEntryForDevice: (oldPath: string, newPath: string) =>
    renameMock(oldPath, newPath),
  duplicateDocumentEntryForDevice: (path: string) => duplicateMock(path),
  deleteDocumentEntryForDevice: (path: string) => deleteMock(path),
  copyText: copyMock,
  errorText: (error: unknown) => String(error),
}));

vi.mock("../terminals", () => ({ insertTextIntoTerminal: vi.fn() }));

import { act } from "@testing-library/react";
import { openDocumentTarget, openDocumentTreeSearch, resetDocumentTreeSearchRequests } from "../documents";
import { resetTreeGitForTests } from "../docTreeGit";
import { getActiveDocumentTab, getState, resolveConfirm, setActiveDevice, setState } from "../store";
import { RemoteUnavailableError, RemoteRequestError } from "../remote/errors";
import type { GitChangeEntry, GitChangeKind } from "../types";

/** Active viewer tab as `{path, line}` (mirrors the old `openDocument`). */
function openedDoc() {
  const tab = getActiveDocumentTab(getState());
  return tab ? { path: tab.path, line: tab.pendingLine } : null;
}
import DocumentTree from "./DocumentTree";
import { forwardNativeDrag } from "../nativeDrag";
import { readDragPayload } from "../terminalDrop";

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
    searchMock.mockReset();
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
    resetDocumentTreeSearchRequests();
    setActiveDevice({ kind: "local" });
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

  it.each([
    ["README.md", false],
    ["docs", true],
  ] as const)("preserves tree entry %s when native drag events contain no file paths", async (name, isDir) => {
    class Transfer {
      values = new Map<string, string>();
      setData(key: string, value: string) { this.values.set(key, value); }
      getData(key: string) { return this.values.get(key) ?? ""; }
      get types() { return [...this.values.keys()]; }
    }
    class Drag extends MouseEvent {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: DragEventInit) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    vi.stubGlobal("DataTransfer", Transfer);
    vi.stubGlobal("DragEvent", Drag);
    vi.stubGlobal("devicePixelRatio", 2);
    const target = document.createElement("div");
    document.body.append(target);
    const hit = vi.fn(() => target);
    const hitDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
    const dropped = vi.fn((event: Event) => readDragPayload((event as DragEvent).dataTransfer!));
    target.addEventListener("drop", dropped);
    try {
      render(<DocumentTree />);
      fireEvent.dragStart(await screen.findByText(name), { dataTransfer: new DataTransfer() });
      expect(forwardNativeDrag({ type: "enter", position: { x: 640, y: 240 } })).toBe(true);
      // The browser can send dragend before native drop IPC arrives.
      window.dispatchEvent(new Event("dragend"));
      expect(forwardNativeDrag({ type: "drop", position: { x: 640, y: 240 } })).toBe(true);
      expect(hit).toHaveBeenCalledWith(640, 240);
      expect(dropped).toHaveBeenCalledOnce();
      expect(dropped.mock.results[0]?.value).toEqual({ path: `${ROOT}/${name}`, isDir });
      // A later Finder drop is not mistaken for this internal tree drag.
      expect(forwardNativeDrag({ type: "drop", position: { x: 640, y: 240 } })).toBe(false);
    } finally {
      forwardNativeDrag({ type: "leave" });
      window.dispatchEvent(new Event("dragend"));
      if (hitDescriptor) Object.defineProperty(document, "elementFromPoint", hitDescriptor);
      else Reflect.deleteProperty(document, "elementFromPoint");
      target.remove();
      vi.unstubAllGlobals();
    }
  });

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
    // Directories: chevron in the leading slot, no kind icon.
    expect(dirRow?.querySelector(".doc-tree-kind")).toBeNull();
    expect(dirRow?.querySelector(".doc-tree-icon svg")).not.toBeNull();
    // Files: type icon in the same leading slot, no empty chevron slot —
    // sibling names start at an identical x.
    const fileRow = (await screen.findByText("README.md")).closest("button");
    expect(fileRow?.querySelector(".doc-tree-kind.file svg")).not.toBeNull();
    expect(fileRow?.querySelector(".doc-tree-icon")).toBeNull();
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

  it("reloads and rebinds the tree when the active device changes, even at the same root path", async () => {
    render(<DocumentTree />);
    await screen.findByText("README.md");
    const rootReads = () =>
      listMock.mock.calls.filter(([path]) => path === ROOT).length;
    const before = rootReads();

    act(() =>
      setActiveDevice({
        kind: "remote",
        deviceId: "dev_1",
        deviceName: "Linux box",
        capabilities: [],
      }),
    );
    await waitFor(() => expect(rootReads()).toBeGreaterThan(before));

    fireEvent.click(await screen.findByText("README.md"));
    const tab = getActiveDocumentTab(getState())!;
    expect(tab.imageContext?.device).toEqual({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux box",
      capabilities: [],
    });
    expect(tab.id).toBe(`remote:dev_1:${ROOT}/README.md`);
  });

  it("ignores a directory listing that resolves after a device switch", async () => {
    let resolveLocal!: (value: unknown) => void;
    listMock.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => { resolveLocal = resolve; }),
    );
    render(<DocumentTree />);
    expect(listMock).toHaveBeenCalledWith(ROOT);

    act(() =>
      setActiveDevice({
        kind: "remote",
        deviceId: "dev_1",
        deviceName: "Linux box",
        capabilities: [],
      }),
    );
    // The new device's listing paints the tree.
    await screen.findByText("README.md");

    // The old device's response carries a path that exists only there and
    // must not leak into the new device's tree.
    await act(async () => {
      resolveLocal(listing(ROOT, [["local-only.md", false]]));
    });
    expect(screen.queryByText("local-only.md")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("opens files into the document viewer", async () => {
    render(<DocumentTree />);
    fireEvent.click(await screen.findByText("README.md"));
    expect(openedDoc()).toEqual({
      path: `${ROOT}/README.md`,
      line: null,
    });
  });

  it("opens consecutive clicks as separate tabs instead of replacing", async () => {
    render(<DocumentTree />);
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(screen.getByText("docs"));
    fireEvent.click(await screen.findByText("报告.md"));

    const tabs = getState().docGroups[0]?.tabs ?? [];
    expect(tabs.map((tab) => tab.path)).toEqual([
      `${ROOT}/README.md`,
      `${ROOT}/docs/报告.md`,
    ]);
    // Tree opens are pinned, so no preview slot can evict an open file.
    expect(tabs.every((tab) => tab.pinned)).toBe(true);
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
    expect(readmeRow?.classList.contains("git-modified")).toBe(true);
    const badge = container.querySelector(".doc-tree-git-badge");
    expect(badge?.textContent).toBe("M");
    expect(badge?.className).toContain("git-modified");

    // Directory containing an untracked file: dot with the untracked hue.
    const srcRow = (await screen.findByText("src")).closest("button");
    const dot = srcRow?.querySelector(".doc-tree-git-dot");
    expect(dot?.className).toContain("git-untracked");

    // Ignored directory is dimmed.
    const nmRow = (await screen.findByText("node_modules")).closest("button");
    expect(nmRow?.classList.contains("git-dimmed")).toBe(true);

    // Expanding src shows the untracked file itself.
    fireEvent.click(screen.getByText("src"));
    const appRow = (await screen.findByText("app.ts")).closest("button");
    expect(appRow?.classList.contains("git-untracked")).toBe(true);
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

  it("adds an entry to .gitignore from the context menu and refreshes decorations", async () => {
    gitMock.mockResolvedValue(gitSnapshot([gitEntry("README.md", "untracked")]));
    gitProject();
    ignoreMock.mockResolvedValue(undefined);
    render(<DocumentTree />);
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByText("README.md"));
      expect(menuItems().map((item) => item.label)).toContain("加入 .gitignore");
    });
    const readsBefore = gitMock.mock.calls.length;

    await act(async () => {
      menuItems().find((item) => item.label === "加入 .gitignore")?.action?.();
    });

    expect(ignoreMock).toHaveBeenCalledWith(ROOT, `${ROOT}/README.md`);
    await waitFor(() => expect(gitMock.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it("disables Add to .gitignore on a remote device", async () => {
    setActiveDevice({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux box",
      capabilities: [],
    });
    gitMock.mockResolvedValue(gitSnapshot([]));
    gitProject();
    render(<DocumentTree />);
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByText("README.md"));
      expect(
        menuItems().find((item) => item.label === "加入 .gitignore")?.disabled,
      ).toBe(true);
    });
    expect(
      menuItems().find((item) => item.label === "加入 .gitignore")?.tip,
    ).toBe("远程设备上暂不支持该文档操作");
    expect(ignoreMock).not.toHaveBeenCalled();
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

  it("disables OS-integration and mutating entry items while a remote device is active", async () => {
    setActiveDevice({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux box",
      capabilities: [],
    });
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    const items = menuItems();
    const osTip = "仅本机可用（当前指向远程设备）";
    const mutationTip = "远程设备上暂不支持该文档操作";
    for (const label of ["在 VS Code 中打开", "在文件管理器中显示"]) {
      const item = items.find((entry) => entry.label === label);
      expect(item?.disabled).toBe(true);
      expect(item?.tip).toBe(osTip);
    }
    for (const label of ["重命名", "创建副本", "删除"]) {
      const item = items.find((entry) => entry.label === label);
      expect(item?.disabled).toBe(true);
      expect(item?.tip).toBe(mutationTip);
    }
    // Read-only actions stay available remotely.
    for (const label of ["新建文件", "新建文件夹", "复制路径", "复制相对路径"]) {
      expect(items.find((entry) => entry.label === label)?.disabled).toBeFalsy();
    }
  });

  it("turns a RemoteUnavailableError into an info notice instead of an error toast", async () => {
    setActiveDevice({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux box",
      capabilities: [],
    });
    vscodeMock.mockRejectedValue(new RemoteUnavailableError("os.openInVsCode"));
    render(<DocumentTree />);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    // Invoke the action directly (race: menu built before the device switched).
    menuItems().find((entry) => entry.label === "在 VS Code 中打开")?.action?.();
    await waitFor(() => {
      const toasts = getState().toasts;
      expect(toasts.some((entry) => entry.kind === "info" && entry.text === "该操作在远程设备上不可用")).toBe(true);
    });
    expect(getState().toasts.some((entry) => entry.kind === "error")).toBe(false);
  });

  it("searches the whole project recursively from the tree header", async () => {
    searchMock.mockResolvedValue({
      path: "/private/tmp/demo",
      truncated: false,
      entries: [
        { name: "报告.md", path: "/private/tmp/demo/docs/报告.md", isDir: false },
        { name: "README.md", path: "/private/tmp/demo/README.md", isDir: false },
      ],
    });
    render(<DocumentTree />);
    await screen.findByText("src");
    fireEvent.click(screen.getByLabelText("搜索文件"));

    const input = screen.getByPlaceholderText("搜索文件名或路径");
    fireEvent.change(input, { target: { value: "报告" } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith(ROOT, "报告"));

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    // Display paths are relative to the canonical root returned by the
    // backend, not to the store's (possibly non-canonical) explorer root.
    expect(options[0]?.getAttribute("aria-label")).toBe("docs/报告.md");
    expect(options[1]?.getAttribute("aria-label")).toBe("README.md");
    // The basename leads the row; the muted directory follows it so narrow
    // tree columns never truncate the file name away first.
    expect(options[0]?.textContent?.indexOf("报告.md")).toBe(0);
    // The flat result list replaces the lazy tree while searching.
    expect(screen.queryByText("src")).toBeNull();

    fireEvent.click(options[0]!);
    expect(openedDoc()).toEqual({
      path: "/private/tmp/demo/docs/报告.md",
      line: null,
    });
    expect(getState().docGroups[0]?.tabs[0]?.pinned).toBe(true);
  });

  it("navigates search results with arrow keys and closes with Escape", async () => {
    searchMock.mockResolvedValue({
      path: ROOT,
      truncated: false,
      entries: [
        { name: "a.md", path: `${ROOT}/a.md`, isDir: false },
        { name: "b.md", path: `${ROOT}/docs/b.md`, isDir: false },
      ],
    });
    render(<DocumentTree />);
    fireEvent.click(await screen.findByLabelText("搜索文件"));
    const input = screen.getByPlaceholderText("搜索文件名或路径");
    fireEvent.change(input, { target: { value: "md" } });
    await screen.findAllByRole("option");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openedDoc()).toEqual({ path: `${ROOT}/docs/b.md`, line: null });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("搜索文件名或路径")).toBeNull();
    // Clearing the search restores the lazily loaded tree untouched.
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("shows no-result and truncation notes", async () => {
    searchMock.mockResolvedValueOnce({ path: ROOT, truncated: false, entries: [] });
    const first = render(<DocumentTree />);
    fireEvent.click(await screen.findByLabelText("搜索文件"));
    fireEvent.change(screen.getByPlaceholderText("搜索文件名或路径"), {
      target: { value: "zzz" },
    });
    await screen.findByText("没有匹配的文件");
    first.unmount();

    searchMock.mockResolvedValueOnce({
      path: ROOT,
      truncated: true,
      entries: [{ name: "a.md", path: `${ROOT}/a.md`, isDir: false }],
    });
    render(<DocumentTree />);
    fireEvent.click(await screen.findByLabelText("搜索文件"));
    fireEvent.change(screen.getByPlaceholderText("搜索文件名或路径"), {
      target: { value: "a" },
    });
    await screen.findByText("结果可能不完整：搜索范围过大或匹配过多");
  });

  it("ignores a stale search response after the query changed", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    searchMock
      .mockImplementationOnce(
        () => new Promise<unknown>((resolve) => { resolveOld = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<unknown>((resolve) => { resolveNew = resolve; }),
      );

    render(<DocumentTree />);
    fireEvent.click(await screen.findByLabelText("搜索文件"));
    const input = screen.getByPlaceholderText("搜索文件名或路径");
    fireEvent.change(input, { target: { value: "old" } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "new" } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNew({
        path: ROOT,
        truncated: false,
        entries: [{ name: "new.md", path: `${ROOT}/new.md`, isDir: false }],
      });
    });
    await screen.findByLabelText("new.md");
    await act(async () => {
      resolveOld({
        path: ROOT,
        truncated: false,
        entries: [{ name: "old.md", path: `${ROOT}/old.md`, isDir: false }],
      });
    });
    expect(screen.queryByLabelText("old.md")).toBeNull();
    expect(screen.getByLabelText("new.md")).toBeTruthy();
  });

  it("opens and focuses the search box from the global shortcut", async () => {
    render(<DocumentTree />);
    await screen.findByText("src");

    act(() => openDocumentTreeSearch());
    const input = await screen.findByPlaceholderText("搜索文件名或路径");
    await waitFor(() => expect(document.activeElement).toBe(input));

    // The request is one-shot: a later remount does not reopen the search.
    cleanup();
    render(<DocumentTree />);
    await screen.findByText("src");
    expect(screen.queryByPlaceholderText("搜索文件名或路径")).toBeNull();
  });

  it("opens the search when the shortcut arrives before the tree mounts", async () => {
    act(() => openDocumentTreeSearch());
    render(<DocumentTree />);
    expect(await screen.findByPlaceholderText("搜索文件名或路径")).toBeTruthy();
  });

  it("explains an outdated remote host that cannot search files", async () => {
    setActiveDevice({
      kind: "remote",
      deviceId: "dev_1",
      deviceName: "Linux box",
      capabilities: [],
    });
    searchMock.mockRejectedValue(
      new RemoteRequestError("unknown_method", "unknown method"),
    );
    render(<DocumentTree />);
    fireEvent.click(await screen.findByLabelText("搜索文件"));
    fireEvent.change(screen.getByPlaceholderText("搜索文件名或路径"), {
      target: { value: "readme" },
    });
    await screen.findByText("远程设备版本过旧，暂不支持文件搜索");
  });
});
