import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { RemoteClient } from "../../protocol/remoteClient";
import { GitPanel } from "./GitPanel";
import type { BranchSnapshot, GitChangesSnapshot, GitCheckoutDescriptor, GitCommitReview } from "./types";

const context: GitCheckoutDescriptor = {
  target: { projectId: "prj-1", kind: "main", worktreeId: null },
  checkoutId: "co-1", repoKey: "repo-1", projectName: "AgentPort", projectRoot: "/repo", checkoutRoot: "/repo",
  expectedBranch: null, actualBranch: "main", headOid: "head-1", detached: false, unborn: false,
  ongoingOperation: null, hasRemote: true, remote: "origin", remoteUrl: "git@example.com:repo.git", upstream: "origin/main",
  ahead: 1, behind: 0, worktreeHealth: null, liveSessionIds: [], writable: true, blockers: [], warnings: [],
};

function snapshot(entries: GitChangesSnapshot["entries"], token = "status-1"): GitChangesSnapshot {
  return {
    context, statusToken: token, complete: true, partialReason: null,
    counts: {
      staged: entries.filter(entry => entry.staged).length,
      unstaged: entries.filter(entry => entry.unstaged && !entry.untracked).length,
      untracked: entries.filter(entry => entry.untracked).length,
      ignored: 0, conflict: entries.filter(entry => entry.conflicted).length, renamed: 0, submodule: 0,
    },
    entries, observedAt: "2026-11-16T12:00:00Z",
  };
}

const entry = (overrides: Partial<GitChangesSnapshot["entries"][number]>) => ({
  entryToken: "e1", pathToken: "p1", displayPath: "src/App.tsx",
  oldPathToken: null, displayOldPath: null, indexStatus: null, worktreeStatus: "M", conflictCode: null,
  kind: "modified" as const, submoduleState: null, staged: false, unstaged: true, untracked: false, ignored: false, conflicted: false,
  ...overrides,
});

const branches: BranchSnapshot = {
  repositoryRoot: "/repo", repoKey: "repo-1",
  status: { checkout: { branch: "main" }, paths: [], staged: false, unstaged: false, untracked: false, unmerged: false, dirtySubmodule: false, operationState: null },
  branches: [
    { name: "main", oid: "a", current: true, occupiedWorktree: null },
    { name: "feature/ui", oid: "b", current: false, occupiedWorktree: null },
  ],
};

function setup(initial = snapshot([entry({}), entry({ entryToken: "e2", pathToken: "p2", displayPath: "README.md", kind: "untracked", worktreeStatus: null, unstaged: false, untracked: true })]), options: { pendingRestore?: boolean } = {}) {
  let changes = initial;
  const review: GitCommitReview = {
    context, commitToken: "commit-token", message: "Test commit", messageHash: "hash",
    beforeHead: "head-1", indexHash: "index", expectedTreeOid: "tree",
    files: [{ status: "modified", pathToken: "p1", displayPath: "src/App.tsx", oldPathToken: null, displayOldPath: null, additions: 1, deletions: 1, binary: false, outsideProject: false }],
    outsideProjectPaths: [], subjectOver72: false, warnings: [],
  };
  const request = vi.fn(async (_hostId: string, method: string, params: any) => {
    if (method === "git.context.resolve") return context;
    if (method === "git.changes") return changes;
    if (method === "git.diff") return {
      context, statusToken: changes.statusToken, side: params.side, pathToken: params.pathToken, displayPath: "src/App.tsx",
      format: "text", patch: "@@ -1 +1 @@\n-old line\n+new line", additions: 1, deletions: 1, fileSize: 24, truncated: false, reason: null, conflictCode: null,
    };
    if (method === "git.stage") {
      changes = snapshot([entry({ staged: true, unstaged: false })], "status-2");
      return { operationId: "stage", changes };
    }
    if (method === "git.unstage") {
      changes = initial;
      return { operationId: "unstage", changes };
    }
    if (method === "git.discard") {
      changes = snapshot(initial.entries.filter(value => value.entryToken !== "e1"), "status-3");
      return { operationId: "discard", changes };
    }
    if (method === "branch.list") return branches;
    if (method === "branch.switch") return { operationId: "switch", source: { branch: "main" }, targetBranch: params.branch, stashed: Boolean(options.pendingRestore), restored: false, pendingRestore: Boolean(options.pendingRestore) };
    if (method === "branch.create_switch") return { operationId: "create-switch", source: { branch: "main" }, targetBranch: params.name, stashed: false, restored: false, pendingRestore: false };
    if (method === "branch.autostash.list") return [{ operationId: "switch", phase: "switched", selector: "stash@{0}", oid: "stash-oid", marker: "marker", sourceBranch: "main", sourceCommit: "head-1", targetBranch: "feature/ui", createdAt: "2026-11-16T12:00:00Z" }];
    if (method === "branch.autostash.restore") return { id: "switch", projectId: "prj-1", phase: "restored_verified", sourceBranch: "main", targetBranch: "feature/ui" };
    if (method === "branch.autostash.cleanup") return { id: "switch", projectId: "prj-1", phase: "completed", sourceBranch: "main", targetBranch: "feature/ui" };
    if (method === "git.commit.prepare") return { ...review, message: params.message };
    if (method === "git.commit.execute") return { operationId: "commit", outcome: "succeeded", beforeHead: "head-1", afterHead: "head-2", expectedTreeOid: "tree", actualTreeOid: "tree", changes: snapshot([], "clean"), error: null };
    throw new Error(`unexpected ${method}`);
  });
  return { request, client: { request } as unknown as RemoteClient, current: () => changes };
}

