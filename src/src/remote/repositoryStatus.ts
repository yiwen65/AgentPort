// branch.status is serialized directly from Core's BranchSnapshot, not the
// desktop Tauri LocalBranchesResponse. Keep this boundary explicit: passing
// snapshot.status straight to the store loses projectId/isGitRepository/head
// and silently disables the Git Center entry point.
import type { RepositoryStatus } from "../types";

export interface RemoteBranchSnapshot {
  repositoryRoot: string;
  repoKey: string;
  status: {
    checkout:
      | { kind: "branch"; value: string }
      | { kind: "detached"; value: string }
      | { kind: "unborn"; value: string | null };
    paths: Array<{
      path: string;
      staged: boolean;
      unstaged: boolean;
      untracked: boolean;
      unmerged: boolean;
      submoduleDirty: boolean;
    }>;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    unmerged: boolean;
    dirtySubmodule: boolean;
    operationState: string | null;
  };
  branches: Array<{
    name: string;
    oid: string;
    current: boolean;
    occupiedWorktree: string | null;
  }>;
}

export function remoteBranchSnapshotToRepositoryStatus(
  projectId: string,
  snapshot: RemoteBranchSnapshot,
  liveSessionIds: string[],
  pendingAutoStashes: number,
): RepositoryStatus {
  const { status } = snapshot;
  const checkout = status.checkout;
  const oid = checkout.kind === "detached"
    ? checkout.value
    : checkout.kind === "branch"
      ? snapshot.branches.find((branch) => branch.current)?.oid ?? null
      : null;
  // Match the desktop adapter's aggregate-flag fallback when a status has no
  // individual paths (e.g. a repository-level submodule dirty indication).
  const count = (
    field: "staged" | "unstaged" | "untracked" | "unmerged" | "submoduleDirty",
    present: boolean,
  ) => present ? Math.max(1, status.paths.filter((path) => path[field]).length) : 0;
  return {
    projectId,
    isGitRepository: true,
    checkoutRoot: snapshot.repositoryRoot,
    repoKey: snapshot.repoKey,
    head: {
      kind: checkout.kind,
      branch: checkout.kind === "detached" ? null : checkout.value,
      oid,
      shortOid: oid?.slice(0, 12) ?? null,
    },
    changes: {
      staged: count("staged", status.staged),
      unstaged: count("unstaged", status.unstaged),
      untracked: count("untracked", status.untracked),
      unmerged: count("unmerged", status.unmerged),
      dirtySubmodules: count("submoduleDirty", status.dirtySubmodule),
    },
    ongoingOperation: status.operationState,
    liveSessionIds,
    pendingAutoStashes,
    observedAt: new Date().toISOString(),
    // This UI token only detects snapshot changes (never sent as a mutation
    // precondition). Git writes use the server-issued checkout/status tokens.
    snapshotToken: JSON.stringify(snapshot),
  };
}
