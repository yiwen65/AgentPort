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
  isStructuredGitError,
  onAutoStashChanged,
  onRepositoryOperationProgress,
  onRepositoryStateChanged,
} from "./api";

describe("local branch Tauri contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({});
    listenMock.mockResolvedValue(() => undefined);
  });

  it("uses the Rust command argument names exactly", async () => {
    await api.createLocalBranch("p1", "feature/new", "main");
    await api.switchLocalBranch("p1", "feature/new");
    await api.restoreAutoStash("op-1", "target");
    await api.cleanupAutoStash("op-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "create_local_branch", {
      projectId: "p1",
      name: "feature/new",
      startPoint: "main",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "switch_local_branch", {
      projectId: "p1",
      branch: "feature/new",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "restore_auto_stash", {
      operationId: "op-1",
      strategy: "target",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "cleanup_auto_stash", {
      operationId: "op-1",
    });
  });

  it("passes the three backend event payloads through without reshaping", async () => {
    const repository = vi.fn();
    const stash = vi.fn();
    const progress = vi.fn();
    await onRepositoryStateChanged(repository);
    await onAutoStashChanged(stash);
    await onRepositoryOperationProgress(progress);

    const repositoryPayload = { projectId: "p1", isGitRepository: false };
    const stashPayload = { id: "op-1", operationId: "op-1", projectId: "p1" };
    const progressPayload = {
      operationId: "tauri-1",
      command: "switch_local_branch",
      projectId: "p1",
      branch: "main",
      phase: "started",
      message: "switching local branch",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:00.000Z",
    };

    const callbackFor = (eventName: string) =>
      listenMock.mock.calls.find(([name]) => name === eventName)?.[1] as
        | ((event: { payload: unknown }) => void)
        | undefined;
    callbackFor("repository-state-changed")?.({ payload: repositoryPayload });
    callbackFor("auto-stash-changed")?.({ payload: stashPayload });
    callbackFor("repo-operation-progress")?.({ payload: progressPayload });

    expect(repository).toHaveBeenCalledWith(repositoryPayload);
    expect(stash).toHaveBeenCalledWith(stashPayload);
    expect(progress).toHaveBeenCalledWith(progressPayload);
  });

  it("recognizes structured Git errors by code and preserves recovery context", () => {
    expect(isStructuredGitError({
      code: "blocked",
      message: "checkout busy",
      phase: "switch",
      operationId: "tauri-1",
      recoverable: true,
      currentStatus: { projectId: "p1", isGitRepository: true },
      recoveryActions: ["open_session"],
      diagnostics: { command: "switch_local_branch" },
      liveSessionIds: ["s1"],
    })).toBe(true);
    expect(isStructuredGitError({ message: "checkout busy" })).toBe(false);
  });
});
