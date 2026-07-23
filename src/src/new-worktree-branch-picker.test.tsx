// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, refreshProjectsMock } = vi.hoisted(() => ({
  apiMock: {
    listLocalBranches: vi.fn(),
    createWorktree: vi.fn(),
  },
  refreshProjectsMock: vi.fn(),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

vi.mock("./actions", () => ({ refreshProjects: refreshProjectsMock }));

import NewWorktreeDialog from "./components/NewWorktreeDialog";
import { setState } from "./store";

const status = {
  projectId: "p1",
  isGitRepository: true,
  checkoutRoot: "/repo with spaces ü",
  repoKey: "repo-key",
  head: { kind: "branch", branch: "main", oid: "a".repeat(40), shortOid: "aaaaaaaaaaaa" },
  changes: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 },
  ongoingOperation: null,
  liveSessionIds: [],
  pendingAutoStashes: 0,
  observedAt: "2026-07-23T00:00:00.000Z",
  snapshotToken: "snapshot-1",
};

const branches = [
  { name: "main", oid: "a".repeat(40), current: true, checkedOutPath: null, agentPortWorktreeId: null },
  { name: "feature/local-ü", oid: "b".repeat(40), current: false, checkedOutPath: null, agentPortWorktreeId: null },
  { name: "feature/occupied", oid: "c".repeat(40), current: false, checkedOutPath: "/other Worktree ü", agentPortWorktreeId: "wt-other" },
];

