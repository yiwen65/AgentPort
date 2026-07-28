// @vitest-environment jsdom
// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import GitCenter from "./components/GitCenter";
import {
  emptyGitCenterState,
  getState,
  resolveConfirm,
  setState,
  type GitCheckoutUiState,
} from "./store";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
} from "./types";

const gitCenterStyles = readFileSync("src/styles.css", "utf8");

const context: GitCheckoutDescriptor = {
  target: { projectId: "project-1", kind: "worktree", worktreeId: "worktree-1" },
  checkoutId: "checkout-1",
  repoKey: "repo-1",
  projectName: "Mock Project",
  projectRoot: "/mock/project",
  checkoutRoot: "/mock/worktree",
  expectedBranch: "feature/mock",
  actualBranch: "feature/mock",
  headOid: "a".repeat(40),
  detached: false,
  unborn: false,
  ongoingOperation: null,
  hasRemote: true,
  remote: "origin",
  upstream: "origin/feature/mock",
  ahead: 2,
  behind: 0,
  worktreeHealth: "dirty",
  liveSessionIds: [],
  writable: true,
  blockers: [],
  warnings: [],
};

const bothEntry: GitChangeEntry = {
  entryToken: "both-entry",
  pathToken: "both-path",
  displayPath: "src/both.ts",
  oldPathToken: null,
  displayOldPath: null,
  indexStatus: "M",
  worktreeStatus: "M",
  conflictCode: null,
  kind: "modified",
  submoduleState: null,
  staged: true,
  unstaged: true,
  untracked: false,
  ignored: false,
  conflicted: false,
};

const conflictEntry: GitChangeEntry = {
  ...bothEntry,
  entryToken: "conflict-entry",
  pathToken: "conflict-path",
  displayPath: "src/conflict.ts",
  indexStatus: "U",
  worktreeStatus: "U",
  conflictCode: "UU",
  kind: "conflict",
  staged: false,
  conflicted: true,
};

const ignoredEntry: GitChangeEntry = {
  ...bothEntry,
  entryToken: "ignored-entry",
  pathToken: "ignored-path",
  displayPath: ".local-secret",
  indexStatus: null,
  worktreeStatus: null,
  kind: "ignored",
  staged: false,
  unstaged: false,
  ignored: true,
};

const untrackedEntry: GitChangeEntry = {
  ...bothEntry,
  entryToken: "untracked-entry",
  pathToken: "untracked-path",
  displayPath: "docs/new-file.md",
  indexStatus: null,
  worktreeStatus: null,
  kind: "untracked",
  staged: false,
  unstaged: false,
  untracked: true,
};

function snapshot(
  entries: GitChangeEntry[] = [bothEntry],
  complete = true,
): GitChangesSnapshot {
  return {
    context,
    statusToken: "status-1",
    complete,
    partialReason: complete ? null : "entry_limit",
    counts: {
      staged: entries.filter((entry) => entry.staged).length,
      unstaged: entries.filter((entry) => entry.unstaged).length,
      untracked: entries.filter((entry) => entry.untracked).length,
      ignored: entries.filter((entry) => entry.ignored).length,
      conflict: entries.filter((entry) => entry.conflicted).length,
      renamed: 0,
      submodule: 0,
    },
    entries,
    observedAt: "2026-07-26T00:00:00.000Z",
  };
}

function cache(overrides: Partial<GitCheckoutUiState> = {}): GitCheckoutUiState {
  return {
    context,
    changes: snapshot(),
    changesPhase: "ready",
    changesError: null,
    selectedEntries: {},
    diffSelection: null,
    diff: null,
    diffPhase: "idle",
    diffError: null,
    history: {
      context,
      anchorOid: context.headOid,
      commits: [],
      nextCursor: null,
      headChanged: false,
      observedAt: "2026-07-26T00:00:00.000Z",
    },
    historyPhase: "ready",
    historyError: null,
    selectedCommitOid: null,
    commitDetail: null,
    commitPatch: null,
    commitDetailPhase: "idle",
    commitDetailError: null,
    commitDraft: "",
    commitReview: null,
    commitReviewOpen: false,
    commitPhase: "idle",
    commitError: null,
    commitAiPhase: "idle",
    commitAiError: null,
    lastCommitResult: null,
    ...overrides,
  };
}