function renderPanel(client: RemoteClient, overrides: Partial<Parameters<typeof GitPanel>[0]> = {}) {
  return render(<GitPanel client={client} hostId="host-1" sessionId="ses-1" sessionTitle="Agent task" onClose={vi.fn()} {...overrides} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

describe("mobile Git Center", () => {
  it("groups changes, shows the branch, and stages a file", async () => {
    const { client, request } = setup();
    renderPanel(client);
    const path = await screen.findByText("src/App.tsx");
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Unstaged")).toBeInTheDocument();
    expect(screen.getByText("Untracked")).toBeInTheDocument();
    const row = path.closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "git.stage", expect.objectContaining({
      expectedCheckoutId: "co-1",
      expectedStatusToken: "status-1",
      includeIgnored: false,
      selections: [{ pathToken: "p1", entryToken: "e1" }],
    })));
    expect(await screen.findByText("Staged")).toBeInTheDocument();
    const stagedRow = screen.getByText("src/App.tsx").closest("li")!;
    expect(within(stagedRow).getByRole("button", { name: "Unstage" })).toBeInTheDocument();
  });

  it("opens a diff and discards unstaged changes after confirmation", async () => {
    const { client, request } = setup();
    renderPanel(client);
    fireEvent.click(await screen.findByRole("button", { name: /src\/App\.tsx/ }));
    expect(await screen.findByText(/\+new line/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("git-panel-fullscreen");
    expect(screen.queryByRole("tab", { name: "Branches" })).not.toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Diff content" });
    expect([...region.querySelectorAll(".git-diff-line-no")].map((node) => node.textContent))
      .toEqual(["", "", "1", "", "", "1"]);
    expect(request).toHaveBeenCalledWith("host-1", "git.diff", expect.objectContaining({ expectedStatusToken: "status-1", side: "unstaged", pathToken: "p1", includeIgnored: false }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const confirm = within(screen.getByRole("alertdialog"));
    expect(confirm.getByText(/Discard changes to src\/App\.tsx/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "git.discard", expect.objectContaining({
      selections: [{ pathToken: "p1", entryToken: "e1" }],
    })));
    await waitFor(() => expect(screen.queryByText("src/App.tsx")).not.toBeInTheDocument());
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("ignores a stale diff response after backing out and opening another file", async () => {
    const { client, request } = setup();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const diffOf = (pathToken: string, displayPath: string) => ({
      context, statusToken: "status-1", side: "unstaged", pathToken, displayPath,
      format: "text", patch: `@@ -1 +1 @@\n-old line\n+${pathToken} line`, additions: 1, deletions: 1,
      fileSize: 24, truncated: false, reason: null, conflictCode: null,
    });
    const originalRequest = request.getMockImplementation()!;
    vi.mocked(client.request).mockImplementation(async (hostId: string, method: string, params: any) => {
      if (method === "git.diff") return params.pathToken === "p1" ? first.promise : second.promise;
      return originalRequest(hostId, method, params);
    });
    renderPanel(client);
    fireEvent.click(await screen.findByRole("button", { name: /src\/App\.tsx/ }));
    fireEvent.click(screen.getByRole("button", { name: /Changes/ }));
    fireEvent.click(screen.getByRole("button", { name: /README\.md/ }));
    await act(async () => { second.resolve(diffOf("p2", "README.md")); });
    expect(await screen.findByText("+p2 line")).toBeInTheDocument();
    await act(async () => { first.resolve(diffOf("p1", "src/App.tsx")); });
    expect(screen.queryByText("+p1 line")).not.toBeInTheDocument();
    expect(screen.getByText("+p2 line")).toBeInTheDocument();
  });

  it("reviews and commits staged files", async () => {
    const { client, request } = setup(snapshot([entry({ staged: true, unstaged: false })]));
    renderPanel(client);
    await screen.findByText("src/App.tsx");
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Ship the UI" } });
    const reviewButton = screen.getByRole("button", { name: "Review commit" });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);
    expect(request).toHaveBeenCalledWith("host-1", "git.commit.prepare", expect.objectContaining({ includeIgnored: false }));
    await waitFor(() => expect(screen.getByRole("dialog").innerHTML).toContain("git-commit-review"));
    expect(await screen.findByText("Ship the UI")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Review commit" })).getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "git.commit.execute", expect.objectContaining({
      expectedCheckoutId: "co-1", expectedCommitToken: "commit-token", message: "Ship the UI", includeIgnored: false,
    })));
    expect(await screen.findByText("Commit created.")).toBeInTheDocument();
  });

  it("switches and creates local branches", async () => {
    const { client, request } = setup();
    renderPanel(client);
    fireEvent.click(await screen.findByRole("tab", { name: "Branches" }));
    fireEvent.click(await screen.findByRole("button", { name: /feature\/ui/ }));
    const confirm = within(screen.getByRole("alertdialog"));
    fireEvent.click(confirm.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "branch.switch", { projectId: "prj-1", branch: "feature/ui" }));
    expect(await screen.findByText("Switched to feature/ui.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "New branch" }), { target: { value: "feature/mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & switch" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "branch.create_switch", { projectId: "prj-1", name: "feature/mobile", startPoint: null }));
  });

  it("restores the switch autostash automatically", async () => {
    const { client, request } = setup(undefined, { pendingRestore: true });
    renderPanel(client);
    fireEvent.click(await screen.findByRole("tab", { name: "Branches" }));
    fireEvent.click(await screen.findByRole("button", { name: /feature\/ui/ }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "branch.autostash.list", { projectId: "prj-1" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "branch.autostash.restore", { operationId: "switch", strategy: "target" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "branch.autostash.cleanup", { operationId: "switch" }));
    expect(await screen.findByText("Switched to feature/ui; local changes restored.")).toBeInTheDocument();
    expect(screen.queryByText(/desktop/i)).not.toBeInTheDocument();
  });

  it("keeps worktree branches read-only", async () => {
    const worktreeContext = { ...context, target: { ...context.target, kind: "worktree" as const, worktreeId: "wt-1" }, expectedBranch: "feature/wt", actualBranch: "feature/wt" };
    const { client } = setup();
    vi.mocked(client.request).mockImplementation(async (_hostId: string, method: string) => {
      if (method === "git.context.resolve") return worktreeContext;
      if (method === "git.changes") return snapshot([]);
      if (method === "branch.list") return branches;
      throw new Error(`unexpected ${method}`);
    });
    renderPanel(client);
    fireEvent.click(await screen.findByRole("tab", { name: "Branches" }));
    expect(await screen.findByText(/Branch switching applies to the main checkout/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /feature\/ui/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create & switch" })).not.toBeInTheDocument();
  });
});
