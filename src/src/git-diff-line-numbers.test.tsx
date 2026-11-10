// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiffText } from "./components/GitDiffPanel";

afterEach(cleanup);

function rowNumbers(container: HTMLElement): Array<[string, string]> {
  return [...container.querySelectorAll(".git-diff-code > span")].map((row) => {
    const [oldNumber, newNumber] = row.querySelectorAll(".git-diff-line-no");
    return [oldNumber.textContent ?? "", newNumber.textContent ?? ""];
  });
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

    const { container } = render(<DiffText patch={patch} />);

    expect(rowNumbers(container)).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
      ["", ""],
      ["", ""],
      ["10", "10"],
      ["11", ""],
      ["", "11"],
      ["", "12"],
      ["12", "13"],
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

    const { container } = render(<DiffText patch={patch} />);

    expect(rowNumbers(container)).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
      ["", ""],
      ["", "1"],
      ["", "2"],
      ["", ""],
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

    const { container } = render(<DiffText patch={patch} />);

    expect(rowNumbers(container)).toEqual([
      ["", ""],
      ["1", ""],
      ["", "1"],
      ["", ""],
      ["40", "40"],
      ["41", ""],
      ["", "41"],
    ]);
  });
});
