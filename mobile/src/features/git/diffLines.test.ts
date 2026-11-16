import { describe, expect, it } from "vitest";
import { parseDiffLines } from "./diffLines";

function rows(patch: string) {
  return parseDiffLines(patch).map((line) => [line.kind, line.oldNumber, line.newNumber]);
}

describe("diff line numbers", () => {
  it("follows hunk headers for context, deletion, and addition lines", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,3 +10,4 @@ function demo() {",
      " keep",
      "-old",
      "+new",
      "+extra",
      " tail",
    ].join("\n");

    expect(rows(patch)).toEqual([
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["hunk", null, null],
      ["", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["", 12, 13],
    ]);
  });

  it("numbers synthesized untracked patches that omit a hunk header", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "+first",
      "+second",
      "\\ No newline at end of file",
    ].join("\n");

    expect(rows(patch)).toEqual([
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["add", null, 1],
      ["add", null, 2],
      ["meta", null, null],
    ]);
  });

  it("keeps added content that looks like a file header inside an implicit patch", () => {
    const patch = [
      "diff --git a/notes.txt b/notes.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes.txt",
      "+++ x",
      "+last",
    ].join("\n");

    expect(rows(patch)).toEqual([
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["add", null, 1],
      ["add", null, 2],
    ]);
  });

  it("keeps old and new counters independent across files", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -40,2 +40,2 @@",
      " same",
      "-c",
      "+d",
    ].join("\n");

    expect(rows(patch)).toEqual([
      ["hunk", null, null],
      ["del", 1, null],
      ["add", null, 1],
      ["hunk", null, null],
      ["", 40, 40],
      ["del", 41, null],
      ["add", null, 41],
    ]);
  });

  it("does not render a phantom row for a trailing newline", () => {
    const lines = parseDiffLines("@@ -1 +1 @@\n-old\n+new\n");
    expect(lines.map((line) => line.kind)).toEqual(["hunk", "del", "add"]);
  });
});