describe("New Worktree local branch picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      projects: [{
        id: "p1",
        name: "Demo",
        rootPath: "/repo with spaces ü",
        gitRootPath: "/repo with spaces ü",
        sessions: [],
        worktrees: [],
      }],
    });
    apiMock.listLocalBranches.mockResolvedValue({ status, branches, autoStashes: [] });
    apiMock.createWorktree.mockResolvedValue({
      id: "wt-created",
      branch: "feature/local-ü",
      path: "/created Worktree ü",
      baseCommit: "b".repeat(40),
    });
    refreshProjectsMock.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("searches with the branch combobox and selects an existing local branch by keyboard", async () => {
    const user = userEvent.setup();
    render(<NewWorktreeDialog projectId="p1" />);

    const branchInput = await screen.findByRole("combobox", { name: "本地 branch" });
    expect(branchInput.getAttribute("aria-expanded")).toBe("false");
    await user.click(branchInput);
    expect(branchInput.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox", { name: "本地 branch 候选" });
    expect(within(listbox).getByText("feature/local-ü")).toBeTruthy();
    await waitFor(() => expect(branchInput.getAttribute("aria-activedescendant")).toBeTruthy());

    await user.type(branchInput, "local");
    expect(within(listbox).queryByText("main")).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");

    expect((branchInput as HTMLInputElement).value).toBe("feature/local-ü");
    expect(document.activeElement).toBe(branchInput);
    expect(branchInput.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/使用已有 branch/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "当前 HEAD" })).toBeNull();

    await user.type(screen.getByLabelText("任务名"), "reuse local branch");
    await user.click(screen.getByRole("button", { name: "创建 Worktree" }));

    await waitFor(() => expect(apiMock.createWorktree).toHaveBeenCalledWith(
      "p1",
      "reuse local branch",
      null,
      "feature/local-ü",
      "existing",
      "b".repeat(40),
    ));
    expect(refreshProjectsMock).toHaveBeenCalledTimes(1);
  });

  it("announces the loading state before local branch enumeration completes", async () => {
    let resolveBranches!: (value: { status: typeof status; branches: typeof branches; autoStashes: never[] }) => void;
    apiMock.listLocalBranches.mockReturnValueOnce(new Promise((resolve) => {
      resolveBranches = resolve;
    }));
    render(<NewWorktreeDialog projectId="p1" />);

    const branchInput = screen.getByRole("combobox", { name: "本地 branch" });
    await userEvent.setup().click(branchInput);
    expect(screen.getByRole("status").textContent).toContain("正在读取本地 branch");

    resolveBranches({ status, branches, autoStashes: [] });
    expect(await screen.findByRole("listbox", { name: "本地 branch 候选" })).toBeTruthy();
  });

  it("shows current and occupied branches with paths and prevents selecting them", async () => {
    const user = userEvent.setup();
    render(<NewWorktreeDialog projectId="p1" />);
    const branchInput = await screen.findByRole("combobox", { name: "本地 branch" });
    await user.click(branchInput);

    const mainOption = screen.getByText("main").closest('[role="option"]');
    const occupiedOption = screen.getByText("feature/occupied").closest('[role="option"]');
    expect(mainOption?.getAttribute("aria-disabled")).toBe("true");
    expect(occupiedOption?.getAttribute("aria-disabled")).toBe("true");
    expect(within(mainOption as HTMLElement).getByText("当前 checkout")).toBeTruthy();
    expect(within(mainOption as HTMLElement).getByText("/repo with spaces ü")).toBeTruthy();
    expect(within(occupiedOption as HTMLElement).getByText("已被 Worktree 占用")).toBeTruthy();
    expect(within(occupiedOption as HTMLElement).getByText("/other Worktree ü")).toBeTruthy();

    await user.click(occupiedOption as HTMLElement);
    expect((branchInput as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/使用已有 branch/)).toBeNull();
  });

  it("keeps manual new branch and explicit Base Ref behavior", async () => {
    const user = userEvent.setup();
    render(<NewWorktreeDialog projectId="p1" />);
    const branchInput = await screen.findByRole("combobox", { name: "本地 branch" });
    await user.type(screen.getByLabelText("任务名"), "manual branch");
    await user.type(branchInput, "feature/new-local");
    expect(await screen.findByText("没有匹配的本地 branch；继续输入将创建新 branch。")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "指定 Base Ref" }));
    await user.type(screen.getByLabelText("Base Ref"), "main");
    await user.click(screen.getByRole("button", { name: "创建 Worktree" }));

    await waitFor(() => expect(apiMock.createWorktree).toHaveBeenCalledWith(
      "p1",
      "manual branch",
      "main",
      "feature/new-local",
      "new",
      null,
    ));
  });

  it("keeps blank branch auto-generation behavior", async () => {
    const user = userEvent.setup();
    render(<NewWorktreeDialog projectId="p1" />);
    await screen.findByRole("combobox", { name: "本地 branch" });
    await user.type(screen.getByLabelText("任务名"), "auto branch task");
    expect(screen.getByText("agent/auto-branch-task")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "创建 Worktree" }));

    await waitFor(() => expect(apiMock.createWorktree).toHaveBeenCalledWith(
      "p1",
      "auto branch task",
      null,
      null,
      "auto",
      null,
    ));
  });

  it("refreshes a stale selected branch after backend rejection and preserves the task", async () => {
    const user = userEvent.setup();
    apiMock.listLocalBranches
      .mockResolvedValueOnce({ status, branches, autoStashes: [] })
      .mockResolvedValueOnce({
        status: { ...status, snapshotToken: "snapshot-moved" },
        branches: branches.map((candidate) => candidate.name === "feature/local-ü"
          ? { ...candidate, oid: "d".repeat(40) }
          : candidate),
        autoStashes: [],
      });
    apiMock.createWorktree.mockRejectedValueOnce({
      code: "conflict",
      message: "local branch moved after selection",
      phase: "create",
      operationId: "create-worktree-1",
      recoverable: true,
      currentStatus: status,
      recoveryActions: ["refresh local branches"],
      diagnostics: { command: "create_worktree" },
      liveSessionIds: [],
    });
    render(<NewWorktreeDialog projectId="p1" />);
    const taskInput = screen.getByLabelText("任务名") as HTMLInputElement;
    const branchInput = await screen.findByRole("combobox", { name: "本地 branch" });
    await user.type(taskInput, "keep this task");
    await user.click(branchInput);
    await user.type(branchInput, "local");
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "创建 Worktree" }));

    expect(await screen.findByText("无法创建 Worktree：local branch moved after selection")).toBeTruthy();
    expect(await screen.findByText(/已移动，请重新选择最新提交/)).toBeTruthy();
    expect(taskInput.value).toBe("keep this task");
    expect(apiMock.listLocalBranches).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: "创建 Worktree" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports refresh errors, restores combobox focus, and Escape only closes the list", async () => {
    const user = userEvent.setup();
    apiMock.listLocalBranches
      .mockResolvedValueOnce({ status, branches, autoStashes: [] })
      .mockRejectedValueOnce(new Error("refresh failed"));
    render(<NewWorktreeDialog projectId="p1" />);
    const branchInput = await screen.findByRole("combobox", { name: "本地 branch" });
    await user.click(branchInput);
    await user.click(screen.getByRole("button", { name: "刷新本地 branch" }));

    expect(await screen.findByText("无法读取本地分支：refresh failed")).toBeTruthy();
    expect(document.activeElement).toBe(branchInput);
    expect(branchInput.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(branchInput.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("dialog", { name: "新 Worktree · Demo" })).toBeTruthy();
  });

  it("keeps non-Git projects on the existing plain branch input without candidates", async () => {
    setState({
      projects: [{
        id: "p1",
        name: "Plain folder",
        rootPath: "/plain",
        gitRootPath: null,
        sessions: [],
        worktrees: [],
      }],
    });
    apiMock.listLocalBranches.mockResolvedValue({
      status: { ...status, isGitRepository: false, checkoutRoot: null, repoKey: null },
      branches: [],
      autoStashes: [],
    });
    render(<NewWorktreeDialog projectId="p1" />);
    await waitFor(() => expect(apiMock.listLocalBranches).toHaveBeenCalled());

    expect(screen.queryByRole("combobox", { name: "本地 branch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新本地 branch" })).toBeNull();
    expect(screen.getByLabelText(/分支名/).getAttribute("role")).toBeNull();
  });
});
