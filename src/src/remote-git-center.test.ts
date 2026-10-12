// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
// This test exercises routing/store/commit flow, not a mounted xterm renderer.
vi.mock("./terminals", () => ({}));
import { api } from "./api";
import { openGitCenter, prepareGitCommitReview, setGitCommitDraft, confirmGitCommit, resetGitCenterStateForTests } from "./gitCenter";
import { RemoteBackend } from "./remote/backend";
import type { RemoteClient } from "./remote/client";
import { setRemoteBackendFactoryForTests } from "./remote/runtime";
import { applyRepositoryStatusSnapshot, emptyGitCenterState, getState, setActiveDevice, setState } from "./store";
import type { GitCheckoutDescriptor, GitChangesSnapshot } from "./types";

const context: GitCheckoutDescriptor = {
  target: { kind: "main", projectId: "p", worktreeId: null }, checkoutId: "remote-checkout",
  repoKey: "remote-repo", projectName: "Remote project", projectRoot: "/remote/p", checkoutRoot: "/remote/p",
  expectedBranch: null, actualBranch: "main", headOid: "a".repeat(40), detached: false, unborn: false,
  ongoingOperation: null, hasRemote: false, remote: null, remoteUrl: null, upstream: null,
  ahead: 0, behind: 0, worktreeHealth: null, liveSessionIds: [], writable: true, blockers: [], warnings: [],
};
const changes: GitChangesSnapshot = {
  context, statusToken: "server-status", complete: true, partialReason: null,
  counts: { staged: 1, unstaged: 0, untracked: 0, conflict: 0, renamed: 0, submodule: 0, ignored: 0 },
  entries: [], observedAt: "2026-10-12T00:00:00Z",
};

afterEach(() => {
  setActiveDevice({ kind: "local" });
  setRemoteBackendFactoryForTests(null);
  resetGitCenterStateForTests();
});

it("routes remote repository status → Git Center → commit review/execute with server preconditions", async () => {
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case "branch.status": return {
        repositoryRoot: context.checkoutRoot, repoKey: context.repoKey,
        status: { checkout: { kind: "branch", value: "main" }, paths: [],
          staged: true, unstaged: false, untracked: false, unmerged: false,
          dirtySubmodule: false, operationState: null },
        branches: [{ name: "main", oid: context.headOid, current: true, occupiedWorktree: null }],
      };
      case "branch.autostash.list": return [];
      case "git.context.resolve": return context;
      case "git.changes": return changes;
      case "git.history": return { commits: [], nextCursor: null, complete: true };
      case "git.commit.prepare": return {
        context, commitToken: "server-commit", message: "remote commit", messageHash: "hash",
        beforeHead: context.headOid, indexHash: "index", expectedTreeOid: "tree", files: [],
        outsideProjectPaths: [], subjectOver72: false, warnings: [],
      };
      case "git.commit.execute": return {
        operationId: "op", outcome: "succeeded", beforeHead: context.headOid,
        afterHead: "b".repeat(40), expectedTreeOid: "tree", actualTreeOid: "tree", changes, error: null,
      };
      default: throw new Error(`Unexpected method: ${method}`);
    }
  });
  const backend = new RemoteBackend({ request, addEventListener: () => () => undefined } as unknown as RemoteClient);
  setRemoteBackendFactoryForTests(() => backend);
  setActiveDevice({ kind: "remote", deviceId: "device", deviceName: "Linux", capabilities: [] });
  setState({ repositoryStatuses: {}, gitCenter: emptyGitCenterState(), activeSessionId: null });
  applyRepositoryStatusSnapshot(await api.getRepositoryStatus("p"));
  expect(getState().repositoryStatuses.p.isGitRepository).toBe(true);
  const locator = { kind: "projectMain" as const, projectId: "p" };
  await openGitCenter(locator);
  expect(getState().gitCenter.resolvePhase).toBe("ready");
  expect(getState().gitCenter.caches[context.checkoutId].changesPhase).toBe("ready");
  setGitCommitDraft("remote commit");
  await prepareGitCommitReview();
  expect(getState().gitCenter.caches[context.checkoutId].commitReviewOpen).toBe(true);
  await confirmGitCommit();
  expect(request).toHaveBeenCalledWith("git.commit.execute", {
    locator, expectedCheckoutId: "remote-checkout", expectedCommitToken: "server-commit", message: "remote commit",
  });
  expect(getState().gitCenter.caches[context.checkoutId].lastCommitResult?.outcome).toBe("succeeded");
});
