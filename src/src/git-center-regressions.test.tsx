// @vitest-environment jsdom
// Regression tests for Git Center review fixes:
// - T-006 "Stage all" must not stage conflicted entries
// - T-010 a dropped request must not latch changesPhase = "refreshing"
// - T-019 a successful remote action refreshes History
// - T-001 Push/Force Push copy names the real `<remote>/<branch>` destination
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

import GitChangesPanel from "./components/GitChangesPanel";
import {
  mutateAllGitChanges,
  openGitCenter,
  resetGitCenterStateForTests,
  runGitRemoteAction,
} from "./gitCenter";
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

function context(
  id: string,
  projectId = "project-1",
  overrides: Partial<GitCheckoutDescriptor> = {},
): GitCheckoutDescriptor {
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
    ...overrides,
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

const conflictEntry: GitChangeEntry = {
  ...entry,
  entryToken: "conflict-1",
  pathToken: "conflict-path-1",
  displayPath: "src/conflict.ts",
  indexStatus: "U",
  worktreeStatus: "U",
  conflictCode: "UU",
  kind: "conflict",
  conflicted: true,
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

function checkoutCache(
  target: GitCheckoutDescriptor,
  overrides: Partial<GitCheckoutUiState> = {},
): GitCheckoutUiState {
  return {
    context: target,
    changes: changes(target),
    changesPhase: "ready",
    changesError: null,
    selectedEntries: {},
    diffSelection: null,
    diff: null,
    diffPhase: "idle",
    diffError: null,
    history: history(target),
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

describe("Git Center review regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitCenterStateForTests();
    setState({ activeSessionId: "session-original", confirm: null });
  });

  afterEach(() => {
    cleanup();
    resetGitCenterStateForTests();
  });

  it("keeps conflicted entries out of the Stage all batch", async () => {
    const target = context("checkout-a", "a");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(
      changes(target, "status-1", [entry, conflictEntry]),
    );
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.stageGitPaths.mockResolvedValue({
      operationId: "stage-all",
      changes: changes(target, "status-2", [conflictEntry]),
    });
    await act(async () => {
      await openGitCenter(locator("a"));
    });

    await act(async () => {
      await mutateAllGitChanges("unstaged");
    });

    expect(apiMock.stageGitPaths).toHaveBeenCalledTimes(1);
    const [calledLocator, calledCheckout, calledStatus, selections] =
      apiMock.stageGitPaths.mock.calls[0];
    expect(calledLocator).toEqual(locator("a"));
    expect(calledCheckout).toBe("checkout-a");
    expect(calledStatus).toBe("status-1");
    expect(selections).toEqual([
      { pathToken: entry.pathToken, entryToken: entry.entryToken },
    ]);
    expect(
      (selections as Array<{ entryToken: string }>).some(
        (selection) => selection.entryToken === conflictEntry.entryToken,
      ),
    ).toBe(false);
  });

  it("hides Stage all when only conflicted entries remain", () => {
    const target = context("checkout-a", "a");
    setState({
      gitCenter: {
        ...emptyGitCenterState(),
        open: true,
        locator: locator("a"),
        activeCheckoutId: target.checkoutId,
        resolvePhase: "ready",
        caches: {
          [target.checkoutId]: checkoutCache(target, {
            changes: changes(target, "status-1", [conflictEntry]),
          }),
        },
      },
    });

    render(<GitChangesPanel />);

    expect(screen.queryByRole("button", { name: "全部暂存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全部取消暂存" })).toBeNull();
    // The per-file conflict action stays available.
    expect(
      screen.getByRole("button", { name: "标记为已解决并暂存" }),
    ).toBeTruthy();
  });

  it("does not inherit a transient changesPhase when a cached checkout is reopened", async () => {
    const target = context("checkout-a", "a");
    let held: ReturnType<typeof deferred<GitChangesSnapshot>> | null = null;
    let calls = 0;
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        held = deferred<GitChangesSnapshot>();
        return held.promise;
      }
      return Promise.resolve(changes(target, `status-${calls}`));
    });
    apiMock.getGitHistory.mockResolvedValue(history(target));

    await act(async () => {
      await openGitCenter(locator("a"));
    });
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");

    // A refresh stays in flight, as when the user navigates away mid-refresh.
    let superseded!: Promise<void>;
    await act(async () => {
      superseded = openGitCenter(locator("a"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe(
        "refreshing",
      )
    );

    await act(async () => {
      await openGitCenter(locator("a"));
    });
    expect(calls).toBe(3);
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");

    await act(async () => {
      held!.resolve(changes(target, "status-late"));
      await superseded;
    });
    expect(getState().gitCenter.caches["checkout-a"].changes?.statusToken).toBe(
      "status-3",
    );
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");
  });

  it("restores changesPhase when a dropped refresh lost its target", async () => {
    const targetA = context("checkout-a", "a");
    const targetB = context("checkout-b", "b");
    let heldA: ReturnType<typeof deferred<GitChangesSnapshot>> | null = null;
    let holdNextA = false;
    let aCalls = 0;
    apiMock.resolveGitContext.mockImplementation(
      async (target: GitContextLocator) =>
        target.kind === "projectMain" && target.projectId === "b"
          ? targetB
          : targetA,
    );
    apiMock.getGitChanges.mockImplementation((target: GitContextLocator) => {
      if (target.kind === "projectMain" && target.projectId === "b") {
        return Promise.resolve(changes(targetB, "status-b"));
      }
      aCalls += 1;
      if (holdNextA) {
        holdNextA = false;
        heldA = deferred<GitChangesSnapshot>();
        return heldA.promise;
      }
      return Promise.resolve(changes(targetA, `status-${aCalls}`));
    });
    apiMock.getGitHistory.mockImplementation(
      async (target: GitContextLocator) =>
        target.kind === "projectMain" && target.projectId === "b"
          ? history(targetB)
          : history(targetA),
    );

    await act(async () => {
      await openGitCenter(locator("a"));
    });
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");

    holdNextA = true;
    let reopenedA!: Promise<void>;
    await act(async () => {
      reopenedA = openGitCenter(locator("a"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe(
        "refreshing",
      )
    );

    await act(async () => {
      await openGitCenter(locator("b"));
    });
    expect(getState().gitCenter.activeCheckoutId).toBe("checkout-b");

    await act(async () => {
      heldA!.resolve(changes(targetA, "status-late"));
      await reopenedA;
    });
    // The dropped request gave the phase back instead of latching it.
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");
    expect(getState().gitCenter.caches["checkout-a"].changes?.statusToken).toBe(
      "status-1",
    );

    await act(async () => {
      await openGitCenter(locator("a"));
    });
    expect(aCalls).toBe(3);
    expect(getState().gitCenter.caches["checkout-a"].changesPhase).toBe("ready");
    expect(getState().gitCenter.caches["checkout-a"].changes?.statusToken).toBe(
      "status-3",
    );
  });

  it("refreshes History after a successful remote Push", async () => {
    const target = context("checkout-a", "a");
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(changes(target, "status-1"));
    apiMock.getGitHistory.mockResolvedValue(history(target));
    apiMock.syncGitRemote.mockResolvedValue({
      operationId: "remote-op",
      changes: changes(target, "status-1"),
    });
    await act(async () => {
      await openGitCenter(locator("a"));
    });
    expect(apiMock.getGitHistory).toHaveBeenCalledTimes(1);

    let pushing!: Promise<void>;
    act(() => {
      pushing = runGitRemoteAction("push");
    });
    expect(getState().confirm?.title).toBe("Push 当前分支？");
    await act(async () => {
      resolveConfirm(true);
      await pushing;
    });

    expect(apiMock.syncGitRemote).toHaveBeenCalledWith(
      locator("a"),
      "checkout-a",
      "status-1",
      "push",
    );
    expect(apiMock.getGitHistory).toHaveBeenCalledTimes(2);
    expect(apiMock.getGitHistory).toHaveBeenLastCalledWith(
      locator("a"),
      null,
      50,
    );
  });

  it("names <remote>/<branch> as the Push and Force Push destination", async () => {
    const target = context("checkout-a", "a", {
      actualBranch: "feature/login",
      upstream: "origin/legacy",
      remote: "origin",
      ahead: 1,
    });
    apiMock.resolveGitContext.mockResolvedValue(target);
    apiMock.getGitChanges.mockResolvedValue(changes(target, "status-1"));
    apiMock.getGitHistory.mockResolvedValue(history(target));
    await act(async () => {
      await openGitCenter(locator("a"));
    });

    let pushing!: Promise<void>;
    act(() => {
      pushing = runGitRemoteAction("push");
    });
    expect(getState().confirm?.body).toBe(
      "将 feature/login 推送到 origin/feature/login。",
    );
    await act(async () => {
      resolveConfirm(false);
      await pushing;
    });

    let forcing!: Promise<void>;
    act(() => {
      forcing = runGitRemoteAction("force_push");
    });
    expect(getState().confirm?.body).toBe(
      "将使用 --force-with-lease 改写 origin/feature/login。远端已变化时 Git 会拒绝操作。",
    );
    expect(getState().confirm?.danger).toBe(true);
    await act(async () => {
      resolveConfirm(false);
      await forcing;
    });

    expect(apiMock.syncGitRemote).not.toHaveBeenCalled();
  });
});
