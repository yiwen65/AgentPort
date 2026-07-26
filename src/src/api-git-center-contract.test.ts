import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  api,
  isGitWorkspaceCommandError,
  onGitStateInvalidated,
} from "./api";
import type { GitContextLocator } from "./types";

describe("Git Center Tauri contract", () => {
  const locator: GitContextLocator = {
    kind: "worktree",
    projectId: "project-1",
    worktreeId: "worktree-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({});
    listenMock.mockResolvedValue(() => undefined);
  });

  it("passes only persisted IDs, OIDs, and opaque tokens", async () => {
    await api.resolveGitContext(locator);
    await api.getGitChanges(locator, true);
    await api.getGitDiff(locator, "status-token", "unstaged", "opaque-path");
    await api.getGitHistory(locator, "opaque-cursor", 50);
    await api.getGitCommitDetail(locator, "a".repeat(40));
    await api.getGitCommitDiff(
      locator,
      "a".repeat(40),
      "b".repeat(40),
      "opaque-path",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "resolve_git_context", {
      locator,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_git_changes", {
      locator,
      includeIgnored: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "get_git_diff", {
      locator,
      expectedStatusToken: "status-token",
      side: "unstaged",
      pathToken: "opaque-path",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "get_git_history", {
      locator,
      cursor: "opaque-cursor",
      limit: 50,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "get_git_commit_detail", {
      locator,
      commitOid: "a".repeat(40),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "get_git_commit_diff", {
      locator,
      commitOid: "a".repeat(40),
      parentOid: "b".repeat(40),
      pathToken: "opaque-path",
    });
    for (const [, args] of invokeMock.mock.calls) {
      expect(JSON.stringify(args)).not.toContain("/Users/");
      expect(JSON.stringify(args)).not.toContain("checkoutRoot");
    }
  });

  it("binds every write to checkout and status or commit tokens", async () => {
    const selections = [{ pathToken: "path", entryToken: "entry" }];
    await api.stageGitPaths(locator, "checkout-1", "status-1", selections);
    await api.unstageGitPaths(locator, "checkout-1", "status-2", selections);
    await api.prepareGitCommit(
      locator,
      "checkout-1",
      "status-3",
      "subject\n\nbody",
    );
    await api.commitGitChanges(
      locator,
      "checkout-1",
      "commit-token",
      "subject\n\nbody",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "stage_git_paths", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-1",
      selections,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "unstage_git_paths", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-2",
      selections,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "prepare_git_commit", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-3",
      message: "subject\n\nbody",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "commit_git_changes", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedCommitToken: "commit-token",
      message: "subject\n\nbody",
    });
  });

  it("passes invalidation events through as signals and recognizes write errors", async () => {
    const callback = vi.fn();
    await onGitStateInvalidated(callback);
    const listener = listenMock.mock.calls.find(
      ([name]) => name === "git-state-invalidated",
    )?.[1] as (event: { payload: unknown }) => void;
    const payload = {
      repoKey: "repo",
      checkoutIds: ["checkout"],
      scopes: ["changes"],
      reason: "stage",
      operationId: "operation",
      observedAt: "2026-07-26T00:00:00.000Z",
    };
    listener({ payload });
    expect(callback).toHaveBeenCalledWith(payload);

    expect(isGitWorkspaceCommandError({
      code: "stale",
      message: "status changed",
      recoverable: true,
      currentChanges: null,
    })).toBe(true);
    expect(isGitWorkspaceCommandError({
      code: "stale",
      message: "status changed",
    })).toBe(false);
  });
});
