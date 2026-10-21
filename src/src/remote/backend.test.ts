import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend, ROUTING } from "./backend";
import type { RemoteClient } from "./client";
import { RemoteRequestError, RemoteUnavailableError, isRemoteUnavailableError } from "./errors";

const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
const submitInput = vi.fn<(params: unknown) => Promise<void>>();
const hasCapability = vi.fn(() => true);
const addEventListener = vi.fn(() => () => undefined);

function makeBackend(): RemoteBackend {
  const client = {
    request,
    submitInput,
    hasCapability,
    deviceId: "dev-1",
    addEventListener,
  } as unknown as RemoteClient;
  return new RemoteBackend(client);
}

beforeEach(() => {
  request.mockReset();
  submitInput.mockReset().mockResolvedValue(undefined);
  hasCapability.mockReset().mockReturnValue(true);
});

describe("sessions domain", () => {
  it("createSession passes args through and adapts the launch result", async () => {
    request.mockResolvedValueOnce({
      sessionId: "ses_1",
      resumePrecision: "exact",
      agentSessionId: null,
      notices: [],
    });
    const backend = makeBackend();
    const result = await backend.createSession({
      projectId: "prj_1",
      agent: "claude",
      title: null,
      presetId: null,
      worktreeId: null,
      permission: "auto",
      transport: "pty",
      riskAck: false,
      cols: 80,
      rows: 24,
      extraArgs: null,
    });
    expect(request).toHaveBeenCalledWith(
      "session.create",
      expect.objectContaining({ projectId: "prj_1", agent: "claude" }),
    );
    expect(result).toMatchObject({ id: "ses_1", command: [], notes: [] });
  });

  it("attachSession sends subscribeOutput and upgrades resumeFrom to a RunCursor", async () => {
    request.mockResolvedValueOnce({
      attachmentId: "att-1",
      sessionId: "ses_1",
      childAlive: true,
      agentSessionId: null,
      cursor: null,
      features: [],
      runId: "run-1",
      runOrdinal: 1,
      terminalGeometry: null,
    });
    const backend = makeBackend();
    const info = await backend.attachSession(
      "ses_1",
      4096,
      undefined,
      { runId: "run-0", runOrdinal: 0, generation: 1, offset: 12 },
      true,
    );
    expect(request).toHaveBeenCalledWith("session.attach", {
      sessionId: "ses_1",
      replayTailBytes: 4096,
      resumeFrom: {
        runId: "run-0",
        runOrdinal: 0,
        generation: 1,
        offset: 12,
        statusSequence: 0,
      },
      subscribeOutput: true,
      screenSnapshot: true,
    });
    expect(info).toMatchObject({ remote: true, attachmentId: "att-1" });
    expect(backend.attachmentIdFor("ses_1")).toBe("att-1");
  });

  it("sendInput uses the ordered input queue with attachmentId and a unique batchId", async () => {
    const backend = makeBackend();
    (backend as never as { attachments: Map<string, string> }).attachments.set(
      "ses_1",
      "att-1",
    );
    await backend.sendInput("ses_1", "aGVsbG8=");
    await backend.sendInput("ses_1", "d29ybGQ=");
    const [first, second] = submitInput.mock.calls;
    expect(first[0]).toMatchObject({
      attachmentId: "att-1",
      dataBase64: "aGVsbG8=",
    });
    const batchA = (first[0] as { batchId: string }).batchId;
    const batchB = (second[0] as { batchId: string }).batchId;
    expect(batchA).not.toBe(batchB);
    // Input must not ride the acknowledged request path: that would add one
    // round trip per keystroke/wheel report.
    expect(request).not.toHaveBeenCalledWith("session.input", expect.anything());
  });

  it("sendInput surfaces an input-queue rejection", async () => {
    submitInput.mockRejectedValueOnce(
      new RemoteRequestError("input_queue_full", "too many frames"),
    );
    const backend = makeBackend();
    (backend as never as { attachments: Map<string, string> }).attachments.set(
      "ses_1",
      "att-1",
    );
    await expect(backend.sendInput("ses_1", "eA==")).rejects.toMatchObject({
      code: "input_queue_full",
    });
  });

  it("sendInput fails fast without an attachment", async () => {
    const backend = makeBackend();
    await expect(backend.sendInput("ses_x", "eA==")).rejects.toMatchObject({
      code: "no_attachment",
    });
    expect(submitInput).not.toHaveBeenCalled();
  });

  it("detachSession calls by attachmentId and clears the registry", async () => {
    request.mockResolvedValue(undefined);
    const backend = makeBackend();
    (backend as never as { attachments: Map<string, string> }).attachments.set(
      "ses_1",
      "att-1",
    );
    await backend.detachSession("ses_1", "att-1");
    expect(request).toHaveBeenCalledWith("session.detach", { attachmentId: "att-1" });
    expect(backend.attachmentIdFor("ses_1")).toBeNull();
  });

  it("resizePty sends geometry authority only with the capability negotiated", async () => {
    request.mockResolvedValue({ accepted: true });
    const backend = makeBackend();
    (backend as never as { attachments: Map<string, string> }).attachments.set(
      "ses_1",
      "att-1",
    );
    const authority = {
      expectedRevision: 5,
      sourceKind: "desktop" as const,
      sourceDeviceId: "mac-1",
      orientation: null,
    };
    await backend.resizePty("ses_1", 120, 40, 960, 640, authority);
    expect(request).toHaveBeenLastCalledWith("session.control", {
      attachmentId: "att-1",
      control: "resize",
      cols: 120,
      rows: 40,
      expectedRevision: 5,
      sourceKind: "desktop",
      sourceDeviceId: "mac-1",
    });
    hasCapability.mockReturnValue(false);
    await backend.resizePty("ses_1", 100, 30, 800, 480, authority);
    expect(request).toHaveBeenLastCalledWith("session.control", {
      attachmentId: "att-1",
      control: "resize",
      cols: 100,
      rows: 30,
    });
  });

  it("interruptSession/resumeSession map to control kinds", async () => {
    request.mockResolvedValue({});
    const backend = makeBackend();
    (backend as never as { attachments: Map<string, string> }).attachments.set(
      "ses_1",
      "att-1",
    );
    await backend.interruptSession("ses_1");
    await backend.resumeSession("ses_1");
    expect(request).toHaveBeenNthCalledWith(1, "session.control", {
      attachmentId: "att-1",
      control: "interrupt",
    });
    expect(request).toHaveBeenNthCalledWith(2, "session.control", {
      attachmentId: "att-1",
      control: "continue",
    });
  });

  it("markSessionSeen uses the given cursor directly", async () => {
    request.mockResolvedValue(undefined);
    const backend = makeBackend();
    await backend.markSessionSeen("ses_1", { runId: "r", runOrdinal: 1, sequence: 3 });
    expect(request).toHaveBeenCalledWith("session.seen.mark", {
      sessionId: "ses_1",
      cursor: { runId: "r", runOrdinal: 1, sequence: 3 },
    });
  });

  it("markSessionSeen with a null cursor resolves the latest status remotely", async () => {
    request.mockResolvedValueOnce([
      {
        id: "ses_1",
        latestStatus: {
          runId: "r",
          runOrdinal: 2,
          sequence: 8,
          state: "idle",
          source: "pty",
          confidence: "low",
          occurredAt: "t",
        },
      },
    ]);
    request.mockResolvedValueOnce(undefined);
    const backend = makeBackend();
    await backend.markSessionSeen("ses_1", null);
    expect(request).toHaveBeenNthCalledWith(2, "session.seen.mark", {
      sessionId: "ses_1",
      cursor: { runId: "r", runOrdinal: 2, sequence: 8 },
    });
  });

  it("markSessionSeen no-ops when the session has no status at all", async () => {
    request.mockResolvedValueOnce([{ id: "ses_1", latestStatus: null }]);
    const backend = makeBackend();
    await backend.markSessionSeen("ses_1", null);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("markSessionOutputUnread upgrades the cursor and rejects the offset-only form", async () => {
    request.mockResolvedValue(undefined);
    const backend = makeBackend();
    await backend.markSessionOutputUnread("ses_1", 50, {
      runId: "r",
      runOrdinal: 1,
      generation: 0,
      offset: 50,
    });
    expect(request).toHaveBeenCalledWith("session.output.unread.mark", {
      sessionId: "ses_1",
      cursor: { runId: "r", runOrdinal: 1, generation: 0, offset: 50, statusSequence: 0 },
    });
    await expect(backend.markSessionOutputUnread("ses_1", 10, null)).rejects.toThrow(
      RemoteUnavailableError,
    );
  });

  it("markSessionLogRendered is a silent no-op", async () => {
    const backend = makeBackend();
    await expect(
      backend.markSessionLogRendered("ses_1", 1, {
        runId: "r",
        runOrdinal: 1,
        generation: 0,
        offset: 1,
      }),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("sessionHistory maps StatusSummary entries to StatusEventView", async () => {
    request.mockResolvedValueOnce([
      {
        runId: "r",
        runOrdinal: 1,
        sequence: 1,
        state: "working",
        source: "hook",
        confidence: "high",
        occurredAt: "t1",
      },
    ]);
    const backend = makeBackend();
    const history = await backend.sessionHistory("ses_1");
    expect(history[0]).toMatchObject({ sessionId: "ses_1", state: "working" });
  });
});

describe("projects domain", () => {
  it("listProjects assembles projects, sessions and per-project worktrees", async () => {
    request
      .mockResolvedValueOnce([
        { id: "prj_1", name: "A", rootPath: "/a", gitRootPath: null, pinned: false },
      ])
      .mockResolvedValueOnce([
        {
          id: "ses_1",
          projectId: "prj_1",
          worktreeId: null,
          presetId: "pre",
          title: "s",
          cwd: "/a",
          lifecycle: "running",
          agentSessionId: null,
          resumePrecision: "exact",
          adapterType: "pi",
          transport: "pty",
          permissionMode: "auto",
          pinnedAt: null,
          createdAt: "c",
          updatedAt: "u",
          archivedAt: null,
          latestStatus: null,
          hostAlive: true,
          latestAttentionKind: null,
          unreadAttention: true,
        },
        {
          id: "ses_archived",
          projectId: "prj_1",
          archivedAt: "2026-09-01T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "wt_1",
          projectId: "prj_1",
          branch: "b",
          baseCommit: "c1",
          path: "/a-b",
          health: "clean",
          createdAt: "c",
        },
      ]);
    const backend = makeBackend();
    const projects = await backend.listProjects("ses_1");
    expect(request).toHaveBeenNthCalledWith(3, "worktree.list", { projectId: "prj_1" });
    expect(projects).toHaveLength(1);
    expect(projects[0].sessions).toHaveLength(1);
    expect(projects[0].sessions[0]).toMatchObject({ id: "ses_1", unread: false });
    expect(projects[0].worktrees[0]).toMatchObject({ id: "wt_1", baseRef: null });
  });

  it("addProject adapts the wrapped result", async () => {
    request.mockResolvedValueOnce({
      project: {
        id: "prj_9",
        name: "N",
        rootPath: "/n",
        gitRootPath: null,
        pinned: false,
      },
      focusedExisting: false,
    });
    const backend = makeBackend();
    await expect(backend.addProject("/n", null)).resolves.toMatchObject({
      id: "prj_9",
      name: "N",
      focusedExisting: false,
    });
  });

  it("setProjectLayout replaces then re-reads the assembled list", async () => {
    request.mockResolvedValueOnce(undefined);
    request.mockResolvedValueOnce([]);
    request.mockResolvedValueOnce([]);
    const backend = makeBackend();
    const result = await backend.setProjectLayout(
      [{ id: "prj_1", pinned: true }],
      null,
    );
    expect(request).toHaveBeenNthCalledWith(1, "project.layout.replace", {
      entries: [{ projectId: "prj_1", pinned: true }],
    });
    expect(result).toEqual([]);
  });

  it("removeProject maps the preflight into versioned params", async () => {
    request.mockResolvedValueOnce({
      stopWarnings: 1,
      cleanupWarnings: 0,
      nativeCleanupWarnings: 2,
    });
    const backend = makeBackend();
    const preflight = {
      projectId: "prj_1",
      revision: "18446744073709551615",
      sessions: [{ id: "ses_1", archiveGeneration: 3, archived: true }],
      worktreeIds: ["wt_1"],
      recoverableOperationIds: ["op_1"],
      pendingCommitOperationIds: [],
      sessionCount: 1,
      activeSessionCount: 0,
      archivedSessionCount: 1,
      archivedSessions: [{ id: "ses_1", archiveGeneration: 3 }],
      worktreeCount: 1,
      recoverableOperationCount: 1,
      pendingCommitOperationCount: 0,
      canRemove: true,
    };
    await backend.removeProject(preflight);
    expect(request).toHaveBeenCalledWith("project.remove", {
      projectId: "prj_1",
      revision: "18446744073709551615",
      sessions: [{ sessionId: "ses_1", archiveGeneration: 3, archived: true }],
      worktreeIds: ["wt_1"],
      recoverableOperationIds: ["op_1"],
      pendingCommitOperationIds: [],
    });
  });

  it("deleteProjectArchivedSessions issues one delete per confirmed archive", async () => {
    request.mockResolvedValue(undefined);
    const backend = makeBackend();
    await backend.deleteProjectArchivedSessions("prj_1", [
      { id: "ses_1", archiveGeneration: 1 },
      { id: "ses_2", archiveGeneration: 2 },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, "session.archives.delete", {
      sessionId: "ses_1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "session.archives.delete", {
      sessionId: "ses_2",
    });
  });

  it("listArchivedSessions joins project names with an empty fallback", async () => {
    request
      .mockResolvedValueOnce([
        {
          id: "ses_1",
          projectId: "prj_1",
          worktreeId: null,
          presetId: "pre",
          title: "old",
          cwd: "/a",
          lifecycle: "exited",
          agentSessionId: null,
          resumePrecision: "exact",
          adapterType: "codex",
          transport: "pty",
          permissionMode: "auto",
          pinnedAt: null,
          createdAt: "c",
          updatedAt: "u",
          archivedAt: "2026-09-20T00:00:00Z",
          latestStatus: null,
          hostAlive: false,
          latestAttentionKind: null,
          unreadAttention: false,
        },
      ])
      .mockResolvedValueOnce([]);
    const backend = makeBackend();
    const archived = await backend.listArchivedSessions();
    expect(archived[0]).toMatchObject({
      id: "ses_1",
      projectName: "",
      archivedAt: "2026-09-20T00:00:00Z",
    });
  });
});

describe("agents/presets/worktrees/branches", () => {
  it("probeAgents forwards preserveSelections and maps outcomes", async () => {
    request.mockResolvedValueOnce([
      {
        agent: "pi",
        displayName: "Pi",
        state: "available",
        reason: null,
        reasonCode: null,
        reasonDetail: null,
        install: { agentType: "pi" },
        candidates: [],
        notificationSetup: null,
      },
    ]);
    const backend = makeBackend();
    const outcomes = await backend.probeAgents(true);
    expect(request).toHaveBeenCalledWith("agent.probe_all", {
      preserveSelections: true,
    });
    expect(outcomes[0]).toMatchObject({ agent: "pi", state: "available" });
  });

  it("notificationSetups extracts only reported setups from agent.supported", async () => {
    request.mockResolvedValueOnce([
      {
        agent: "claude",
        displayName: "Claude",
        commandNames: ["claude"],
        install: null,
        notificationSetup: { agent: "claude", state: "ready" },
      },
      {
        agent: "pi",
        displayName: "Pi",
        commandNames: ["pi"],
        install: null,
        notificationSetup: null,
      },
    ]);
    const backend = makeBackend();
    const setups = await backend.notificationSetups();
    expect(setups).toEqual([{ agent: "claude", state: "ready" }]);
  });

  it("createWorktree maps params and adapts the summary", async () => {
    request.mockResolvedValueOnce({
      id: "wt_1",
      projectId: "prj_1",
      branch: "task-x",
      baseCommit: "abc",
      path: "/p/task-x",
      health: "clean",
      createdAt: "c",
    });
    const backend = makeBackend();
    const result = await backend.createWorktree(
      "prj_1",
      "task x",
      "main",
      null,
      "new",
      "deadbeef",
    );
    expect(request).toHaveBeenCalledWith("worktree.create", {
      projectId: "prj_1",
      task: "task x",
      baseRef: "main",
      branch: null,
      branchMode: "new",
      expectedBranchOid: "deadbeef",
    });
    expect(result).toEqual({ id: "wt_1", branch: "task-x", path: "/p/task-x", baseCommit: "abc" });
  });

  it("removeWorktree adapts the destructive outcome", async () => {
    request.mockResolvedValueOnce({
      stopWarnings: 0,
      cleanupWarnings: 1,
      nativeCleanupWarnings: 1,
    });
    const backend = makeBackend();
    await expect(backend.removeWorktree("wt_1")).resolves.toEqual({
      stopWarnings: 0,
      cleanupWarnings: 1,
    });
  });

  it("maps the Bridge's raw BranchSnapshot to the desktop repository status", async () => {
    // Exact serde shape of core::git::BranchSnapshot, NOT LocalBranchesResponse.
    request.mockImplementation(async (method) => {
      if (method === "branch.status") return {
        repositoryRoot: "/remote/project", repoKey: "remote-repo",
        status: {
          checkout: { kind: "branch", value: "main" },
          paths: [{ path: "file.ts", staged: true, unstaged: false,
            untracked: false, unmerged: false, submoduleDirty: false }],
          staged: true, unstaged: false, untracked: false, unmerged: false,
          dirtySubmodule: false, operationState: null,
        },
        branches: [{ name: "main", oid: "a".repeat(40), current: true, occupiedWorktree: null }],
      };
      if (method === "git.context.resolve") return { liveSessionIds: ["ses_1"] };
      if (method === "branch.autostash.list") return [{ operationId: "stash-1" }];
      throw new Error(`Unexpected ${method}`);
    });
    const status = await makeBackend().getRepositoryStatus("prj_1");
    expect(status).toMatchObject({
      projectId: "prj_1", isGitRepository: true,
      checkoutRoot: "/remote/project", repoKey: "remote-repo",
      head: { kind: "branch", branch: "main", oid: "a".repeat(40), shortOid: "a".repeat(12) },
      changes: { staged: 1, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 },
      liveSessionIds: ["ses_1"], pendingAutoStashes: 1,
    });
    expect(status.snapshotToken).toBeTruthy();
    expect(request).toHaveBeenCalledWith("branch.status", { projectId: "prj_1" });
  });

  it("adapts branch.list status and checkout occupancy for the desktop branch picker", async () => {
    request.mockImplementation(async (method) => {
      if (method === "branch.list") return {
        repositoryRoot: "/remote/project", repoKey: "remote-repo",
        status: {
          checkout: { kind: "branch", value: "main" },
          paths: [{ path: "file.ts", staged: false, unstaged: true,
            untracked: false, unmerged: false, submoduleDirty: false }],
          staged: false, unstaged: true, untracked: false, unmerged: false,
          dirtySubmodule: false, operationState: null,
        },
        branches: [
          { name: "main", oid: "a".repeat(40), current: true, occupiedWorktree: "/remote/project" },
          { name: "managed", oid: "b".repeat(40), current: false, occupiedWorktree: "/remote/managed" },
          { name: "external", oid: "c".repeat(40), current: false, occupiedWorktree: "/remote/external" },
          { name: "available", oid: "d".repeat(40), current: false, occupiedWorktree: null },
        ],
      };
      if (method === "git.context.resolve") return { liveSessionIds: ["ses_live"] };
      if (method === "branch.autostash.list") return [];
      if (method === "worktree.list") return [
        { id: "wt-managed", projectId: "prj_1", path: "/remote/managed", branch: "managed" },
      ];
      throw new Error(`Unexpected ${method}`);
    });
    const result = await makeBackend().listLocalBranches("prj_1");
    expect(result.status).toMatchObject({
      projectId: "prj_1", isGitRepository: true,
      head: { kind: "branch", branch: "main", oid: "a".repeat(40) },
      changes: { staged: 0, unstaged: 1 },
      liveSessionIds: ["ses_live"], pendingAutoStashes: 0,
    });
    expect(result.branches).toMatchObject([
      { name: "main", current: true, checkedOutPath: null, agentPortWorktreeId: null },
      { name: "managed", checkedOutPath: "/remote/managed", agentPortWorktreeId: "wt-managed" },
      { name: "external", checkedOutPath: "/remote/external", agentPortWorktreeId: null },
      { name: "available", checkedOutPath: null, agentPortWorktreeId: null },
    ]);
    expect(result.autoStashes).toEqual([]);
    expect(request).toHaveBeenCalledWith("branch.list", { projectId: "prj_1" });
    expect(request).toHaveBeenCalledWith("git.context.resolve", { locator: { kind: "projectMain", projectId: "prj_1" } });
    expect(request).toHaveBeenCalledWith("branch.autostash.list", { projectId: "prj_1" });
    expect(request).toHaveBeenCalledWith("worktree.list", { projectId: "prj_1" });
  });

  it("listAutoStashes passes a nullable projectId through", async () => {
    request.mockResolvedValueOnce([{ id: "as_1" }]);
    const backend = makeBackend();
    await expect(backend.listAutoStashes(null)).resolves.toEqual([{ id: "as_1" }]);
    expect(request).toHaveBeenCalledWith("branch.autostash.list", { projectId: null });
  });
});

describe("git/commit_ai passthrough domain", () => {
  it("stageGitPaths passes the mutation contract through unchanged", async () => {
    request.mockResolvedValueOnce({ operationId: "op_1", changes: {} });
    const backend = makeBackend();
    const locator = { kind: "session" as const, sessionId: "ses_1" };
    const selections = [{ pathToken: "p", entryToken: "e" }];
    await backend.stageGitPaths(locator, "co_1", "st_1", selections);
    expect(request).toHaveBeenCalledWith("git.stage", {
      locator,
      expectedCheckoutId: "co_1",
      expectedStatusToken: "st_1",
      selections,
    });
  });

  it("resolveGitContext/getGitChanges/commitGitChanges keep the desktop contract", async () => {
    request.mockResolvedValue({});
    const backend = makeBackend();
    const locator = { kind: "projectMain" as const, projectId: "prj_1" };
    await backend.resolveGitContext(locator);
    await backend.getGitChanges(locator, false);
    await backend.commitGitChanges(locator, "co_1", "ct_1", "msg");
    expect(request).toHaveBeenNthCalledWith(1, "git.context.resolve", { locator });
    expect(request).toHaveBeenNthCalledWith(2, "git.changes", {
      locator,
      includeIgnored: false,
    });
    expect(request).toHaveBeenNthCalledWith(3, "git.commit.execute", {
      locator,
      expectedCheckoutId: "co_1",
      expectedCommitToken: "ct_1",
      message: "msg",
    });
  });

  it("saveCommitAiConfig passes provider/model/key/language through", async () => {
    request.mockResolvedValueOnce({ provider: "openai", hasApiKey: true });
    const backend = makeBackend();
    await backend.saveCommitAiConfig("openai", "https://api", "gpt", "sk-x", "zh");
    expect(request).toHaveBeenCalledWith("commit_ai.config.save", {
      provider: "openai",
      baseUrl: "https://api",
      model: "gpt",
      apiKey: "sk-x",
      language: "zh",
    });
  });
});

describe("search/history/timeline/documents/secrets/backup/export/diagnostics", () => {
  it("search omits a null limit instead of sending it", async () => {
    request.mockResolvedValueOnce({ partial: false, hits: [] });
    const backend = makeBackend();
    await backend.search("needle", null);
    expect(request).toHaveBeenCalledWith("search.global", { query: "needle" });
  });

  it("getNativeHistory and ackTimeline pass cursors and snapshots through", async () => {
    request.mockResolvedValue({});
    const backend = makeBackend();
    await backend.getNativeHistory("ses_1", "cursor-1", 50);
    await backend.ackTimeline([{ sessionId: "ses_1", statusCursor: null, logCursor: null }]);
    expect(request).toHaveBeenNthCalledWith(1, "history.page", {
      sessionId: "ses_1",
      cursor: "cursor-1",
      limit: 50,
    });
    expect(request).toHaveBeenNthCalledWith(2, "timeline.ack", {
      snapshots: [{ sessionId: "ses_1", statusCursor: null, logCursor: null }],
    });
  });

  it("document read/write/list/create pass paths through", async () => {
    request.mockResolvedValue({});
    const backend = makeBackend();
    await backend.readSessionDocument("/p/a.md");
    await backend.writeSessionDocument("/p/a.md", "body");
    await backend.listDocumentDirectory("/p");
    await backend.createDocumentEntry("/p/b", "dir");
    expect(request).toHaveBeenNthCalledWith(1, "document.read", { path: "/p/a.md" });
    expect(request).toHaveBeenNthCalledWith(2, "document.write", {
      path: "/p/a.md",
      content: "body",
    });
    expect(request).toHaveBeenNthCalledWith(3, "document.list", { path: "/p" });
    expect(request).toHaveBeenNthCalledWith(4, "document.create", {
      path: "/p/b",
      kind: "dir",
    });
  });

  it("secretStatus maps the backend status object to a label", async () => {
    request.mockResolvedValueOnce({ state: "available", backend: "keychain" });
    const backend = makeBackend();
    await expect(backend.secretStatus()).resolves.toBe("keychain");
  });

  it("secretAdd sends the write-only shape and adapts the result", async () => {
    request.mockResolvedValueOnce({ id: "sec_1", envName: "TOKEN", backend: "keychain" });
    const backend = makeBackend();
    const meta = await backend.secretAdd("pre_1", "TOKEN", "value-1");
    expect(request).toHaveBeenCalledWith("secret.add", {
      envName: "TOKEN",
      presetId: "pre_1",
      value: "value-1",
    });
    expect(meta).toEqual({ id: "sec_1", envName: "TOKEN", backend: "keychain" });
  });

  it("backupCreate maps dest to destination and drops agent/requestId", async () => {
    request.mockResolvedValueOnce({
      path: "/srv/backups/a.zip",
      files: 3,
      bytes: 10,
      verified: true,
      nativeCoverage: {},
    });
    const backend = makeBackend();
    await backend.backupCreate("claude", "/srv/backups/a.zip", "req-1");
    expect(request).toHaveBeenCalledWith("backup.create", {
      destination: "/srv/backups/a.zip",
    });
  });

  it("exportSession maps dest to destination and rejects unsupported options", async () => {
    request.mockResolvedValueOnce("/srv/out.md");
    const backend = makeBackend();
    await expect(
      backend.exportSession({
        sessionId: "ses_1",
        kind: "md",
        dest: "/srv/out.md",
        last: null,
        stripAnsi: false,
      }),
    ).resolves.toBe("/srv/out.md");
    expect(request).toHaveBeenCalledWith("export.session", {
      sessionId: "ses_1",
      kind: "md",
      destination: "/srv/out.md",
    });
    await expect(
      backend.exportSession({
        sessionId: "ses_1",
        kind: "md",
        dest: "/srv/out.md",
        last: 10,
        stripAnsi: false,
      }),
    ).rejects.toMatchObject({ featureTag: "export.options" });
    await expect(
      backend.exportSession({
        sessionId: "ses_1",
        kind: "md",
        dest: "/srv/out.md",
        last: null,
        stripAnsi: true,
      }),
    ).rejects.toMatchObject({ featureTag: "export.options" });
  });

  it("diagHosts passes the remote host list through", async () => {
    request.mockResolvedValueOnce([{ sessionId: "ses_1", alive: true }]);
    const backend = makeBackend();
    await expect(backend.diagHosts()).resolves.toEqual([
      { sessionId: "ses_1", alive: true },
    ]);
    expect(request).toHaveBeenCalledWith("diagnostics.hosts", {});
  });
});

describe("REMOTE_UNAVAILABLE surface", () => {
  const cases: [string, (backend: RemoteBackend) => Promise<unknown>, string][] = [
    ["renameDocumentEntry", (b) => b.renameDocumentEntry(), "document.rename"],
    ["duplicateDocumentEntry", (b) => b.duplicateDocumentEntry(), "document.duplicate"],
    ["deleteDocumentEntry", (b) => b.deleteDocumentEntry(), "document.delete"],
    ["backupRestore", (b) => b.backupRestore(), "backup.restore"],
    ["revealInFileManager", (b) => b.revealInFileManager(), "os.revealInFileManager"],
    ["openInSystemTerminal", (b) => b.openInSystemTerminal(), "os.openInSystemTerminal"],
    ["openInVsCode", (b) => b.openInVsCode(), "os.openInVsCode"],
    ["openWithDefaultApp", (b) => b.openWithDefaultApp(), "os.openWithDefaultApp"],
    [
      "rollbackNotificationSetup",
      (b) => b.rollbackNotificationSetup("claude"),
      "notification.rollback",
    ],
  ];

  for (const [name, call, tag] of cases) {
    it(`${name} rejects with the stable feature tag ${tag}`, async () => {
      const backend = makeBackend();
      const error = await call(backend).catch((value: unknown) => value);
      expect(isRemoteUnavailableError(error)).toBe(true);
      expect((error as RemoteUnavailableError).featureTag).toBe(tag);
    });
  }
});

describe("ROUTING table", () => {
  it("keeps the three lists disjoint", () => {
    const local = new Set<string>(ROUTING.localOnly);
    const unavailable = new Set<string>(ROUTING.remoteUnavailable);
    const capable = new Set<string>(ROUTING.remoteCapable);
    for (const name of local) {
      expect(unavailable.has(name)).toBe(false);
      expect(capable.has(name)).toBe(false);
    }
    for (const name of unavailable) {
      expect(capable.has(name)).toBe(false);
    }
  });

  it("classifies settings/updater/notification routing as local-only", () => {
    for (const name of [
      "getSettings",
      "saveSettings",
      "updateStatus",
      "updateCheck",
      "updateDownload",
      "updateInstall",
      "setNotificationSession",
      "takePendingNotificationSession",
      "notifyTest",
    ]) {
      expect(ROUTING.localOnly).toContain(name);
    }
  });

  it("keeps markSessionLogRendered advertised unavailable yet callable as a no-op", async () => {
    expect(ROUTING.remoteUnavailable).toContain("markSessionLogRendered");
    const backend = makeBackend();
    await expect(
      backend.markSessionLogRendered("ses_1", 1, {
        runId: "r",
        runOrdinal: 1,
        generation: 0,
        offset: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("request hook (remote sync mutation hints)", () => {
  it("reports settled requests with method and success until cleared", async () => {
    const backend = makeBackend();
    const hook = vi.fn();
    backend.setRequestHook(hook);
    request.mockResolvedValueOnce({ projects: [], sessions: [] });
    await backend.boot();
    expect(hook).toHaveBeenLastCalledWith("boot", true);

    request.mockRejectedValueOnce(new Error("boom"));
    await expect(backend.boot()).rejects.toThrow("boom");
    expect(hook).toHaveBeenLastCalledWith("boot", false);

    backend.setRequestHook(null);
    request.mockResolvedValueOnce({ projects: [], sessions: [] });
    await backend.boot();
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
