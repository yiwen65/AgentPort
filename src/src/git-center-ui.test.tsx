// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import GitCenter from "./components/GitCenter";
import {
  emptyGitCenterState,
  setState,
  type GitCheckoutUiState,
} from "./store";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
} from "./types";

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
    setState({ gitCenter: emptyGitCenterState() });
  });
  afterEach(cleanup);

  it("renders the same MM file independently in staged and unstaged groups", () => {
    show(cache());
    render(<GitCenter />);

    expect(screen.getByText("已暂存")).toBeTruthy();
    expect(screen.getByText("未暂存")).toBeTruthy();
    expect(screen.getAllByText("src/both.ts")).toHaveLength(2);
  });

  it("blocks writes for partial state while rendering conflict and ignored details", () => {
    show(cache({
      context: { ...context, writable: false, blockers: ["status_partial"] },
      changes: snapshot([conflictEntry, ignoredEntry], false),
    }));
    render(<GitCenter />);

    expect(screen.getByText(/结果不完整/)).toBeTruthy();
    expect(screen.getByText(/存在 1 个冲突/)).toBeTruthy();
    expect(screen.getByText(/ignored 文件只显示名称/)).toBeTruthy();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
    }
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
