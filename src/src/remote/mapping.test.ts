import { describe, expect, it } from "vitest";
import {
  assembleProjectView,
  logCursorToRunCursor,
  remoteAttachResultToRemoteAttachInfo,
  remoteLaunchToCreateSessionResult,
  remoteLaunchToRestartResult,
  remotePresetToPreset,
  remoteProbeToProbeOutcome,
  remoteSecretStatusToBackendString,
  remoteSecretSummaryToSecretMeta,
  remoteStatusToStatusEventView,
  remoteSessionToSessionView,
  remoteSummaryToArchivedSessionView,
  remoteSupportedAgentToSupportedAgent,
  remoteWorktreeRemoveToDestructiveOutcome,
  remoteWorktreeToWorktreeView,
  runCursorToLogCursor,
  statusCursorOf,
} from "./mapping";
import type {
  RemoteProjectSummary,
  RemoteSessionAttachResult,
  RemoteSessionSummary,
} from "./types";

const STATUS = {
  runId: "run-1",
  runOrdinal: 2,
  sequence: 7,
  state: "needs_input" as const,
  source: "hook" as const,
  confidence: "high" as const,
  occurredAt: "2026-09-23T01:00:00Z",
};

const SESSION: RemoteSessionSummary = {
  id: "ses_1",
  projectId: "prj_1",
  worktreeId: null,
  presetId: "pre_1",
  title: "Build",
  cwd: "/srv/app",
  lifecycle: "running",
  agentSessionId: "agent-1",
  resumePrecision: "exact",
  adapterType: "claude",
  transport: "pty",
  permissionMode: "auto",
  pinnedAt: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
  archivedAt: null,
  latestStatus: STATUS,
  hostAlive: true,
  latestAttentionKind: "approval_requested",
  unreadAttention: true,
};

const PROJECT: RemoteProjectSummary = {
  id: "prj_1",
  name: "App",
  rootPath: "/srv/app",
  gitRootPath: "/srv/app",
  createdAt: "2026-09-01T00:00:00Z",
  pinned: true,
  sortOrder: 0,
};

describe("cursor adapters", () => {
  it("upgrades a LogCursorView to a RunCursor with a synthesized zero status sequence", () => {
    expect(
      logCursorToRunCursor({ runId: "r", runOrdinal: 1, generation: 2, offset: 99 }),
    ).toEqual({ runId: "r", runOrdinal: 1, generation: 2, offset: 99, statusSequence: 0 });
  });

  it("round-trips RunCursor → LogCursorView dropping statusSequence", () => {
    const run = logCursorToRunCursor(
      { runId: "r", runOrdinal: 3, generation: 0, offset: 5 },
      42,
    );
    expect(runCursorToLogCursor(run)).toEqual({
      runId: "r",
      runOrdinal: 3,
      generation: 0,
      offset: 5,
    });
  });

  it("builds a StatusCursor from any status-shaped object", () => {
    expect(statusCursorOf(STATUS)).toEqual({ runId: "run-1", runOrdinal: 2, sequence: 7 });
  });
});

describe("session/project mapping", () => {
  it("maps SessionSummary to SessionView with desktop field names", () => {
    const view = remoteSessionToSessionView(SESSION, null);
    expect(view).toMatchObject({
      id: "ses_1",
      projectId: "prj_1",
      adapter: "claude",
      hostAlive: true,
      unread: true,
      transport: "pty",
      permissionMode: "auto",
    });
    expect(view.status).toMatchObject({
      sessionId: "ses_1",
      runId: "run-1",
      sequence: 7,
      state: "needs_input",
      evidence: null,
      logCursor: null,
    });
  });

  it("treats the active session as seen and survives a null status", () => {
    expect(remoteSessionToSessionView(SESSION, "ses_1").unread).toBe(false);
    expect(
      remoteSessionToSessionView({ ...SESSION, latestStatus: null }, null).status,
    ).toBeNull();
  });

  it("maps StatusSummary to StatusEventView with explicit metadata nulls", () => {
    expect(remoteStatusToStatusEventView("ses_9", STATUS)).toEqual({
      sessionId: "ses_9",
      runId: "run-1",
      runOrdinal: 2,
      sequence: 7,
      state: "needs_input",
      source: "hook",
      confidence: "high",
      evidence: null,
      logCursor: null,
      occurredAt: "2026-09-23T01:00:00Z",
    });
  });

  it("assembles a nested ProjectView from flat summaries", () => {
    const session = remoteSessionToSessionView(SESSION, null);
    const worktree = remoteWorktreeToWorktreeView({
      id: "wt_1",
      projectId: "prj_1",
      branch: "feature/x",
      baseCommit: "abc",
      path: "/srv/app-x",
      health: "clean",
      createdAt: "2026-09-10T00:00:00Z",
    });
    expect(worktree.baseRef).toBeNull();
    const view = assembleProjectView(PROJECT, [session], [worktree]);
    expect(view).toMatchObject({
      id: "prj_1",
      name: "App",
      pinned: true,
      sessions: [session],
      worktrees: [worktree],
    });
  });

  it("maps archived summaries with a joined project name", () => {
    const view = remoteSummaryToArchivedSessionView(
      { ...SESSION, archivedAt: "2026-09-22T10:00:00Z" },
      "App",
    );
    expect(view).toEqual({
      id: "ses_1",
      projectId: "prj_1",
      projectName: "App",
      title: "Build",
      adapter: "claude",
      createdAt: "2026-09-20T00:00:00Z",
      archivedAt: "2026-09-22T10:00:00Z",
    });
  });
});

