import { describe, expect, it } from "vitest";
import { parseGitPatch } from "./gitPatch";

describe("parseGitPatch", () => {
  it("marks added, modified and deleted lines", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      "+extra",
      " three",
      "@@ -9,2 +10,0 @@",
      "-gone",
      "-gone2",
    ].join("\n");
    expect(parseGitPatch(patch)).toEqual([
      { line: 2, type: "deleted" },
      { line: 2, type: "modified" },
      { line: 3, type: "modified" },
      { line: 10, type: "deleted" },
    ]);
  });

  it("marks whole-file additions from untracked patches", () => {
    const patch = "@@ -0,0 +1,2 @@\n+a\n+b\n";
    expect(parseGitPatch(patch)).toEqual([
      { line: 1, type: "added" },
      { line: 2, type: "added" },
    ]);
  });

  it("returns nothing for empty patches", () => {
    expect(parseGitPatch("")).toEqual([]);
  });
});
