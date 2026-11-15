import { describe, expect, it } from "vitest";
import { relativePathInRoot, resolveDocumentLink } from "./markdownReader/links";

const context = { path: "/root/guide/index.md", rootPath: "/root" };

describe("resolveDocumentLink", () => {
  it("classifies external, anchor and workspace links", () => {
    expect(resolveDocumentLink("https://example.com/a?b=1", context)).toEqual({
      kind: "external",
      href: "https://example.com/a?b=1",
      domain: "example.com",
    });
    expect(resolveDocumentLink("#install", context)).toEqual({
      kind: "anchor",
      anchor: "install",
    });
    expect(resolveDocumentLink("./setup/start.md#run", context)).toEqual({
      kind: "document",
      path: "/root/guide/setup/start.md",
      line: null,
      anchor: "run",
    });
    expect(resolveDocumentLink("../README.md:12:3", context)).toEqual({
      kind: "document",
      path: "/root/README.md",
      line: 12,
      anchor: null,
    });
    expect(resolveDocumentLink("a%20b.md", context)).toEqual({
      kind: "document",
      path: "/root/guide/a b.md",
      line: null,
      anchor: null,
    });
  });

  it("rejects paths outside the root and unsupported schemes", () => {
    expect(resolveDocumentLink("../../etc/passwd", context)).toEqual({
      kind: "unresolved",
      reason: "outside-root",
    });
    expect(resolveDocumentLink("/etc/passwd", context)).toEqual({
      kind: "unresolved",
      reason: "outside-root",
    });
    expect(resolveDocumentLink("file:///etc/passwd", context)).toEqual({
      kind: "unresolved",
      reason: "unsupported-scheme",
    });
    expect(resolveDocumentLink("javascript:alert(1)", context)).toEqual({
      kind: "unresolved",
      reason: "unsupported-scheme",
    });
  });

  it("computes root-relative paths for copied heading links", () => {
    expect(relativePathInRoot("/root/guide/a.md", "/root")).toBe("guide/a.md");
    expect(relativePathInRoot("/other/a.md", "/root")).toBeNull();
  });
});
