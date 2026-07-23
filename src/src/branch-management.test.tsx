// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listeners, listenerRegistration, listenerUnlistens, apiMock } = vi.hoisted(() => ({
  listeners: {
    progress: [] as Array<(event: any) => void>,
    repository: [] as Array<(status: any) => void>,
    stash: [] as Array<(stash: any) => void>,
  },
  listenerRegistration: {
    deferred: false,
    resolve: [] as Array<() => void>,
  },
  listenerUnlistens: [] as Array<ReturnType<typeof vi.fn>>,
  apiMock: {
    listLocalBranches: vi.fn(),
    switchLocalBranch: vi.fn(),
    createLocalBranch: vi.fn(),
    deleteLocalBranch: vi.fn(),
    listAutoStashes: vi.fn(),
    restoreAutoStash: vi.fn(),
    cleanupAutoStash: vi.fn(),
  },
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  const register = <T,>(items: T[], cb: T) => {
    items.push(cb);
    const unlisten = vi.fn();
    listenerUnlistens.push(unlisten);
    if (!listenerRegistration.deferred) return Promise.resolve(unlisten);
    return new Promise<() => void>((resolve) => {
      listenerRegistration.resolve.push(() => resolve(unlisten));
    });
  };
  return {
    ...actual,
    api: apiMock,
    onRepositoryOperationProgress: vi.fn((cb: (event: any) => void) => register(listeners.progress, cb)),
    onRepositoryStateChanged: vi.fn((cb: (status: any) => void) => register(listeners.repository, cb)),
    onAutoStashChanged: vi.fn((cb: (stash: any) => void) => register(listeners.stash, cb)),
  };
});

vi.mock("./actions", () => ({ selectSession: vi.fn() }));

import BranchPickerDialog from "./components/BranchPickerDialog";
import { isStructuredGitError } from "./api";
import { setState } from "./store";

const status = {
  projectId: "p1",
  isGitRepository: true,
  checkoutRoot: "/repo",
  repoKey: "repo",
  head: { kind: "branch", branch: "main", oid: "a".repeat(40), shortOid: "aaaaaaaaaaaa" },
  changes: { staged: 1, unstaged: 2, untracked: 1, unmerged: 1, dirtySubmodules: 0 },
  ongoingOperation: null,
  liveSessionIds: ["session-live"],
  pendingAutoStashes: 2,
  observedAt: new Date().toISOString(),
  snapshotToken: "1",
};

const branches = [
  { name: "main", oid: "a".repeat(40), current: true, checkedOutPath: null, agentPortWorktreeId: null },
  { name: "feature/ui", oid: "b".repeat(40), current: false, checkedOutPath: null, agentPortWorktreeId: null },
  { name: "feature/occupied", oid: "c".repeat(40), current: false, checkedOutPath: "/repo-worktree", agentPortWorktreeId: "w1" },
];

const safeDeleteStatus = {
  ...status,
  changes: { ...status.changes, unmerged: 0, dirtySubmodules: 0 },
};

