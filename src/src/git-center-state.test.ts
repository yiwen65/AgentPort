// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    resolveGitContext: vi.fn(),
    getGitChanges: vi.fn(),
    getGitDiff: vi.fn(),
    getGitHistory: vi.fn(),
    getGitCommitDetail: vi.fn(),
    getGitCommitDiff: vi.fn(),
    stageGitPaths: vi.fn(),
    unstageGitPaths: vi.fn(),
    syncGitRemote: vi.fn(),
    generateGitCommitMessage: vi.fn(),
    prepareGitCommit: vi.fn(),
    commitGitChanges: vi.fn(),
  },
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: apiMock };
});

import {
  confirmGitCommit,
  handleGitStateInvalidation,
  mutateGitSelection,
  noteActiveSessionForGitCenter,
  openGitCenter,
  prepareGitCommitReview,
  refreshGitChanges,
  resetGitCenterStateForTests,
  generateGitCommitMessage,
  runGitRemoteAction,
  setGitCommitDraft,
  setGitSelection,
} from "./gitCenter";
import { getState, resolveConfirm, setState } from "./store";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
  GitCommitReview,
  GitContextLocator,
  GitHistoryPage,
} from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function context(id: string, projectId = "project-1"): GitCheckoutDescriptor {
  return {
    target: { projectId, kind: "main", worktreeId: null },
    checkoutId: id,
    repoKey: `repo-${projectId}`,
    projectName: projectId,
    projectRoot: `/mock/${projectId}`,
    checkoutRoot: `/mock/${projectId}`,
    expectedBranch: null,
    actualBranch: "main",
    headOid: "a".repeat(40),
    detached: false,
    unborn: false,
    ongoingOperation: null,
    hasRemote: true,
    remote: "origin",
    remoteUrl: null,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    worktreeHealth: null,
    liveSessionIds: [],
    writable: true,
    blockers: [],
    warnings: [],
  };
}

const entry: GitChangeEntry = {
  entryToken: "entry-1",
  pathToken: "path-1",
  displayPath: "src/example.ts",
  oldPathToken: null,
  displayOldPath: null,
  indexStatus: null,
  worktreeStatus: "M",
  conflictCode: null,
  kind: "modified",
  submoduleState: null,
  staged: false,
  unstaged: true,
  untracked: false,
  ignored: false,
  conflicted: false,
};

function changes(
  target: GitCheckoutDescriptor,
  statusToken = "status-1",
  entries: GitChangeEntry[] = [entry],
): GitChangesSnapshot {
  return {
    context: target,
    statusToken,
    complete: true,
    partialReason: null,
    counts: {
      staged: entries.filter((item) => item.staged).length,
      unstaged: entries.filter((item) => item.unstaged).length,
      untracked: entries.filter((item) => item.untracked).length,
      ignored: entries.filter((item) => item.ignored).length,
      conflict: entries.filter((item) => item.conflicted).length,
      renamed: entries.filter((item) => item.kind === "renamed").length,
      submodule: entries.filter((item) => item.submoduleState !== null).length,
    },
    entries,
    observedAt: "2026-07-26T00:00:00.000Z",
  };
}

function history(target: GitCheckoutDescriptor): GitHistoryPage {
  return {
    context: target,
    anchorOid: target.headOid,
    commits: [],
    nextCursor: null,
    headChanged: false,
    observedAt: "2026-07-26T00:00:00.000Z",
  };
}

function locator(projectId: string): GitContextLocator {
  return { kind: "projectMain", projectId };
}

