// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureDocumentTabRuntime,
  isDocumentTabDirty,
  normalizeDocumentEol,
  resetDocumentTabRuntimes,
  updateDocumentTabRuntime,
} from "./documents";
import type { DocumentTab } from "./store";

const TAB: DocumentTab = {
  id: "/tmp/demo/crlf.md",
  path: "/tmp/demo/crlf.md",
  pinned: true,
  pendingLine: null,
  imageContext: {
    path: "/tmp/demo/crlf.md",
    rootPath: "/tmp/demo",
    device: { kind: "local" },
  },
};

describe("document EOL normalization", () => {
  beforeEach(() => {
    resetDocumentTabRuntimes();
    ensureDocumentTabRuntime(TAB);
  });

  it("treats an LF draft of a CRLF file as clean", () => {
    updateDocumentTabRuntime(TAB.id, {
      doc: {
        path: TAB.path,
        content: "a\r\nb\r\n",
        truncated: false,
        sizeBytes: 6,
      },
      draft: "a\nb\n",
      eol: "crlf",
    });
    expect(isDocumentTabDirty(TAB.id)).toBe(false);
    updateDocumentTabRuntime(TAB.id, { draft: "a\nb\nc\n" });
    expect(isDocumentTabDirty(TAB.id)).toBe(true);
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizeDocumentEol("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeDocumentEol("a\nb")).toBe("a\nb");
  });
});
