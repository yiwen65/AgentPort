// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { RemoteClient } from "./client";
import { setState } from "../store";
import BranchPickerDialog from "../components/BranchPickerDialog";

const { request, renderErrors } = vi.hoisted(() => ({
  request: vi.fn(),
  renderErrors: [] as Error[],
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  const { RemoteBackend } = await import("./backend");
  const backend = new RemoteBackend({
    request,
    hasCapability: () => true,
    addEventListener: () => () => undefined,
    deviceId: "remote-branch-test",
  } as unknown as RemoteClient);
  return {
    ...actual,
    api: {
      ...actual.api,
      listLocalBranches: (id: string) => backend.listLocalBranches(id),
      switchLocalBranch: (id: string, branch: string) => backend.switchLocalBranch(id, branch),
      createLocalBranch: (id: string, name: string, start: string | null) => backend.createLocalBranch(id, name, start),
      createAndSwitchLocalBranch: (id: string, name: string, start: string | null) => backend.createAndSwitchLocalBranch(id, name, start),
      deleteLocalBranch: (id: string, branch: string, force: boolean) => backend.deleteLocalBranch(id, branch, force),
    },
    onRepositoryOperationProgress: async () => () => undefined,
    onRepositoryStateChanged: async () => () => undefined,
    onAutoStashChanged: async () => () => undefined,
  };
});
vi.mock("../actions", () => ({ selectSession: vi.fn() }));

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { renderErrors.push(error); }
  render() { return this.state.failed ? <div>render crashed</div> : this.props.children; }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); request.mockReset(); });

it("opens the branch picker with the actual remote branch.list wire response without unmounting the app", async () => {
  renderErrors.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  request.mockImplementation(async (method: string) => {
    if (method === "branch.list") return {
      repositoryRoot: "/remote/project", repoKey: "remote-repo",
      status: {
        checkout: { kind: "branch", value: "main" }, paths: [],
        staged: false, unstaged: false, untracked: false, unmerged: false,
        dirtySubmodule: false, operationState: null,
      },
      branches: [{ name: "main", oid: "a".repeat(40), current: true, occupiedWorktree: "/remote/project" }],
    };
    if (method === "git.context.resolve") return { liveSessionIds: [] };
    if (method === "branch.autostash.list" || method === "worktree.list") return [];
    throw new Error(`Unexpected ${method}`);
  });
  setState({ projects: [], repositoryStatuses: {}, dialog: null });
  render(<RenderBoundary><BranchPickerDialog projectId="remote-project" /></RenderBoundary>);
  await waitFor(() => expect(request).toHaveBeenCalledWith("branch.list", { projectId: "remote-project" }));
  await waitFor(() => {
    expect(renderErrors).toEqual([]);
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
  });
  expect(screen.queryByText("render crashed")).toBeNull();
});

it.each(["switch", "create", "createAndSwitch", "delete"] as const)(
  "keeps the remote picker mounted after %s succeeds while the branch-list refresh is pending",
  async (operation) => {
    renderErrors.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let mutationDone = false;
    const snapshot = (branch: string) => ({
      repositoryRoot: "/remote/project", repoKey: "remote-repo",
      status: {
        checkout: { kind: "branch", value: branch }, paths: [],
        staged: false, unstaged: false, untracked: false, unmerged: false,
        dirtySubmodule: false, operationState: null,
      },
      branches: ["main", "feature/ui"].map((name) => ({
        name, oid: "a".repeat(40), current: name === branch, occupiedWorktree: null,
      })),
    });
    const method = {
      switch: "branch.switch", create: "branch.create",
      createAndSwitch: "branch.create_switch", delete: "branch.delete",
    }[operation];
    request.mockImplementation(async (name: string) => {
      if (name === method) {
        mutationDone = true;
        // Core outcomes do NOT contain the desktop status DTO.
        if (operation === "create") return { operationId: "op", branch: { name: "feature/new", oid: "b".repeat(40), current: false, occupiedWorktree: null } };
        if (operation === "delete") return { operationId: "op", branchName: "feature/ui", deletedOid: "a".repeat(40) };
        return { operationId: "op", source: { kind: "branch", value: "main" },
          targetBranch: operation === "switch" ? "feature/ui" : "feature/new",
          stashed: false, restored: false, pendingRestore: false };
      }
      if (name === "branch.list") {
        // Leave a network round trip pending so the mutation result renders.
        if (mutationDone) return new Promise(() => undefined);
        return snapshot("main");
      }
      if (name === "branch.status") return snapshot(operation === "switch" ? "feature/ui" : operation === "createAndSwitch" ? "feature/new" : "main");
      if (name === "git.context.resolve") return { liveSessionIds: [] };
      if (name === "branch.autostash.list" || name === "worktree.list") return [];
      throw new Error(`Unexpected ${name}`);
    });
    setState({ projects: [], repositoryStatuses: {}, dialog: null });
    render(<RenderBoundary><BranchPickerDialog projectId="remote-project" /></RenderBoundary>);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "feature/ui" });
    if (operation === "switch") {
      await user.click(screen.getByRole("button", { name: "feature/ui" }));
    } else if (operation === "delete") {
      await user.click(screen.getByRole("button", { name: "删除分支 feature/ui" }));
      await user.click(screen.getByRole("button", { name: "确认删除" }));
    } else {
      await user.type(screen.getByRole("textbox", { name: "新分支名称" }), "feature/new");
      if (operation === "create") await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "创建分支" }));
    }
    await waitFor(() => expect(mutationDone).toBe(true));
    await waitFor(() => expect(request.mock.calls.filter(([name]) => name === "branch.list")).toHaveLength(2));
    expect(renderErrors).toEqual([]);
    expect(screen.queryByText("render crashed")).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索本地分支" })).toBeTruthy();
  },
);
