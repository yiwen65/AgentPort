// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
    api: { ...actual.api, listLocalBranches: (id: string) => backend.listLocalBranches(id) },
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
