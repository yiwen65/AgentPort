import { describe, expect, it } from "vitest";
import {
  buildDocGitIndex,
  decorateDocPath,
  locatorForExplorerRoot,
} from "./docTreeGit";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitChangeKind,
  ProjectView,
} from "./types";

const ROOT = "/repo/main";

function entry(path: string, kind: GitChangeKind, extra: Partial<GitChangeEntry> = {}): GitChangeEntry {
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

function snapshot(entries: GitChangeEntry[], checkoutRoot = ROOT): GitChangesSnapshot {
  return {
    context: {
      target: { projectId: "prj", kind: "main", worktreeId: null },
      checkoutId: "co1",
      repoKey: "repo",
      projectName: "Demo",
      projectRoot: checkoutRoot,
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
    observedAt: "2026-09-19T00:00:00Z",
  };
}

describe("buildDocGitIndex + decorateDocPath", () => {
  it("colors modified files gold with an M badge", () => {
    const index = buildDocGitIndex(snapshot([entry("src/app.ts", "modified")]));
    expect(decorateDocPath(index, `${ROOT}/src/app.ts`, false)).toEqual({
      status: "modified",
      badge: "M",
      dimmed: false,
      dirChanged: false,
      dirStatus: null,
    });
  });

  it("maps every change kind to status and badge", () => {
    const index = buildDocGitIndex(
      snapshot([
        entry("a", "untracked"),
        entry("b", "added"),
        entry("c", "deleted"),
        entry("d", "renamed"),
        entry("e", "conflict"),
        entry("f", "type_changed"),
      ]),
    );
    expect(decorateDocPath(index, `${ROOT}/a`, false).badge).toBe("U");
    expect(decorateDocPath(index, `${ROOT}/b`, false).badge).toBe("A");
    expect(decorateDocPath(index, `${ROOT}/c`, false).badge).toBe("D");
    expect(decorateDocPath(index, `${ROOT}/d`, false).badge).toBe("R");
    expect(decorateDocPath(index, `${ROOT}/e`, false)).toMatchObject({
      status: "conflict",
      badge: "!",
    });
    expect(decorateDocPath(index, `${ROOT}/f`, false).badge).toBe("M");
  });

  it("flags conflict via the conflicted flag even when kind differs", () => {
    const index = buildDocGitIndex(
      snapshot([entry("x", "modified", { conflicted: true })]),
    );
    expect(decorateDocPath(index, `${ROOT}/x`, false).status).toBe("conflict");
  });

  it("aggregates descendant changes into directory dots with worst status", () => {
    const index = buildDocGitIndex(
      snapshot([
        entry("src/deep/a.ts", "untracked"),
        entry("src/b.ts", "modified"),
        entry("docs/c.md", "modified"),
      ]),
    );
    const src = decorateDocPath(index, `${ROOT}/src`, true);
    expect(src).toMatchObject({
      status: null, // dir names stay uncolored
      badge: null, // dirs never get a letter badge
      dirChanged: true,
      dirStatus: "modified", // modified beats untracked
    });
    expect(decorateDocPath(index, `${ROOT}/src/deep`, true).dirStatus).toBe("untracked");
    expect(decorateDocPath(index, `${ROOT}/docs`, true).dirChanged).toBe(true);
  });

  it("marks a conflict as the worst directory status", () => {
    const index = buildDocGitIndex(
      snapshot([entry("src/a", "modified"), entry("src/b", "conflict")]),
    );
    expect(decorateDocPath(index, `${ROOT}/src`, true).dirStatus).toBe("conflict");
  });

  it("treats files inside an untracked-collapsed directory as untracked", () => {
    // git status collapses fully-untracked dirs into one `dir/` entry.
    const index = buildDocGitIndex(snapshot([entry("scratch/", "untracked")]));
    expect(decorateDocPath(index, `${ROOT}/scratch/notes.md`, false)).toMatchObject({
      status: "untracked",
      badge: "U",
    });
    // The directory itself shows a dot (it IS the change).
    expect(decorateDocPath(index, `${ROOT}/scratch`, true)).toMatchObject({
      dirChanged: true,
      dirStatus: "untracked",
    });
  });

  it("dims ignored files and inherits dimming into ignored directories", () => {
    const index = buildDocGitIndex(
      snapshot([
        entry("node_modules/", "ignored"),
        entry(".env", "ignored"),
        entry("src/app.ts", "modified"),
      ]),
    );
    expect(decorateDocPath(index, `${ROOT}/.env`, false).dimmed).toBe(true);
    expect(decorateDocPath(index, `${ROOT}/node_modules`, true).dimmed).toBe(true);
    expect(
      decorateDocPath(index, `${ROOT}/node_modules/left-pad/index.js`, false).dimmed,
    ).toBe(true);
    // Dimmed entries are not status-colored and don't light directory dots.
    expect(decorateDocPath(index, `${ROOT}/node_modules/left-pad/index.js`, false).status).toBeNull();
    expect(decorateDocPath(index, `${ROOT}/src`, true).dirChanged).toBe(true);
  });

  it("returns clean decorations for paths outside the checkout", () => {
    const index = buildDocGitIndex(snapshot([entry("a", "modified")]));
    expect(decorateDocPath(index, "/elsewhere/a", false)).toEqual({
      status: null,
      badge: null,
      dimmed: false,
      dirChanged: false,
      dirStatus: null,
    });
    expect(decorateDocPath(index, ROOT, true).dirChanged).toBe(false);
  });
});

describe("locatorForExplorerRoot", () => {
  const projects: ProjectView[] = [
    {
      id: "prj1",
      name: "Main",
      rootPath: "/repo/main",
      gitRootPath: null,
      pinned: false,
      worktrees: [
        {
          id: "wt1",
          branch: "feature",
          baseCommit: "abc",
          baseRef: null,
          path: "/repo/main/wt-feature",
          health: "ok" as ProjectView["worktrees"][number]["health"],
        },
      ],
      sessions: [],
    },
  ];

  it("prefers the deepest matching worktree over the project main checkout", () => {
    expect(locatorForExplorerRoot("/repo/main/wt-feature/docs", { projects })).toEqual({
      kind: "worktree",
      projectId: "prj1",
      worktreeId: "wt1",
    });
    expect(locatorForExplorerRoot("/repo/main", { projects })).toEqual({
      kind: "projectMain",
      projectId: "prj1",
    });
  });

  it("returns null for roots outside every known project", () => {
    expect(locatorForExplorerRoot("/tmp/random", { projects })).toBeNull();
    expect(locatorForExplorerRoot("/repo/mainish", { projects })).toBeNull();
  });
});
