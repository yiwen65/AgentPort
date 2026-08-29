import { describe, expect, it } from "vitest";
import {
  computeLineRange,
  formatSelectionReference,
  formatTerminalReference,
  readDragPayload,
  writeDragPayload,
  TREE_DND_MIME,
} from "./terminalDrop";

function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
    effectAllowed: "uninitialized",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

describe("tree drag payload round-trip", () => {
  it("serializes path and dir flag with a text fallback", () => {
    const dt = fakeDataTransfer();
    writeDragPayload(dt, { path: "/Users/w/docs/报告.md", isDir: false });
    expect(readDragPayload(dt)).toEqual({ path: "/Users/w/docs/报告.md", isDir: false });
    expect(dt.getData("text/plain")).toBe("/Users/w/docs/报告.md");
    expect(dt.types).toContain(TREE_DND_MIME);
  });

  it("rejects foreign or malformed drops", () => {
    const dt = fakeDataTransfer();
    expect(readDragPayload(dt)).toBeNull();
    dt.setData(TREE_DND_MIME, "not json");
    expect(readDragPayload(dt)).toBeNull();
  });

  it("falls back to absolute-path text drags", () => {
    const dt = fakeDataTransfer();
    dt.setData("text/plain", "/Users/w/docs/report.md");
    expect(readDragPayload(dt)).toEqual({ path: "/Users/w/docs/report.md", isDir: false });
    dt.setData("text/plain", "hello world");
    expect(readDragPayload(dt)).toBeNull();
  });

  it("accepts Finder file URLs", () => {
    const dt = fakeDataTransfer();
    dt.setData("text/uri-list", "file:///Users/w/My%20Docs/%E6%8A%A5%E5%91%8A.md\r\n");
    expect(readDragPayload(dt)).toEqual({
      path: "/Users/w/My Docs/报告.md",
      isDir: false,
    });
  });
});

describe("formatTerminalReference", () => {
  it("uses @path references for agent sessions", () => {
    expect(formatTerminalReference("/Users/w/docs/report.md", false, "claude")).toBe(
      "@/Users/w/docs/report.md ",
    );
    expect(formatTerminalReference("/Users/w/docs", true, "codex")).toBe(
      "@/Users/w/docs ",
    );
  });

  it("quotes references whose paths contain whitespace", () => {
    expect(formatTerminalReference("/Users/w/My Docs/report.md", false, "claude")).toBe(
      "'@/Users/w/My Docs/report.md' ",
    );
  });

  it("inserts plain (quoted) paths for shell sessions", () => {
    expect(formatTerminalReference("/Users/w/docs/report.md", false, "shell")).toBe(
      "/Users/w/docs/report.md ",
    );
    expect(formatTerminalReference("/Users/w/My Docs/report.md", false, "shell")).toBe(
      "'/Users/w/My Docs/report.md' ",
    );
  });

  it("escapes single quotes inside quoted paths", () => {
    expect(formatTerminalReference("/tmp/it's.md", false, "shell")).toBe(
      "'/tmp/it'\\''s.md' ",
    );
  });
});

describe("computeLineRange", () => {
  it("maps character offsets to one-based lines", () => {
    const content = "one\ntwo\nthree\nfour";
    expect(computeLineRange(content, 0, 3)).toEqual({ startLine: 1, endLine: 1 });
    expect(computeLineRange(content, 4, 10)).toEqual({ startLine: 2, endLine: 3 });
    expect(computeLineRange(content, 4, 18)).toEqual({ startLine: 2, endLine: 4 });
  });
});

describe("formatSelectionReference", () => {
  it("emits a path:line locator without pasting the selected text", () => {
    expect(
      formatSelectionReference({
        path: "/Users/w/docs/报告.md",
        startLine: 3,
        endLine: 3,
      }),
    ).toBe("/Users/w/docs/报告.md:3 ");
  });

  it("uses start-end for ranges and collapses single-line ranges", () => {
    expect(
      formatSelectionReference({
        path: "/a/b.md",
        startLine: 2,
        endLine: 5,
      }),
    ).toBe("/a/b.md:2-5 ");
    expect(
      formatSelectionReference({
        path: "/a/b.md",
        startLine: 2,
        endLine: 2,
      }),
    ).toBe("/a/b.md:2 ");
  });

  it("falls back to the bare path when line info is missing (preview)", () => {
    expect(
      formatSelectionReference({
        path: "/a/b.md",
        startLine: null,
        endLine: null,
      }),
    ).toBe("/a/b.md ");
  });

});
