import { describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./backend";
import type { RemoteClient } from "./client";

const snapshot = {
  repositoryRoot: "/remote/project", repoKey: "remote-repo",
  status: {
    checkout: { kind: "branch", value: "feature/ui" },
    paths: [{ path: "file.ts", staged: false, unstaged: true,
      untracked: false, unmerged: false, submoduleDirty: false }],
    staged: false, unstaged: true, untracked: false, unmerged: false,
    dirtySubmodule: false, operationState: null,
  },
  branches: [{ name: "feature/ui", oid: "b".repeat(40), current: true, occupiedWorktree: null }],
};
const switchOutcome = {
  operationId: "op", source: { kind: "branch", value: "main" },
  targetBranch: "feature/ui", stashed: true, restored: false, pendingRestore: true,
};
// Core BranchOperation uses id/projectId rather than operationId/status.
const journalOperation = {
  id: "op", kind: "switch", projectId: "p", repoKey: "remote-repo",
  checkoutRoot: "/remote/project", sourceBranch: "main", sourceCommit: "a".repeat(40),
  targetBranch: "feature/ui", targetOid: "b".repeat(40), phase: "restored_verified",
  stashOid: "c".repeat(40), stashSelector: "stash@{0}", stashMarker: "marker",
  snapshotJson: "{}", errorJson: null, createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z", completedAt: null,
};
const cases = [
  { method: "branch.switch", params: { projectId: "p", branch: "feature/ui" },
    wire: switchOutcome, run: (b: RemoteBackend) => b.switchLocalBranch("p", "feature/ui") },
  { method: "branch.create_switch", params: { projectId: "p", name: "feature/ui", startPoint: "main" },
    wire: switchOutcome, run: (b: RemoteBackend) => b.createAndSwitchLocalBranch("p", "feature/ui", "main") },
  { method: "branch.create", params: { projectId: "p", name: "feature/ui", startPoint: null },
    wire: { operationId: "op", branch: { name: "feature/ui", oid: "b".repeat(40), current: false, occupiedWorktree: null } },
    run: (b: RemoteBackend) => b.createLocalBranch("p", "feature/ui", null) },
  { method: "branch.delete", params: { projectId: "p", branch: "feature/ui", force: true },
    wire: { operationId: "op", branchName: "feature/ui", deletedOid: "b".repeat(40) },
    run: (b: RemoteBackend) => b.deleteLocalBranch("p", "feature/ui", true) },
  { method: "branch.autostash.restore", params: { operationId: "op", strategy: "source" },
    wire: journalOperation, run: (b: RemoteBackend) => b.restoreAutoStash("op", "source") },
  { method: "branch.autostash.cleanup", params: { operationId: "op" },
    wire: { ...journalOperation, phase: "completed", completedAt: "2026-10-20T00:00:00Z" },
    run: (b: RemoteBackend) => b.cleanupAutoStash("op") },
];

function setup(method: string, wire: unknown) {
  const request = vi.fn(async (name: string) => {
    if (name === method) return wire;
    if (name === "branch.status") return snapshot;
    if (name === "git.context.resolve") return { liveSessionIds: ["live-session"] };
    if (name === "branch.autostash.list") return [{
      operationId: "op", phase: "switched", selector: "stash@{0}", oid: "c".repeat(40),
      marker: "marker", sourceBranch: "main", sourceCommit: "a".repeat(40),
      targetBranch: "feature/ui", createdAt: "2026-10-20T00:00:00Z",
    }];
    throw new Error(`Unexpected ${name}`);
  });
  const backend = new RemoteBackend({ request, addEventListener: () => () => undefined } as unknown as RemoteClient);
  return { request, backend };
}

describe("remote branch mutation result adaptation", () => {
  it.each(cases)("hydrates $method from its Core outcome without repeating the mutation", async ({ method, params, wire, run }) => {
    const { request, backend } = setup(method, wire);
    const result = await run(backend);
    expect(result).toMatchObject({
      operationId: "op", status: {
        projectId: "p", isGitRepository: true, checkoutRoot: "/remote/project",
        head: { kind: "branch", branch: "feature/ui", oid: "b".repeat(40) },
        changes: { unstaged: 1 }, liveSessionIds: ["live-session"], pendingAutoStashes: 1,
      },
    });
    expect(result.status.snapshotToken).toBeTruthy();
    expect(request.mock.calls[0]).toEqual([method, params]);
    expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("branch.status", { projectId: "p" });
  });

  it("preserves mutation errors without fetching status or retrying", async () => {
    const { request, backend } = setup("branch.switch", switchOutcome);
    const error = { code: "blocked", message: "ignored files would be overwritten" };
    request.mockRejectedValueOnce(error);
    await expect(backend.switchLocalBranch("p", "feature/ui")).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry a successful mutation when the subsequent status read fails", async () => {
    const { request, backend } = setup("branch.switch", switchOutcome);
    const error = new Error("status read disconnected");
    request.mockResolvedValueOnce(switchOutcome).mockRejectedValueOnce(error);
    await expect(backend.switchLocalBranch("p", "feature/ui")).rejects.toBe(error);
    expect(request.mock.calls.map(([name]) => name)).toEqual(["branch.switch", "branch.status"]);
  });
});