describe("Git Center checkout authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitCenterStateForTests();
    setState({ activeSessionId: "session-original" });
    apiMock.getGitHistory.mockImplementation(
      async (target: GitContextLocator) => {
        const projectId = target.kind === "projectMain" ? target.projectId : "project-1";
        return history(context(`checkout-${projectId}`, projectId));
      },
    );
  });

  afterEach(() => {
    cleanup();
    resetGitCenterStateForTests();
  });

  it("drops a late response whose checkoutId is no longer active", async () => {
    const lateA = deferred<GitChangesSnapshot>();
    apiMock.resolveGitContext.mockImplementation(async (target: GitContextLocator) => {
      const projectId = target.kind === "projectMain" ? target.projectId : "project-1";
      return context(`checkout-${projectId}`, projectId);
    });
    apiMock.getGitChanges.mockImplementation((target: GitContextLocator) => {
      const projectId = target.kind === "projectMain" ? target.projectId : "project-1";
      return projectId === "a"
        ? lateA.promise
        : Promise.resolve(changes(context("checkout-b", "b"), "status-b"));
    });

    let openingA!: Promise<void>;
    await act(async () => {
      openingA = openGitCenter(locator("a"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.getGitChanges).toHaveBeenCalled());

    await act(async () => {
      await openGitCenter(locator("b"));
    });
    expect(getState().gitCenter.activeCheckoutId).toBe("checkout-b");

    await act(async () => {
      lateA.resolve(changes(context("checkout-a", "a"), "late-status"));
      await openingA;
    });

    expect(getState().gitCenter.activeCheckoutId).toBe("checkout-b");
    expect(getState().gitCenter.caches["checkout-b"].changes?.statusToken).toBe("status-b");
    expect(getState().gitCenter.caches["checkout-a"].changes).toBeNull();
  });

  it("freezes the target when the active Session changes", async () => {
    const target = context("checkout-a", "a");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(changes(target));
    apiMock.getGitHistory.mockResolvedValue(history(target));
    await act(async () => {
      await openGitCenter(locator("a"));
    });

    act(() => noteActiveSessionForGitCenter("session-new"));

    expect(getState().gitCenter.activeCheckoutId).toBe("checkout-a");
    expect(getState().gitCenter.pendingSessionLocator).toEqual({
      kind: "session",
      sessionId: "session-new",
    });
    expect(apiMock.resolveGitContext).toHaveBeenCalledTimes(1);
  });

  it("sends checkout/status CAS tokens and applies a stale authoritative snapshot without losing the draft", async () => {
    const target = context("checkout-a", "a");
    const initial = changes(target, "status-old");
    const fresh = changes(target, "status-new");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(initial);
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.stageGitPaths.mockRejectedValue({
      code: "stale",
      message: "index changed",
      recoverable: true,
      currentChanges: fresh,
    });
    await act(async () => {
      await openGitCenter(locator("a"));
    });
    act(() => {
      setGitCommitDraft("keep this draft");
      setGitSelection(entry, "unstaged", true);
    });

    await act(async () => {
      await mutateGitSelection("unstaged");
    });

    expect(apiMock.stageGitPaths).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "status-old",
      [{ pathToken: "path-1", entryToken: "entry-1" }],
    );
    const cache = getState().gitCenter.caches["checkout-a"];
    expect(cache.changes?.statusToken).toBe("status-new");
    expect(cache.changesPhase).toBe("stale");
    expect(cache.commitDraft).toBe("keep this draft");
  });

  it("maps a confirmed dirty Pull to the explicit backend auto-stash action", async () => {
    const target = {
      ...context("checkout-a", "a"),
      liveSessionIds: ["session-1"],
    };
    const dirty = changes(target, "status-dirty");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(dirty);
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.syncGitRemote.mockResolvedValue({
      operationId: "remote-1",
      changes: dirty,
    });
    await act(async () => {
      await openGitCenter(locator("a"));
    });

    let pulling!: Promise<void>;
    act(() => {
      pulling = runGitRemoteAction("pull");
    });
    expect(getState().confirm?.confirmLabel).toBe("自动储藏并 Pull");

    await act(async () => {
      resolveConfirm(true);
      await pulling;
    });
    expect(apiMock.syncGitRemote).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "status-dirty",
      "pull_autostash",
    );
  });

  it("fills the commit draft only from a suggestion for the current staged status", async () => {
    const stagedEntry = {
      ...entry,
      indexStatus: "M",
      worktreeStatus: null,
      staged: true,
      unstaged: false,
    };
    const target = context("checkout-a", "a");
    const staged = changes(target, "status-staged", [stagedEntry]);
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(staged);
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.generateGitCommitMessage.mockResolvedValue({
      statusToken: "status-staged",
      subject: "feat(git): 新增提交信息生成功能",
      body: "根据已暂存变更生成符合规范的中文提交主题和正文。",
      message:
        "feat(git): 新增提交信息生成功能\n\n" +
        "根据已暂存变更生成符合规范的中文提交主题和正文。",
      truncated: false,
    });
    await act(async () => {
      await openGitCenter(locator("a"));
      await generateGitCommitMessage();
    });

    expect(apiMock.generateGitCommitMessage).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "status-staged",
    );
    expect(getState().gitCenter.caches["checkout-a"].commitDraft).toBe(
      "feat(git): 新增提交信息生成功能\n\n" +
        "根据已暂存变更生成符合规范的中文提交主题和正文。",
    );
  });

  it("treats an event as invalidation, never as a replacement snapshot", async () => {
    vi.useFakeTimers();
    const target = context("checkout-a", "a");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(changes(target, "status-old"));
    apiMock.getGitHistory.mockResolvedValue(history(target));
    await act(async () => {
      await openGitCenter(locator("a"));
    });

    act(() => handleGitStateInvalidation({
      repoKey: target.repoKey,
      checkoutIds: [target.checkoutId],
      scopes: ["changes"],
      reason: "external",
      operationId: "op",
      observedAt: "2026-07-26T00:00:01.000Z",
    }));

    expect(getState().gitCenter.caches[target.checkoutId].changesPhase).toBe("stale");
    expect(getState().gitCenter.caches[target.checkoutId].changes?.statusToken).toBe("status-old");
    vi.useRealTimers();
  });

  it("does not call commit until review and explicit confirmation are separate actions", async () => {
    const stagedEntry = {
      ...entry,
      indexStatus: "M",
      worktreeStatus: null,
      staged: true,
      unstaged: false,
    };
    const target = context("checkout-a", "a");
    const snapshot = changes(target, "status-staged", [stagedEntry]);
    const review: GitCommitReview = {
      context: target,
      commitToken: "commit-token",
      message: "subject\n\nbody",
      messageHash: "message-hash",
      beforeHead: target.headOid,
      indexHash: "index-hash",
      expectedTreeOid: "tree-oid",
      files: [{
        status: "M",
        pathToken: stagedEntry.pathToken,
        displayPath: stagedEntry.displayPath,
        oldPathToken: null,
        displayOldPath: null,
        additions: 1,
        deletions: 1,
        binary: false,
        outsideProject: false,
      }],
      outsideProjectPaths: [],
      subjectOver72: false,
      warnings: [],
    };
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(snapshot);
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.prepareGitCommit.mockResolvedValue(review);
    apiMock.commitGitChanges.mockResolvedValue({
      operationId: "commit-1",
      outcome: "succeeded",
      beforeHead: target.headOid,
      afterHead: "b".repeat(40),
      expectedTreeOid: "c".repeat(40),
      actualTreeOid: "c".repeat(40),
      changes: changes({ ...target, headOid: "b".repeat(40) }, "clean", []),
      error: null,
    });
    await act(async () => {
      await openGitCenter(locator("a"));
    });
    act(() => setGitCommitDraft(review.message));
    await act(async () => {
      await prepareGitCommitReview();
    });

    expect(apiMock.prepareGitCommit).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "status-staged",
      review.message,
    );
    expect(apiMock.commitGitChanges).not.toHaveBeenCalled();
    apiMock.getGitChanges.mockResolvedValue(snapshot);
    await act(async () => {
      await refreshGitChanges();
    });
    expect(getState().gitCenter.caches["checkout-a"].commitReviewOpen).toBe(true);

    await act(async () => {
      await confirmGitCommit();
    });
    expect(apiMock.commitGitChanges).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "commit-token",
      review.message,
    );
    expect(getState().gitCenter.caches["checkout-a"].commitDraft).toBe("");
  });

  it("cancels an in-flight review when the user edits the draft", async () => {
    const stagedEntry = {
      ...entry,
      indexStatus: "M",
      worktreeStatus: null,
      staged: true,
      unstaged: false,
    };
    const target = context("checkout-a", "a");
    const snapshot = changes(target, "status-staged", [stagedEntry]);
    const lateReview = deferred<GitCommitReview>();
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(snapshot);
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.prepareGitCommit.mockReturnValue(lateReview.promise);
    await act(async () => {
      await openGitCenter(locator("a"));
    });
    act(() => setGitCommitDraft("first draft"));

    let preparing!: Promise<void>;
    await act(async () => {
      preparing = prepareGitCommitReview();
      await Promise.resolve();
    });
    expect(getState().gitCenter.caches["checkout-a"].commitPhase).toBe("refreshing");

    act(() => setGitCommitDraft("edited while reviewing"));
    expect(getState().gitCenter.caches["checkout-a"].commitPhase).toBe("ready");

    lateReview.resolve({
      context: target,
      commitToken: "late-token",
      message: "first draft",
      messageHash: "late-hash",
      beforeHead: target.headOid,
      indexHash: "late-index",
      expectedTreeOid: "late-tree",
      files: [],
      outsideProjectPaths: [],
      subjectOver72: false,
      warnings: [],
    });
    await act(async () => {
      await preparing;
    });
    const cache = getState().gitCenter.caches["checkout-a"];
    expect(cache.commitDraft).toBe("edited while reviewing");
    expect(cache.commitReview).toBeNull();
    expect(cache.commitReviewOpen).toBe(false);
  });
});
