import { describe, expect, it } from "vitest";
import type {
  GitChangeEntry,
  GitChangeKind,
  GitChangesSnapshot,
} from "../git/types";
import {
  buildFileTreeGitIndex,
  decorateFileTreePath,
  treeAbsolutePath,
} from "./fileTreeGit";

const ROOT = "/repo/main";

function entry(
  path: string,
  kind: GitChangeKind,
  extra: Partial<GitChangeEntry> = {},
): GitChangeEntry {
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
    ...extra,
  };
}

function snapshot(
  entries: GitChangeEntry[],
  checkoutRoot = ROOT,
): GitChangesSnapshot {
  return {
    context: {
      checkoutRoot,
    } as GitChangesSnapshot["context"],
    statusToken: "tok",
    complete: true,
    partialReason: null,
    counts: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ignored: 0,
      conflict: 0,
      renamed: 0,
      submodule: 0,
    },
    entries,
    observedAt: "2026-11-17T00:00:00Z",
  };
}

function decorate(
  entries: GitChangeEntry[],
  rootPath: string,
  relPath: string,
  isDir: boolean,
  checkoutRoot = ROOT,
) {
  return decorateFileTreePath(
    buildFileTreeGitIndex(snapshot(entries, checkoutRoot)),
    rootPath,
    relPath,
    isDir,
  );
}

describe("buildFileTreeGitIndex + decorateFileTreePath", () => {
  it("colors modified files with a badge", () => {
    expect(decorate([entry("src/app.ts", "modified")], ROOT, "src/app.ts", false)).toEqual({
      status: "modified",
      badge: "M",
      dimmed: false,
      dirChanged: false,
      dirStatus: null,
    });
  });

  it("maps every change kind to status and badge", () => {
    const entries = [
      entry("a", "untracked"),
      entry("b", "added"),
      entry("c", "deleted"),
      entry("d", "renamed"),
      entry("e", "conflict"),
      entry("f", "type_changed"),
    ];
    expect(decorate(entries, ROOT, "a", false).badge).toBe("U");
    expect(decorate(entries, ROOT, "b", false).badge).toBe("A");
    expect(decorate(entries, ROOT, "c", false).badge).toBe("D");
    expect(decorate(entries, ROOT, "d", false).badge).toBe("R");
    expect(decorate(entries, ROOT, "e", false)).toMatchObject({
      status: "conflict",
      badge: "!",
    });
    expect(decorate(entries, ROOT, "f", false).badge).toBe("M");
  });

  it("flags conflict through the conflicted flag even when kind differs", () => {
    expect(
      decorate(
        [entry("x", "modified", { conflicted: true })],
        ROOT,
        "x",
        false,
      ).status,
    ).toBe("conflict");
  });

  it("aggregates descendant changes into directory dots with the worst status", () => {
    const entries = [
      entry("src/deep/a.ts", "untracked"),
      entry("src/b.ts", "modified"),
      entry("docs/c.md", "modified"),
    ];
    expect(decorate(entries, ROOT, "src", true)).toMatchObject({
      status: null,
      badge: null,
      dirChanged: true,
      dirStatus: "modified",
    });
    expect(decorate(entries, ROOT, "src/deep", true).dirStatus).toBe("untracked");
    expect(decorate(entries, ROOT, "docs", true).dirChanged).toBe(true);
  });

  it("marks a conflict as the worst directory status", () => {
    expect(
      decorate(
        [entry("src/a", "modified"), entry("src/b", "conflict")],
        ROOT,
        "src",
        true,
      ).dirStatus,
    ).toBe("conflict");
  });

  it("treats files inside an untracked-collapsed directory as untracked", () => {
    const entries = [entry("scratch/", "untracked")];
    expect(decorate(entries, ROOT, "scratch/notes.md", false)).toMatchObject({
      status: "untracked",
      badge: "U",
    });
    expect(decorate(entries, ROOT, "scratch", true)).toMatchObject({
      dirChanged: true,
      dirStatus: "untracked",
    });
  });

  it("dims ignored paths and inherits dimming into ignored directories", () => {
    const entries = [
      entry("node_modules/", "ignored"),
      entry(".env", "ignored"),
      entry("src/app.ts", "modified"),
    ];
    expect(decorate(entries, ROOT, ".env", false).dimmed).toBe(true);
    expect(decorate(entries, ROOT, "node_modules", true).dimmed).toBe(true);
    expect(
      decorate(entries, ROOT, "node_modules/left-pad/index.js", false).dimmed,
    ).toBe(true);
    expect(
      decorate(entries, ROOT, "node_modules/left-pad/index.js", false).status,
    ).toBeNull();
    expect(decorate(entries, ROOT, "src", true).dirChanged).toBe(true);
  });

  it("decorates a Session cwd nested inside the checkout", () => {
    const entries = [entry("packages/app/src/main.ts", "modified")];
    expect(
      decorate(entries, "/repo/main/packages/app", "src/main.ts", false)
        .status,
    ).toBe("modified");
    expect(
      decorate(entries, "/repo/main/packages/app/", "src/main.ts", false)
        .status,
    ).toBe("modified");
  });

  it("returns clean decorations outside the checkout", () => {
    const entries = [entry("a", "modified")];
    expect(decorate(entries, "/elsewhere", "a", false)).toEqual({
      status: null,
      badge: null,
      dimmed: false,
      dirChanged: false,
      dirStatus: null,
    });
    expect(decorate(entries, ROOT, ".", true).dirChanged).toBe(false);
  });

  it("joins tree paths without duplicating separators", () => {
    expect(treeAbsolutePath(ROOT, "src/app.ts")).toBe("/repo/main/src/app.ts");
    expect(treeAbsolutePath(`${ROOT}/`, "/src/app.ts")).toBe(
      "/repo/main/src/app.ts",
    );
    expect(treeAbsolutePath("/", "src/app.ts")).toBe("/src/app.ts");
  });
});
