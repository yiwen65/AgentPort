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

export type CheckoutState =
  | { branch: string }
  | { detached: string }
  | { unborn: string | null };

export interface StatusPath {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  unmerged: boolean;
  submoduleDirty: boolean;
}

export interface RepoStatus {
  checkout: CheckoutState;
  paths: StatusPath[];
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  unmerged: boolean;
  dirtySubmodule: boolean;
  operationState: string | null;
}

export interface BranchInfo {
  name: string;
  oid: string;
  current: boolean;
  occupiedWorktree: string | null;
}

export interface BranchSnapshot {
  repositoryRoot: string;
  repoKey: string;
  status: RepoStatus;
  branches: BranchInfo[];
}

export type GitChangeKind =
  | "added" | "modified" | "deleted" | "renamed" | "copied"
  | "type_changed" | "conflict" | "untracked" | "ignored";

export interface GitChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  ignored: number;
  conflict: number;
  renamed: number;
  submodule: number;
}

export interface GitChangeEntry {
  entryToken: string;
  pathToken: string;
  displayPath: string;
  oldPathToken: string | null;
  displayOldPath: string | null;
  indexStatus: string | null;
  worktreeStatus: string | null;
  conflictCode: string | null;
  kind: GitChangeKind;
  submoduleState: string | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

export interface GitChangesSnapshot {
  context: GitCheckoutDescriptor;
  statusToken: string;
  complete: boolean;
  partialReason: string | null;
  counts: GitChangeCounts;
  entries: GitChangeEntry[];
  observedAt: string;
}

export type GitDiffSide = "staged" | "unstaged";
export type GitDiffFormat = "text" | "binary" | "summary" | "conflict";

export interface GitFileDiff {
  context: GitCheckoutDescriptor;
  statusToken: string;
  side: GitDiffSide;
  pathToken: string;
  displayPath: string;
  format: GitDiffFormat;
  patch: string | null;
  additions: number | null;
  deletions: number | null;
  fileSize: number | null;
  truncated: boolean;
  reason: string | null;
  conflictCode: string | null;
}

export interface GitPathSelection {
  pathToken: string;
  entryToken: string;
}

export interface GitMutationResult {
  operationId: string;
  changes: GitChangesSnapshot;
}

export interface SwitchOutcome {
  operationId: string;
  source: CheckoutState;
  targetBranch: string;
  stashed: boolean;
  restored: boolean;
  pendingRestore: boolean;
}

export type RestoreStrategy = "target" | "source";

export interface AutoStash {
  operationId: string;
  phase: string;
  selector: string;
  oid: string;
  marker: string;
  sourceBranch: string | null;
  sourceCommit: string;
  targetBranch: string;
  createdAt: string;
}

export interface BranchOperation {
  id: string;
  projectId: string;
  phase: string;
  sourceBranch: string | null;
  targetBranch: string;
}

export interface GitCommitScopeFile {
  status: string;
  pathToken: string;
  displayPath: string;
  oldPathToken: string | null;
  displayOldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  outsideProject: boolean;
}

export interface GitCommitReview {
  context: GitCheckoutDescriptor;
  commitToken: string;
  message: string;
  messageHash: string;
  beforeHead: string | null;
  indexHash: string;
  expectedTreeOid: string;
  files: GitCommitScopeFile[];
  outsideProjectPaths: string[];
  subjectOver72: boolean;
  warnings: string[];
}

export type GitCommitOutcome = "succeeded" | "not_executed" | "scope_drift" | "indeterminate";

export interface GitCommitResult {
  operationId: string;
  outcome: GitCommitOutcome;
  beforeHead: string | null;
  afterHead: string | null;
  expectedTreeOid: string;
  actualTreeOid: string | null;
  changes: GitChangesSnapshot;
  error: string | null;
}
