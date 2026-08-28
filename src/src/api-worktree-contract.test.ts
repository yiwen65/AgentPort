import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { api } from "./api";

describe("Worktree branch selection Tauri contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({});
  });

  it("sends explicit existing branch mode and the selected OID", async () => {
    await api.createWorktree(
      "project-1",
      "reuse branch",
      null,
      "feature/local",
      "existing",
      "a".repeat(40),
    );

    expect(invokeMock).toHaveBeenCalledWith("create_worktree", {
      projectId: "project-1",
      task: "reuse branch",
      baseRef: null,
      branch: "feature/local",
      branchMode: "existing",
      expectedBranchOid: "a".repeat(40),
    });
  });

  it("keeps new and auto modes distinct", async () => {
    await api.createWorktree("project-1", "new branch", "main", "feature/new", "new", null);
    await api.createWorktree("project-1", "auto branch", null, null, "auto", null);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "create_worktree", {
      projectId: "project-1",
      task: "new branch",
      baseRef: "main",
      branch: "feature/new",
      branchMode: "new",
      expectedBranchOid: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "create_worktree", {
      projectId: "project-1",
      task: "auto branch",
      baseRef: null,
      branch: null,
      branchMode: "auto",
      expectedBranchOid: null,
    });
  });

  it("uses backend preflight and preview commands for destructive and generated state", async () => {
    await api.previewWorktree("project-1", "修复 登录超时");
    await api.reconcileWorktrees("project-1");
    await api.worktreeDeletePreflight("wt-1");
    await api.projectRemovePreflight("project-1");
    await api.deleteProjectArchivedSessions("project-1", [
      { id: "session-1", archiveGeneration: 101 },
    ]);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "preview_worktree", {
      projectId: "project-1",
      task: "修复 登录超时",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "reconcile_worktrees", {
      projectId: "project-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "worktree_delete_preflight", {
      worktreeId: "wt-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "project_remove_preflight", {
      id: "project-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "delete_project_archived_sessions", {
      projectId: "project-1",
      sessions: [{ id: "session-1", archiveGeneration: 101 }],
    });
  });
});
