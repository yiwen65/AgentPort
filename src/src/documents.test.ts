import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDocumentPendingLine,
  closeDocumentTab,
  closeDocumentTabsUnder,
  documentPathFallbacks,
  ensureDocumentTabRuntime,
  getDocumentTabRuntime,
  isDocumentTabDirty,
  isMarkdownPath,
  moveDocumentTab,
  openDocumentTarget,
  openDocumentTargetToSide,
  parseDocumentLinkTarget,
  pinDocumentTab,
  resetDocumentTabRuntimes,
  setActiveDocumentTab,
  updateDocumentTabPath,
  updateDocumentTabRuntime,
} from "./documents";
import { getActiveDocumentTab, getState, resolveConfirm, setState } from "./store";

describe("parseDocumentLinkTarget", () => {
  it("parses file:// URIs with percent-decoding and line suffixes", () => {
    expect(
      parseDocumentLinkTarget("file:///Users/w/docs/%E6%8A%A5%E5%91%8A.md:12:3"),
    ).toEqual({ path: "/Users/w/docs/报告.md", line: 12 });
    expect(parseDocumentLinkTarget("file://localhost/Users/w/a.md")).toEqual({
      path: "/Users/w/a.md",
      line: null,
    });
  });

  it("parses plain absolute paths with optional positions", () => {
    expect(parseDocumentLinkTarget("/Users/w/docs/report.md")).toEqual({
      path: "/Users/w/docs/report.md",
      line: null,
    });
    expect(parseDocumentLinkTarget("/Users/w/docs/report.md:42")).toEqual({
      path: "/Users/w/docs/report.md",
      line: 42,
    });
  });

  it("resolves relative paths against an absolute session cwd", () => {
    expect(
      parseDocumentLinkTarget("src/components/App.tsx:9", "/tmp/project"),
    ).toEqual({
      path: "/tmp/project/src/components/App.tsx",
      line: 9,
    });
    expect(
      parseDocumentLinkTarget("../README.md", "/tmp/project/src"),
    ).toEqual({
      path: "/tmp/project/README.md",
      line: null,
    });
  });

  it("keeps colons that are not trailing digit groups", () => {
    expect(parseDocumentLinkTarget("/tmp/weird:dir/file.md")).toEqual({
      path: "/tmp/weird:dir/file.md",
      line: null,
    });
  });

  it("rejects non-local targets", () => {
    expect(parseDocumentLinkTarget("https://example.com/a.md")).toBeNull();
    expect(parseDocumentLinkTarget("vscode://file/Users/w/a.md")).toBeNull();
    expect(parseDocumentLinkTarget("file://nas/share/a.md")).toBeNull();
    expect(parseDocumentLinkTarget("docs/relative.md")).toBeNull();
    expect(parseDocumentLinkTarget("/")).toBeNull();
    expect(parseDocumentLinkTarget("")).toBeNull();
  });
});

describe("documentPathFallbacks", () => {
  it("trims trailing prose punctuation and re-strips an exposed line suffix", () => {
    expect(documentPathFallbacks("/Users/w/AI/AI心法.md,")).toEqual([
      "/Users/w/AI/AI心法.md",
    ]);
    expect(documentPathFallbacks("/a/b.md:3,")).toEqual(["/a/b.md"]);
  });

  it("cuts at the first CJK sentence punctuation mark", () => {
    expect(documentPathFallbacks("/Users/w/AI/AI心法.md，包含八重心法：")).toEqual([
      "/Users/w/AI/AI心法.md",
    ]);
  });

  it("returns no fallbacks for clean paths", () => {
    expect(documentPathFallbacks("/a/b.md")).toEqual([]);
  });
});

describe("isMarkdownPath", () => {
  it("recognizes markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("/a/b/README.md")).toBe(true);
    expect(isMarkdownPath("/a/b/notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/a/b/page.mdx")).toBe(true);
    expect(isMarkdownPath("/a/b/script.ts")).toBe(false);
    expect(isMarkdownPath("/a/b/Makefile")).toBe(false);
  });
});

