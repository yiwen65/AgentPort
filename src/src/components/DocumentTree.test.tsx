// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, createMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { listDocumentDirectory: listMock, createDocumentEntry: createMock },
  errorText: (error: unknown) => String(error),
}));

import { getState, setState } from "../store";
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
    setState({ explorerRoot: ROOT, explorerOpen: true, openDocument: null });
  });

  afterEach(() => {
    cleanup();
    setState({ explorerRoot: null, explorerOpen: false, openDocument: null });
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
    expect(getState().openDocument).toEqual({
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
    expect(getState().openDocument).toEqual({
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
    expect(getState().openDocument).toBeNull();
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
