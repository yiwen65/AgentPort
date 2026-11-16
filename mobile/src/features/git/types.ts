export type GitContextLocator =
  | { kind: "session"; sessionId: string }
  | { kind: "projectMain"; projectId: string }
  | { kind: "worktree"; projectId: string; worktreeId: string };

export type GitCheckoutKind = "main" | "worktree";

export interface GitCheckoutTarget {
  projectId: string;
  kind: GitCheckoutKind;
  worktreeId: string | null;
}

export interface GitCheckoutDescriptor {
  target: GitCheckoutTarget;
  checkoutId: string;
  repoKey: string;
  projectName: string;
  projectRoot: string;
  checkoutRoot: string;
  expectedBranch: string | null;
  actualBranch: string | null;
  headOid: string | null;
  detached: boolean;
  unborn: boolean;
  ongoingOperation: string | null;
  hasRemote: boolean;
  remote: string | null;
  remoteUrl: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  worktreeHealth: string | null;
  liveSessionIds: string[];
  writable: boolean;
  blockers: string[];
  warnings: string[];
}

export interface WorktreeSummary {
  id: string;
  projectId: string;
  branch: string;
  baseCommit: string;
  path: string;
  health: string;
  createdAt: string;
}