function useSafeDeleteResponse() {
  apiMock.listLocalBranches.mockReset().mockResolvedValue({
    status: safeDeleteStatus,
    branches,
    autoStashes: [
      { id: "stash-pending", operationId: "op1", projectId: "p1", sourceKind: "branch", targetBranch: "feature/ui", marker: "m", createdAt: "2026-01-01", state: "pending" },
    ],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function projectState() {
  return {
    projects: [{ id: "p1", name: "Demo", rootPath: "/repo", gitRootPath: "/repo", sessions: [], worktrees: [] }],
  };
}

describe("local branch management", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.progress.length = 0;
    listeners.repository.length = 0;
    listeners.stash.length = 0;
    listenerRegistration.deferred = false;
    listenerRegistration.resolve.length = 0;
    listenerUnlistens.length = 0;
    setState(projectState());
    apiMock.listLocalBranches.mockResolvedValue({ status, branches, autoStashes: [
      { id: "stash-pending", operationId: "op1", projectId: "p1", sourceKind: "branch", targetBranch: "feature/ui", marker: "m", createdAt: "2026-01-01", state: "pending" },
      { id: "stash-restored", operationId: "op2", projectId: "p1", sourceKind: "branch", targetBranch: "main", marker: "m", createdAt: "2026-01-01", state: "restored_verified" },
    ] });
    apiMock.switchLocalBranch.mockResolvedValue({ operationId: "op", status });
    apiMock.createLocalBranch.mockResolvedValue({ operationId: "op", status });
    apiMock.deleteLocalBranch.mockResolvedValue({ operationId: "op-delete", status });
  });

  it("focuses search, filters with keyboard, and does not allow occupied worktrees", async () => {
    const user = userEvent.setup();
    render(<BranchPickerDialog projectId="p1" />);
    const search = await screen.findByRole("textbox", { name: "搜索本地分支" });
    expect(document.activeElement).toBe(search);
    await user.type(search, "ui");
    expect(screen.getAllByText("feature/ui").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("list", { name: "本地分支" })).queryByText("feature/occupied")).toBeNull();
    await user.clear(search);
    const occupied = screen.getByTitle("已在 /repo-worktree checkout");
    expect((occupied as HTMLButtonElement).disabled).toBe(true);
    expect(occupied.getAttribute("title")).toContain("/repo-worktree");
    await user.type(search, "feature/ui");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(apiMock.switchLocalBranch).toHaveBeenCalledWith("p1", "feature/ui"));
  });

  it("renders dirty/conflict and progress state, and gates cleanup until verified", async () => {
    render(<BranchPickerDialog projectId="p1" />);
    expect(await screen.findByText(/暂存 1 · 修改 2 · 未跟踪 1 · 冲突 1/)).toBeTruthy();
    expect(screen.getByText("待恢复记录：2")).toBeTruthy();
    const cleanupButtons = screen.getAllByRole("button", { name: "清理记录" });
    const pending = cleanupButtons[0];
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect((cleanupButtons[1] as HTMLButtonElement).disabled).toBe(false);
    act(() => listeners.progress[0]?.({
      projectId: "p1",
      operationId: "op",
      command: "switch_local_branch",
      branch: "feature/ui",
      phase: "started",
      message: "switching local branch",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:00.000Z",
    }));
    expect(await screen.findByText(/正在切换本地分支（已开始）/)).toBeTruthy();
  });

  it("updates a repository event without recursively refreshing the branch list", async () => {
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");
    expect(apiMock.listLocalBranches).toHaveBeenCalledTimes(1);

    act(() => listeners.repository[0]?.({
      ...status,
      head: { ...status.head, branch: "feature/ui" },
      snapshotToken: "event-2",
    }));

    expect(await screen.findByText("feature/ui", { selector: ".branch-picker-status strong" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除分支 feature/ui" })).toBeNull();
    expect(apiMock.listLocalBranches).toHaveBeenCalledTimes(1);
  });

  it("does not let an older refresh overwrite a newer repository event", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<ReturnType<typeof apiMock.listLocalBranches>>();
    apiMock.listLocalBranches
      .mockResolvedValueOnce({ status, branches, autoStashes: [] })
      .mockReturnValueOnce(staleRefresh.promise as never);
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");

    await user.click(screen.getByRole("button", { name: "刷新" }));
    act(() => listeners.repository[0]?.({
      ...status,
      head: { ...status.head, branch: "feature/ui" },
      snapshotToken: "event-newer-than-refresh",
    }));
    await act(async () => {
      staleRefresh.resolve({ status, branches, autoStashes: [] } as never);
      await staleRefresh.promise;
    });

    expect(screen.getByText("feature/ui", { selector: ".branch-picker-status strong" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除分支 feature/ui" })).toBeNull();
  });

  it("cancels an inline delete confirmation when backend state makes the branch current", async () => {
    const user = userEvent.setup();
    useSafeDeleteResponse();
    render(<BranchPickerDialog projectId="p1" />);
    const search = await screen.findByRole("textbox", { name: "搜索本地分支" });
    await user.click(screen.getByRole("button", { name: "删除分支 feature/ui" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();

    act(() => listeners.repository[0]?.({
      ...safeDeleteStatus,
      head: { ...safeDeleteStatus.head, branch: "feature/ui" },
      snapshotToken: "became-current",
    }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull());
    expect(screen.queryByRole("button", { name: "删除分支 feature/ui" })).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it("disables every repository mutation while a backend operation is in progress", async () => {
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");
    act(() => listeners.progress[0]?.({
      projectId: "p1",
      operationId: "external-op",
      command: "switch_local_branch",
      branch: "feature/ui",
      phase: "started",
      message: "switching",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:00.000Z",
    }));

    expect((screen.getByRole("button", { name: "feature/ui" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "新分支名称" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "恢复到目标分支" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole("button", { name: "清理记录" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    act(() => listeners.progress[0]?.({
      projectId: "p1",
      operationId: "queued-op",
      command: "create_local_branch",
      branch: "feature/queued",
      phase: "started",
      message: "queued",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:00.500Z",
    }));
    act(() => listeners.progress[0]?.({
      projectId: "p1",
      operationId: "external-op",
      command: "switch_local_branch",
      branch: "feature/ui",
      phase: "completed",
      message: "complete",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:01.000Z",
    }));
    expect((screen.getByRole("button", { name: "feature/ui" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => listeners.progress[0]?.({
      projectId: "p1",
      operationId: "queued-op",
      command: "create_local_branch",
      branch: "feature/queued",
      phase: "completed",
      message: "complete",
      coreOperationId: null,
      recoverable: false,
      occurredAt: "2026-07-22T00:00:02.000Z",
    }));
    expect((screen.getByRole("button", { name: "feature/ui" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses list semantics without interactive descendants inside listbox options", async () => {
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");
    expect(screen.queryByRole("listbox", { name: "本地分支" })).toBeNull();
    expect(screen.getByRole("list", { name: "本地分支" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "main，当前 checkout" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("confirms deletion inline, keeps current and occupied branches protected, and restores focus on cancel", async () => {
    const user = userEvent.setup();
    useSafeDeleteResponse();
    render(<BranchPickerDialog projectId="p1" />);
    const deleteButton = await screen.findByRole("button", { name: "删除分支 feature/ui" });

    expect(screen.queryByRole("button", { name: "删除分支 main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除分支 feature/occupied" })).toBeNull();
    // Pending recovery is resolved precisely by the backend instead of
    // globally disabling deletion of unrelated branches in the picker.
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(deleteButton);
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("删除 feature/ui？");
    expect(warning.textContent).toContain("仅删除已合并的本地分支，不影响远端");
    const confirm = screen.getByRole("button", { name: "确认删除" });
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByRole("group", { name: "确认删除分支 feature/ui" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "取消" }));
    const restoredDeleteButton = screen.getByRole("button", { name: "删除分支 feature/ui" });
    expect(document.activeElement).toBe(restoredDeleteButton);
    expect(apiMock.deleteLocalBranch).not.toHaveBeenCalled();
  });

  it("cancels inline confirmation with Escape without closing the dialog", async () => {
    const user = userEvent.setup();
    useSafeDeleteResponse();
    render(<BranchPickerDialog projectId="p1" />);
    await user.click(await screen.findByRole("button", { name: "删除分支 feature/ui" }));
    await user.keyboard("{Escape}");

    const deleteButton = screen.getByRole("button", { name: "删除分支 feature/ui" });
    expect(document.activeElement).toBe(deleteButton);
    expect(screen.getByRole("dialog", { name: "管理本地分支 · Demo" })).toBeTruthy();
  });

  it("cancels inline confirmation when search, refresh, or keyboard selection changes", async () => {
    const user = userEvent.setup();
    useSafeDeleteResponse();
    render(<BranchPickerDialog projectId="p1" />);
    const search = await screen.findByRole("textbox", { name: "搜索本地分支" });

    await user.click(screen.getByRole("button", { name: "删除分支 feature/ui" }));
    await user.click(search);
    await user.type(search, "u");
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "删除分支 feature/ui" }));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "删除分支 feature/ui" }));
    search.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  });

  it("deletes through the typed backend API, refreshes the list, and focuses search", async () => {
    const user = userEvent.setup();
    apiMock.listLocalBranches
      .mockReset()
      .mockResolvedValueOnce({ status: safeDeleteStatus, branches, autoStashes: [] })
      .mockResolvedValue({ status: { ...safeDeleteStatus, snapshotToken: "after-delete" }, branches: [branches[0], branches[2]], autoStashes: [] });
    render(<BranchPickerDialog projectId="p1" />);

    await user.click(await screen.findByRole("button", { name: "删除分支 feature/ui" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(apiMock.deleteLocalBranch).toHaveBeenCalledWith("p1", "feature/ui"));
    await waitFor(() => expect(screen.queryByText("feature/ui")).toBeNull());
    expect(await screen.findByText(/完成：已删除本地分支 feature\/ui/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索本地分支" }));
  });

  it("reports a successful delete separately when the authoritative refresh fails", async () => {
    const user = userEvent.setup();
    apiMock.listLocalBranches
      .mockReset()
      .mockResolvedValueOnce({ status: safeDeleteStatus, branches, autoStashes: [] })
      .mockRejectedValueOnce(new Error("repository probe offline"));
    render(<BranchPickerDialog projectId="p1" />);

    await user.click(await screen.findByRole("button", { name: "删除分支 feature/ui" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByText(/完成：已删除本地分支 feature\/ui/)).toBeTruthy();
    expect(screen.getByText(/仓库状态刷新失败；操作入口已禁用/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("repository probe offline");
    expect(screen.queryByText("已重新读取仓库状态")).toBeNull();
    expect((screen.getByRole("button", { name: "创建分支" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps inline confirmation and exposes structured backend deletion errors", async () => {
    const user = userEvent.setup();
    useSafeDeleteResponse();
    apiMock.deleteLocalBranch.mockRejectedValueOnce({
      code: "branch_not_merged",
      message: "分支尚未合并，未执行删除",
      phase: "delete",
      operationId: "delete-1",
      recoverable: true,
      currentStatus: status,
      recoveryActions: ["merge_or_choose_another_branch"],
      diagnostics: { branch: "feature/ui" },
      liveSessionIds: [],
    });
    render(<BranchPickerDialog projectId="p1" />);

    await user.click(await screen.findByRole("button", { name: "删除分支 feature/ui" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByText("分支尚未合并，未执行删除", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByText("merge_or_choose_another_branch")).toBeTruthy();
  });

  it("unregisters listeners even when registration resolves after unmount", async () => {
    listenerRegistration.deferred = true;
    const view = render(<BranchPickerDialog projectId="p1" />);
    view.unmount();
    await act(async () => {
      listenerRegistration.resolve.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    });
    expect(listenerUnlistens).toHaveLength(3);
    expect(listenerUnlistens.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("restores focus to the invoking control when the dialog unmounts", async () => {
    const opener = document.createElement("button");
    opener.textContent = "open branches";
    document.body.appendChild(opener);
    opener.focus();

    const view = render(<BranchPickerDialog projectId="p1" />);
    expect(await screen.findByRole("textbox", { name: "搜索本地分支" })).toBe(document.activeElement);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("supports creation from a local start point and default switching", async () => {
    const user = userEvent.setup();
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");
    await user.type(screen.getByRole("textbox", { name: "新分支名称" }), "feature/new");
    await user.selectOptions(screen.getByRole("combobox", { name: "新分支起点" }), "feature/ui");
    await user.click(screen.getByRole("button", { name: "创建分支" }));
    await waitFor(() => expect(apiMock.createLocalBranch).toHaveBeenCalledWith("p1", "feature/new", "feature/ui"));
    expect(apiMock.switchLocalBranch).toHaveBeenCalledWith("p1", "feature/new");
  });

  it("keeps Current HEAD as an optional null start point", async () => {
    const user = userEvent.setup();
    render(<BranchPickerDialog projectId="p1" />);
    await screen.findAllByText("feature/ui");
    await user.type(screen.getByRole("textbox", { name: "新分支名称" }), "feature/head");
    await user.selectOptions(screen.getByRole("combobox", { name: "新分支起点" }), "");
    await user.click(screen.getByRole("button", { name: "创建分支" }));
    await waitFor(() => expect(apiMock.createLocalBranch).toHaveBeenCalledWith("p1", "feature/head", null));
  });

  it("keeps structured live-session and recovery metadata without parsing a message", () => {
    const error = {
      code: "blocked",
      message: "checkout busy",
      phase: "switch",
      operationId: "tauri-1",
      recoverable: true,
      currentStatus: status,
      liveSessionIds: ["s1"],
      recoveryActions: ["open_session"],
      diagnostics: { command: "switch_local_branch" },
    };
    expect(isStructuredGitError(error)).toBe(true);
    expect(isStructuredGitError({ message: JSON.stringify(error) })).toBe(false);
    expect(isStructuredGitError("{\"liveSessionIds\":[\"s1\"]}" )).toBe(false);
  });

  it("renders a structured non-Git response instead of failing the dialog", async () => {
    apiMock.listLocalBranches.mockResolvedValueOnce({
      status: {
        ...status,
        isGitRepository: false,
        checkoutRoot: null,
        repoKey: null,
        head: { kind: "unborn" },
        snapshotToken: "non-git",
      },
      branches: [],
      autoStashes: [],
    });
    render(<BranchPickerDialog projectId="p1" />);
    expect((await screen.findByRole("alert")).textContent).toContain("该项目不是 Git 仓库");
    expect((screen.getByRole("button", { name: "创建分支" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
