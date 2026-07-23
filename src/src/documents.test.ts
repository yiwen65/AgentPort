import { describe, expect, it } from "vitest";
import {
  documentPathFallbacks,
  isMarkdownPath,
  parseDocumentLinkTarget,
} from "./documents";

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
