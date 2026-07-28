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
    await api.resolveGitFile(locator, "checkout-1", "status-token", {
      pathToken: "opaque-path",
      entryToken: "opaque-entry",
    });
    await api.getGitDiff(locator, "status-token", "unstaged", "opaque-path");
    await api.getGitHistory(locator, "opaque-cursor", 50);
    await api.getGitCommitDetail(locator, "a".repeat(40));
    await api.getGitCommitDiff(
      locator,
      "a".repeat(40),
      "b".repeat(40),
      "opaque-path",
    );
    await api.generateGitCommitMessage(
      locator,
      "checkout-1",
      "status-token",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "resolve_git_context", {
      locator,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_git_changes", {
      locator,
      includeIgnored: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "resolve_git_file", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-token",
      selection: {
        pathToken: "opaque-path",
        entryToken: "opaque-entry",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "get_git_diff", {
      locator,
      expectedStatusToken: "status-token",
      side: "unstaged",
      pathToken: "opaque-path",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "get_git_history", {
      locator,
      cursor: "opaque-cursor",
      limit: 50,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "get_git_commit_detail", {
      locator,
      commitOid: "a".repeat(40),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(7, "get_git_commit_diff", {
      locator,
      commitOid: "a".repeat(40),
      parentOid: "b".repeat(40),
      pathToken: "opaque-path",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(8, "generate_git_commit_message", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-token",
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
    await api.discardGitPaths(locator, "checkout-1", "status-3", selections);
    await api.addGitIgnore(
      locator,
      "checkout-1",
      "status-4",
      selections[0],
      "repository",
    );
    await api.trashGitPath(locator, "checkout-1", "status-5", selections[0]);
    await api.syncGitRemote(locator, "checkout-1", "status-6", "push");
    await api.prepareGitCommit(
      locator,
      "checkout-1",
      "status-7",
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
    expect(invokeMock).toHaveBeenNthCalledWith(3, "discard_git_paths", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-3",
      selections,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "add_git_ignore", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-4",
      selection: selections[0],
      target: "repository",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "trash_git_path", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-5",
      selection: selections[0],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "sync_git_remote", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-6",
      action: "push",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(7, "prepare_git_commit", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedStatusToken: "status-7",
      message: "subject\n\nbody",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(8, "commit_git_changes", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedCommitToken: "commit-token",
      message: "subject\n\nbody",
    });
  });

  it("binds Worktree branch adoption to the exact observed checkout and branches", async () => {
    await api.adoptCurrentGitWorktreeBranch(
      locator,
      "checkout-1",
      "agent/original",
      "fix/current",
    );

    expect(invokeMock).toHaveBeenCalledWith("adopt_git_worktree_branch", {
      locator,
      expectedCheckoutId: "checkout-1",
      expectedBranch: "agent/original",
      actualBranch: "fix/current",
    });
  });

  it("keeps Commit AI configuration behind dedicated native commands", async () => {
    await api.getCommitAiConfig();
    await api.saveCommitAiConfig(
      "anthropic",
      "https://provider.example/v1",
      "claude-compatible",
      "secret-api-key",
    );
    await api.clearCommitAiApiKey();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_commit_ai_config");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "save_commit_ai_config", {
      provider: "anthropic",
      baseUrl: "https://provider.example/v1",
      model: "claude-compatible",
      apiKey: "secret-api-key",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "clear_commit_ai_api_key");
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
