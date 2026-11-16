import type { RemoteClient } from "../../protocol/remoteClient";
import type {
  BranchSnapshot, GitChangeEntry, GitChangesSnapshot, GitCheckoutDescriptor,
  GitCommitResult, GitCommitReview, GitContextLocator, GitDiffSide, GitFileDiff,
  GitMutationResult, GitPathSelection, RepoStatus, SwitchOutcome,
} from "./types";

export function sessionLocator(sessionId: string): GitContextLocator {
  return { kind: "session", sessionId };
}

export function branchNameOf(status: RepoStatus | undefined): string | undefined {
  if (!status) return undefined;
  const checkout = status.checkout;
  if ("branch" in checkout) return checkout.branch;
  if ("unborn" in checkout) return checkout.unborn ?? undefined;
  return undefined;
}

export function resolveGitContext(client: RemoteClient, hostId: string, sessionId: string) {
  return client.request<GitCheckoutDescriptor>(hostId, "git.context.resolve", { locator: sessionLocator(sessionId) });
}

export function readGitChanges(client: RemoteClient, hostId: string, locator: GitContextLocator, includeIgnored = false) {
  return client.request<GitChangesSnapshot>(hostId, "git.changes", { locator, includeIgnored });
}

export function readGitDiff(
  client: RemoteClient,
  hostId: string,
  locator: GitContextLocator,
  changes: GitChangesSnapshot,
  entry: GitChangeEntry,
  side: GitDiffSide,
) {
  return client.request<GitFileDiff>(hostId, "git.diff", {
    locator,
    expectedStatusToken: changes.statusToken,
    side,
    pathToken: entry.pathToken,
    includeIgnored: false,
  });
}

export function mutateGitPaths(
  client: RemoteClient,
  hostId: string,
  method: "git.stage" | "git.unstage" | "git.discard",
  changes: GitChangesSnapshot,
  entries: readonly GitChangeEntry[],
) {
  const selections: GitPathSelection[] = entries.map(entry => ({ pathToken: entry.pathToken, entryToken: entry.entryToken }));
  return client.request<GitMutationResult>(hostId, method, {
    locator: locatorOf(changes),
    expectedCheckoutId: changes.context.checkoutId,
    expectedStatusToken: changes.statusToken,
    selections,
    includeIgnored: false,
  });
}

export function listGitBranches(client: RemoteClient, hostId: string, projectId: string) {
  return client.request<BranchSnapshot>(hostId, "branch.list", { projectId });
}

export function switchGitBranch(client: RemoteClient, hostId: string, projectId: string, branch: string) {
  return client.request<SwitchOutcome>(hostId, "branch.switch", { projectId, branch });
}

export function createAndSwitchGitBranch(client: RemoteClient, hostId: string, projectId: string, name: string) {
  return client.request<SwitchOutcome>(hostId, "branch.create_switch", { projectId, name, startPoint: null });
}

export function prepareGitCommit(
  client: RemoteClient,
  hostId: string,
  locator: GitContextLocator,
  changes: GitChangesSnapshot,
  message: string,
) {
  return client.request<GitCommitReview>(hostId, "git.commit.prepare", {
    locator,
    expectedCheckoutId: changes.context.checkoutId,
    expectedStatusToken: changes.statusToken,
    message,
    includeIgnored: false,
  });
}

export function executeGitCommit(
  client: RemoteClient,
  hostId: string,
  locator: GitContextLocator,
  review: GitCommitReview,
) {
  return client.request<GitCommitResult>(hostId, "git.commit.execute", {
    locator,
    expectedCheckoutId: review.context.checkoutId,
    expectedCommitToken: review.commitToken,
    message: review.message,
    includeIgnored: false,
  });
}

function locatorOf(changes: Pick<GitChangesSnapshot, "context">): GitContextLocator {
  const target = changes.context.target;
  if (target.kind === "worktree" && target.worktreeId) {
    return { kind: "worktree", projectId: target.projectId, worktreeId: target.worktreeId };
  }
  return { kind: "projectMain", projectId: target.projectId };
}
