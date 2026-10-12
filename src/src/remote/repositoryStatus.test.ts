import { describe, expect, it } from "vitest";
import { remoteBranchSnapshotToRepositoryStatus, type RemoteBranchSnapshot } from "./repositoryStatus";

function snapshot(checkout: RemoteBranchSnapshot["status"]["checkout"]): RemoteBranchSnapshot {
  return {
    repositoryRoot: "/remote/project", repoKey: "repo",
    status: { checkout, paths: [], staged: false, unstaged: false,
      untracked: false, unmerged: false, dirtySubmodule: false, operationState: null },
    branches: [],
  };
}

describe("remote repository status boundary", () => {
  it("preserves detached HEAD rather than inventing a current branch", () => {
    const status = remoteBranchSnapshotToRepositoryStatus("p", snapshot({ kind: "detached", value: "b".repeat(40) }), [], 0);
    expect(status.head).toEqual({ kind: "detached", branch: null, oid: "b".repeat(40), shortOid: "b".repeat(12) });
  });

  it.each(["main", null])("preserves unborn HEAD (%s)", (branch) => {
    const status = remoteBranchSnapshotToRepositoryStatus("p", snapshot({ kind: "unborn", value: branch }), [], 0);
    expect(status.isGitRepository).toBe(true);
    expect(status.head).toEqual({ kind: "unborn", branch, oid: null, shortOid: null });
  });

  it("counts changed paths and retains aggregate dirty flags/ongoing operations", () => {
    const value = snapshot({ kind: "branch", value: "main" });
    value.status.paths = [1, 2].map((n) => ({ path: `${n}.ts`, staged: true,
      unstaged: false, untracked: false, unmerged: false, submoduleDirty: false }));
    value.status.staged = true;
    value.status.unmerged = true;
    value.status.dirtySubmodule = true;
    value.status.operationState = "merge";
    const status = remoteBranchSnapshotToRepositoryStatus("p", value, ["live"], 2);
    expect(status.changes).toEqual({ staged: 2, unstaged: 0, untracked: 0, unmerged: 1, dirtySubmodules: 1 });
    expect(status.ongoingOperation).toBe("merge");
    expect(status.liveSessionIds).toEqual(["live"]);
    expect(status.pendingAutoStashes).toBe(2);
    const unchanged = remoteBranchSnapshotToRepositoryStatus("p", value, [], 0);
    expect(unchanged.snapshotToken).toBe(status.snapshotToken);
    value.status.untracked = true;
    expect(remoteBranchSnapshotToRepositoryStatus("p", value, [], 0).snapshotToken).not.toBe(status.snapshotToken);
  });
});