function show(current: GitCheckoutUiState, view: "changes" | "history" = "changes") {
  setState({
    gitCenter: {
      ...emptyGitCenterState(),
      open: true,
      view,
      locator: {
        kind: "worktree",
        projectId: "project-1",
        worktreeId: "worktree-1",
      },
      activeCheckoutId: context.checkoutId,
      resolvePhase: "ready",
      caches: { [context.checkoutId]: current },
    },
  });
}

describe("Git Center states", () => {
  beforeEach(() => {
    setState({ gitCenter: emptyGitCenterState(), contextMenu: null });
  });
  afterEach(cleanup);

  it("renders the same MM file independently in staged and unstaged groups", () => {
    show(cache());
    render(<GitCenter />);

    expect(screen.getByText("已暂存")).toBeTruthy();
    expect(screen.getByText("未暂存")).toBeTruthy();
    expect(screen.getAllByText("src/both.ts")).toHaveLength(2);
  });

  it("offers AI commit generation only when staged changes are eligible", () => {
    show(cache());
    const { rerender } = render(<GitCenter />);

    expect(
      (screen.getByRole("button", { name: /AI 生成/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    act(() => show(cache({ changes: snapshot([untrackedEntry]) })));
    rerender(<GitCenter />);
    expect(
      (screen.getByRole("button", { name: /AI 生成/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("blocks writes for partial state while hiding ignored changes", () => {
    show(cache({
      context: { ...context, writable: false, blockers: ["status_partial"] },
      changes: snapshot([conflictEntry, ignoredEntry], false),
    }));
    render(<GitCenter />);

    expect(screen.getByText(/结果不完整/)).toBeTruthy();
    expect(screen.getByText(/存在 1 个冲突/)).toBeTruthy();
    expect(screen.queryByText(".local-secret")).toBeNull();
    expect(screen.queryByText("已忽略")).toBeNull();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("offers a guarded repair only for an exact Worktree branch drift", () => {
    const drifted = {
      ...context,
      expectedBranch: "agent/original",
      actualBranch: "fix/current",
      writable: false,
      blockers: ["worktree_branch_drift"],
    };
    show(cache({
      context: drifted,
      changes: { ...snapshot(), context: drifted },
    }));
    render(<GitCenter />);

    fireEvent.click(screen.getByRole("button", { name: "接受当前分支" }));
    expect(getState().confirm).toMatchObject({
      title: "接受当前分支？",
      confirmLabel: "接受当前分支",
    });
    expect(getState().confirm?.body).toContain("agent/original");
    expect(getState().confirm?.body).toContain("fix/current");
  });

  it("offers batch, file, ignore, trash, diff, view, and remote actions", () => {
    show(cache({
      changes: snapshot([untrackedEntry]),
    }));
    render(<GitCenter />);

    expect(screen.getByRole("button", { name: "全部暂存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("docs/new-file.md"));

    const labels = getState().contextMenu?.items
      .filter((item) => !item.separator)
      .map((item) => item.label);
    expect(labels).toEqual([
      "暂存",
      "移入废纸篓",
      "加入 .gitignore",
      "加入 .git/info/exclude",
      "打开 Diff",
      "查看文件",
    ]);
  });

  it("keeps Pull available for local changes and offers an explicit auto-stash path", async () => {
    show(cache({
      context: {
        ...context,
        liveSessionIds: ["session-1", "session-2"],
      },
    }));
    render(<GitCenter />);

    fireEvent.click(screen.getByRole("button", { name: "更多远端操作" }));
    const pull = getState().contextMenu?.items.find(
      (item) => item.label.startsWith("Pull（仅快进）"),
    );
    expect(pull?.disabled).toBe(false);

    act(() => pull?.action?.());
    expect(getState().confirm).toMatchObject({
      title: "自动储藏本地更改后 Pull？",
      confirmLabel: "自动储藏并 Pull",
      cancelLabel: "先提交",
    });
    expect(getState().confirm?.details).toContain(
      "2 个活动 Session 正在使用此 Checkout；Pull 会修改它们看到的文件。",
    );

    await act(async () => {
      resolveConfirm(false);
      await Promise.resolve();
    });
  });

  it("disables Pull only for a real blocker and exposes the reason", () => {
    show(cache({
      context: {
        ...context,
        upstream: null,
      },
    }));
    render(<GitCenter />);

    fireEvent.click(screen.getByRole("button", { name: "更多远端操作" }));
    const pull = getState().contextMenu?.items.find(
      (item) => item.label.startsWith("Pull（仅快进）"),
    );
    expect(pull?.disabled).toBe(true);
    expect(pull?.tip).toBe("当前分支未设置 upstream");
  });

  it("keeps long Git text inside a narrow Changes column without clipping it", () => {
    show(cache({
      changes: snapshot([{
        ...untrackedEntry,
        displayPath: "docs/system-dataflow-and-startup-architecture.html",
      }]),
      diffSelection: {
        entryToken: untrackedEntry.entryToken,
        pathToken: untrackedEntry.pathToken,
        side: "unstaged",
      },
      diffPhase: "ready",
      diff: {
        context,
        statusToken: "status-1",
        side: "unstaged",
        pathToken: untrackedEntry.pathToken,
        displayPath: "docs/system-dataflow-and-startup-architecture.html",
        format: "text",
        patch: "+content",
        additions: 1,
        deletions: 0,
        fileSize: 8,
        truncated: false,
        reason: null,
        conflictCode: null,
      },
    }));
    const { container } = render(<GitCenter />);

    const path = container.querySelector<HTMLElement>(".git-change-path > span");
    const diffTitle = container.querySelector<HTMLElement>(
      ".git-diff-panel > header strong",
    );

    expect(path?.title).toBe("docs/system-dataflow-and-startup-architecture.html");
    expect(
      container.querySelector(".git-change-path .git-change-label")?.textContent,
    ).toBe("未跟踪");
    expect(diffTitle?.title).toBe(
      "docs/system-dataflow-and-startup-architecture.html",
    );
    expect(gitCenterStyles).toMatch(
      /\.git-center-left\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
    );
    expect(gitCenterStyles).not.toContain("container-type:");
    expect(gitCenterStyles).toMatch(
      /\.git-change-path\s*>\s*span\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/,
    );
    expect(gitCenterStyles).toMatch(
      /\.git-remote-branch\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*hidden;/,
    );
    expect(gitCenterStyles).toMatch(
      /\.git-commit-composer\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/,
    );
    expect(gitCenterStyles).toMatch(
      /\.git-diff-panel\s*>\s*header\s+strong\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/,
    );
  });

  it("renders a dedicated missing Worktree state even when Changes cannot be read", () => {
    show(cache({
      context: {
        ...context,
        writable: false,
        blockers: ["worktree_missing", "worktree_prunable"],
      },
      changes: null,
      changesPhase: "error",
      changesError: "checkout is missing",
    }));
    render(<GitCenter />);

    expect(screen.getByText(/目标 Worktree 不存在/)).toBeTruthy();
    expect(screen.getAllByText(context.checkoutRoot).length).toBeGreaterThan(0);
  });

  it("degrades binary and oversized diffs without claiming completeness", () => {
    show(cache({
      diffSelection: {
        entryToken: bothEntry.entryToken,
        pathToken: bothEntry.pathToken,
        side: "unstaged",
      },
      diffPhase: "ready",
      diff: {
        context,
        statusToken: "status-1",
        side: "unstaged",
        pathToken: bothEntry.pathToken,
        displayPath: "assets/logo.bin",
        format: "binary",
        patch: null,
        additions: null,
        deletions: null,
        fileSize: 2048,
        truncated: false,
        reason: "binary",
        conflictCode: null,
      },
    }));
    const { rerender } = render(<GitCenter />);
    expect(screen.getByText("二进制文件不显示正文。")).toBeTruthy();

    act(() => {
      show(cache({
        diffSelection: {
          entryToken: bothEntry.entryToken,
          pathToken: bothEntry.pathToken,
          side: "unstaged",
        },
        diffPhase: "ready",
        diff: {
          context,
          statusToken: "status-1",
          side: "unstaged",
          pathToken: bothEntry.pathToken,
          displayPath: bothEntry.displayPath,
          format: "summary",
          patch: null,
          additions: null,
          deletions: null,
          fileSize: 2_000_000,
          truncated: true,
          reason: "file_size_limit",
          conflictCode: null,
        },
      }));
    });
    rerender(<GitCenter />);
    expect(screen.getByText("仅显示文件摘要")).toBeTruthy();
    expect(screen.getByText(/file_size_limit/)).toBeTruthy();
  });

  it("keeps history anchored and asks for explicit refresh when HEAD changes", () => {
    show(cache({
      history: {
        context,
        anchorOid: "a".repeat(40),
        commits: [{
          oid: "a".repeat(40),
          shortOid: "aaaaaaaaaaaa",
          parentOids: [],
          authorName: "Mock User",
          authorEmail: "mock@example.test",
          authoredAt: "2026-07-26T00:00:00.000Z",
          committedAt: "2026-07-26T00:00:00.000Z",
          subject: "Initial commit",
        }],
        nextCursor: "opaque-next",
        headChanged: true,
        observedAt: "2026-07-26T00:00:00.000Z",
      },
    }), "history");
    render(<GitCenter />);

    expect(screen.getByText(/发现新提交/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新到最新 HEAD" })).toBeTruthy();
    expect(screen.getByText("Initial commit")).toBeTruthy();
  });

  it("requires an explicit checkbox inside the dedicated commit review dialog", () => {
    show(cache({
      commitDraft: "Subject\n\nBody",
      commitReviewOpen: true,
      commitReview: {
        context,
        commitToken: "commit-token",
        message: "Subject\n\nBody",
        messageHash: "message-hash",
        beforeHead: context.headOid,
        indexHash: "index-hash",
        expectedTreeOid: "tree-oid",
        files: [{
          status: "M",
          pathToken: bothEntry.pathToken,
          displayPath: bothEntry.displayPath,
          oldPathToken: null,
          displayOldPath: null,
          additions: 3,
          deletions: 1,
          binary: false,
          outsideProject: false,
        }],
        outsideProjectPaths: [],
        subjectOver72: false,
        warnings: [],
      },
    }));
    render(<GitCenter />);
    const confirm = screen.getByRole("button", {
      name: "确认并提交全部已暂存内容",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", {
      name: "确认并提交全部已暂存内容",
    }));
    expect(confirm.disabled).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "审查提交范围" });
    expect(within(dialog).getByText((_content, node) =>
      node?.tagName === "PRE" && node.textContent === "Subject\n\nBody",
    )).toBeTruthy();
    expect(within(dialog).getByText("src/both.ts")).toBeTruthy();
  });

  it("keeps commit confirmation disabled while an authoritative refresh is running", () => {
    show(cache({
      changesPhase: "refreshing",
      commitDraft: "Subject",
      commitReviewOpen: true,
      commitReview: {
        context,
        commitToken: "commit-token",
        message: "Subject",
        messageHash: "message-hash",
        beforeHead: context.headOid,
        indexHash: "index-hash",
        expectedTreeOid: "tree-oid",
        files: [{
          status: "M",
          pathToken: bothEntry.pathToken,
          displayPath: bothEntry.displayPath,
          oldPathToken: null,
          displayOldPath: null,
          additions: 1,
          deletions: 0,
          binary: false,
          outsideProject: false,
        }],
        outsideProjectPaths: [],
        subjectOver72: false,
        warnings: [],
      },
    }));
    render(<GitCenter />);
    fireEvent.click(screen.getByRole("checkbox", {
      name: "确认并提交全部已暂存内容",
    }));
    expect((screen.getByRole("button", {
      name: "确认并提交全部已暂存内容",
    }) as HTMLButtonElement).disabled).toBe(true);
  });
});