describe("attach/launch mapping", () => {
  const ATTACH: RemoteSessionAttachResult = {
    attachmentId: "att-abc",
    sessionId: "ses_1",
    childAlive: true,
    agentSessionId: null,
    cursor: { runId: "r", runOrdinal: 1, generation: 0, offset: 64, statusSequence: 3 },
    features: ["input_batch_v1"],
    runId: "r",
    runOrdinal: 1,
    terminalGeometry: null,
    screenSnapshot: { kind: "terminal_snapshot_v1" },
  };

  it("maps the attach result, downgrading the RunCursor and marking remote facts null", () => {
    const info = remoteAttachResultToRemoteAttachInfo(ATTACH);
    expect(info).toMatchObject({
      remote: true,
      attachmentId: "att-abc",
      sessionId: "ses_1",
      hostPid: null,
      protocol: null,
      logBytes: null,
      status: null,
      logCursor: { runId: "r", runOrdinal: 1, generation: 0, offset: 64 },
      features: ["input_batch_v1"],
    });
  });

  it("keeps a null cursor null (tail replay without explicit resume)", () => {
    expect(
      remoteAttachResultToRemoteAttachInfo({ ...ATTACH, cursor: null }).logCursor,
    ).toBeNull();
  });

  it("maps launch results into create/restart shapes without local-only facts", () => {
    const launch = {
      sessionId: "ses_2",
      resumePrecision: "exact" as const,
      agentSessionId: "agent-2",
      notices: [{ code: "preset_args_ignored", message: "ignored" }],
    };
    expect(remoteLaunchToCreateSessionResult(launch)).toEqual({
      id: "ses_2",
      attach: { hostPid: 0, childAlive: true },
      resumePrecision: "exact",
      agentSessionId: "agent-2",
      notes: [],
      notices: [{ code: "preset_args_ignored", message: "ignored" }],
      command: [],
    });
    expect(remoteLaunchToRestartResult(launch)).toEqual({
      resumePrecision: "exact",
      agentSessionId: "agent-2",
      notes: [],
      notices: [{ code: "preset_args_ignored", message: "ignored" }],
      hostPid: 0,
    });
  });
});

describe("agents/presets/secrets/misc mapping", () => {
  it("maps probe results including the reasonMessage envelope", () => {
    const outcome = remoteProbeToProbeOutcome({
      agent: "codex",
      displayName: "Codex",
      state: "unavailable",
      reason: "not found",
      reasonCode: "cli_missing",
      reasonDetail: "searched PATH",
      install: null,
      candidates: [],
      notificationSetup: null,
    });
    expect(outcome.reasonMessage).toEqual({
      code: "cli_missing",
      technicalDetail: "searched PATH",
      message: "not found",
    });
    expect(outcome.install).toBeNull();
  });

  it("omits reasonMessage when no reasonCode is present", () => {
    const outcome = remoteProbeToProbeOutcome({
      agent: "codex",
      displayName: "Codex",
      state: "available",
      reason: null,
      reasonCode: null,
      reasonDetail: null,
      install: null,
      candidates: [],
      notificationSetup: null,
    });
    expect(outcome.reasonMessage).toBeNull();
  });

  it("maps supported agents and presets with honest defaults for missing fields", () => {
    expect(
      remoteSupportedAgentToSupportedAgent({
        agent: "pi",
        displayName: "Pi",
        commandNames: ["pi"],
        install: null,
        notificationSetup: null,
      }),
    ).toEqual({ agent: "pi", displayName: "Pi", commandNames: ["pi"] });

    expect(
      remotePresetToPreset({
        id: "pre_1",
        agent: "claude",
        name: "Default",
        executablePath: "/usr/bin/claude",
        permissionMode: "auto",
        envNames: ["ANTHROPIC_API_KEY"],
        secretRefIds: ["sec_1"],
        builtIn: true,
      }),
    ).toMatchObject({ id: "pre_1", agentType: "claude", args: [], builtIn: true });
  });

  it("maps secret status/list/add shapes", () => {
    expect(
      remoteSecretStatusToBackendString({ state: "available", backend: "keychain" }),
    ).toBe("keychain");
    expect(
      remoteSecretStatusToBackendString({ state: "unavailable", backend: null }),
    ).toBe("unavailable");
    expect(
      remoteSecretSummaryToSecretMeta({
        id: "sec_1",
        envName: "TOKEN",
        backend: "keychain",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
    ).toMatchObject({ id: "sec_1", envName: "TOKEN", backend: "keychain" });
  });

  it("drops native cleanup warnings from destructive outcomes", () => {
    expect(
      remoteWorktreeRemoveToDestructiveOutcome({
        stopWarnings: 1,
        cleanupWarnings: 2,
        nativeCleanupWarnings: 3,
      }),
    ).toEqual({ stopWarnings: 1, cleanupWarnings: 2 });
  });
});