describe("document tab groups", () => {
  beforeEach(() => {
    setState({ docGroups: [], activeDocGroupIndex: 0, confirm: null });
    resetDocumentTabRuntimes();
  });

  afterEach(() => {
    setState({ docGroups: [], activeDocGroupIndex: 0, confirm: null });
    resetDocumentTabRuntimes();
  });

  function tabIds(groupIndex = 0): string[] {
    return getState().docGroups[groupIndex]?.tabs.map((tab) => tab.id) ?? [];
  }

  function activeTabId(): string | null {
    return getActiveDocumentTab(getState())?.id ?? null;
  }

  function seedRuntime(tabId: string): void {
    const tab = getState()
      .docGroups.flatMap((group) => group.tabs)
      .find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`tab not open: ${tabId}`);
    ensureDocumentTabRuntime(tab);
  }

  function makeDirty(tabId: string): void {
    seedRuntime(tabId);
    updateDocumentTabRuntime(tabId, {
      doc: { path: tabId, content: "saved", truncated: false, sizeBytes: 5 },
      draft: "edited",
    });
  }

  it("opens the first file as a preview tab in a single group", () => {
    openDocumentTarget({ path: "/a.md", line: null });
    expect(tabIds()).toEqual(["/a.md"]);
    expect(getState().docGroups[0]?.tabs[0]?.pinned).toBe(false);
    expect(activeTabId()).toBe("/a.md");
  });

  it("replaces the group's preview tab on the next plain open", () => {
    openDocumentTarget({ path: "/a.md", line: null });
    seedRuntime("/a.md");
    openDocumentTarget({ path: "/b.md", line: null });
    expect(tabIds()).toEqual(["/b.md"]);
    // The replaced tab's runtime is dropped with it.
    expect(getDocumentTabRuntime("/a.md")).toBeNull();
  });

  it("keeps pinned tabs and appends further opens", () => {
    openDocumentTarget({ path: "/a.md", line: null });
    pinDocumentTab("/a.md");
    openDocumentTarget({ path: "/b.md", line: null });
    expect(tabIds()).toEqual(["/a.md", "/b.md"]);
    expect(activeTabId()).toBe("/b.md");
  });

  it("a pinned (double-click) open does not consume the preview slot", () => {
    openDocumentTarget({ path: "/preview.md", line: null });
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    expect(tabIds()).toEqual(["/preview.md", "/a.md"]);
    expect(getState().docGroups[0]?.tabs[1]?.pinned).toBe(true);
  });

  it("activates an already-open path instead of duplicating it", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/b.md", line: null });
    openDocumentTarget({ path: "/a.md", line: 7 });
    expect(tabIds()).toEqual(["/a.md", "/b.md"]);
    expect(activeTabId()).toBe("/a.md");
    expect(getActiveDocumentTab(getState())?.pendingLine).toBe(7);
  });

  it("pins the preview tab on a pinned re-open of the same path", () => {
    openDocumentTarget({ path: "/a.md", line: null });
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    expect(tabIds()).toEqual(["/a.md"]);
    expect(getState().docGroups[0]?.tabs[0]?.pinned).toBe(true);
  });

  it("opens to the side in a second group as a pinned tab", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTargetToSide({ path: "/b.md", line: null });
    expect(getState().docGroups).toHaveLength(2);
    expect(tabIds(1)).toEqual(["/b.md"]);
    expect(getState().docGroups[1]?.tabs[0]?.pinned).toBe(true);
    expect(getState().activeDocGroupIndex).toBe(1);
  });

  it("moves an already-open file to the side group instead of duplicating", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/b.md", line: null }, { pinned: true });
    openDocumentTargetToSide({ path: "/a.md", line: null });
    expect(tabIds(0)).toEqual(["/b.md"]);
    expect(tabIds(1)).toEqual(["/a.md"]);
    expect(getState().activeDocGroupIndex).toBe(1);
  });

  it("collapses a group when its last tab moves to the other group", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTargetToSide({ path: "/b.md", line: null });
    expect(getState().docGroups).toHaveLength(2);
    moveDocumentTab("/b.md", 0);
    expect(getState().docGroups).toHaveLength(1);
    expect(tabIds()).toEqual(["/a.md", "/b.md"]);
    expect(getState().activeDocGroupIndex).toBe(0);
  });

  it("refuses a third split", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTargetToSide({ path: "/b.md", line: null });
    moveDocumentTab("/b.md", 2);
    expect(getState().docGroups).toHaveLength(2);
    expect(tabIds(1)).toEqual(["/b.md"]);
  });

  it("reorders tabs within a group", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/b.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/c.md", line: null }, { pinned: true });
    moveDocumentTab("/c.md", 0, "/a.md");
    expect(tabIds()).toEqual(["/c.md", "/a.md", "/b.md"]);
  });

  it("closes a clean tab and activates the tab that slid into its slot", () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/b.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/c.md", line: null }, { pinned: true });
    setActiveDocumentTab("/b.md");
    closeDocumentTab("/b.md");
    expect(tabIds()).toEqual(["/a.md", "/c.md"]);
    expect(activeTabId()).toBe("/c.md");
    expect(getState().confirm).toBeNull();
  });

  it("asks before closing a dirty tab and honors the answer", async () => {
    openDocumentTarget({ path: "/a.md", line: null }, { pinned: true });
    makeDirty("/a.md");
    expect(isDocumentTabDirty("/a.md")).toBe(true);

    closeDocumentTab("/a.md");
    expect(getState().confirm).not.toBeNull();
    expect(tabIds()).toEqual(["/a.md"]);

    resolveConfirm(false);
    await Promise.resolve(); // flush the confirm callback microtask
    expect(tabIds()).toEqual(["/a.md"]);

    closeDocumentTab("/a.md");
    resolveConfirm(true);
    await Promise.resolve();
    expect(tabIds()).toEqual([]);
    expect(getDocumentTabRuntime("/a.md")).toBeNull();
  });

  it("closes tabs under a deleted path without asking", () => {
    openDocumentTarget({ path: "/dir/a.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/dir/sub/b.md", line: null }, { pinned: true });
    openDocumentTarget({ path: "/other.md", line: null }, { pinned: true });
    makeDirty("/dir/a.md");
    closeDocumentTabsUnder("/dir");
    expect(tabIds()).toEqual(["/other.md"]);
  });

  it("rekeys an open tab and its runtime on rename", () => {
    openDocumentTarget({ path: "/old.md", line: null }, { pinned: true });
    seedRuntime("/old.md");
    updateDocumentTabRuntime("/old.md", {
      doc: { path: "/old.md", content: "saved", truncated: false, sizeBytes: 5 },
      draft: "edited",
    });
    updateDocumentTabPath("/old.md", "/new.md");
    expect(tabIds()).toEqual(["/new.md"]);
    expect(activeTabId()).toBe("/new.md");
    expect(getDocumentTabRuntime("/old.md")).toBeNull();
    expect(getDocumentTabRuntime("/new.md")?.draft).toBe("edited");
    expect(getDocumentTabRuntime("/new.md")?.doc?.path).toBe("/new.md");
  });

  it("leaves expanded mode when the last tab closes", () => {
    // Regression: the old closeDocument() reset docPanelExpanded together
    // with the document; without that a tree-only panel keeps the expanded
    // flex class and stretches into a blank area beside the tree.
    openDocumentTarget({ path: "/a.md", line: null });
    setState({ docPanelExpanded: true });
    closeDocumentTab("/a.md");
    expect(getState().docGroups).toEqual([]);
    expect(getState().docPanelExpanded).toBe(false);
  });

  it("consumes a pending line reveal once", () => {
    openDocumentTarget({ path: "/a.md", line: 5 });
    expect(getActiveDocumentTab(getState())?.pendingLine).toBe(5);
    clearDocumentPendingLine("/a.md");
    expect(getActiveDocumentTab(getState())?.pendingLine).toBeNull();
  });
});
