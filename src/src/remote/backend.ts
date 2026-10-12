// RemoteBackend: mirrors the remote-capable subset of ../api.ts over the
// AgentPort remote protocol. Same function names/signatures so the T-005
// dispatcher can route by active device without touching call sites.
// New desktop code.

import type {
  AddProjectResult,
  ArchivedSessionView,
  AutoStashRecord,
  BranchOperationResult,
  CommitAiConfig,
  CommitAiLanguage,
  CommitAiProvider,
  ConfirmedArchivedSession,
  CreateSessionResult,
  CreateWorktreeResult,
  DestructiveRemovalOutcome,
  DocumentDirListing,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
  GitCommitDetail,
  GitCommitMessageSuggestion,
  GitCommitPatch,
  GitCommitResult,
  GitCommitReview,
  GitContextLocator,
  GitDiffSide,
  GitFileDiff,
  GitHistoryPage,
  GitIgnoreTarget,
  GitMutationResult,
  GitPathSelection,
  GitRemoteAction,
  GitResolvedFile,
  HistoryPage,
  HostInfo,
  LegacyDeleteReport,
  LegacyLogInventory,
  LocalBranchesResponse,
  LogCursorView,
  NotificationSetup,
  Preset,
  ProbeOutcome,
  ProjectLayoutEntry,
  ProjectRemovalPreflight,
  ProjectView,
  RepositoryStatus,
  RestartResult,
  SearchResult,
  SecretMeta,
  SessionDocument,
  StatusCursorView,
  StatusEventView,
  SupportedAgent,
  TimelineAckSnapshot,
  TimelineData,
  WorktreeBranchMode,
  WorktreeDeletePreflight,
  WorktreePreview,
  WorktreeStatus,
  WorktreeView,
} from "../types";
import type {
  BackupCreateResult,
  BackupVerifyResult,
  CreateSessionArgs,
  ExportArgs,
  ResizePtyAuthority,
} from "../api";
import type { ChannelMsg } from "../types";
import { RemoteClient } from "./client";
import { remoteEventToChannelMsg } from "./events";
import type { ChannelLike, RemoteEventWire } from "./types";
import {
  RemoteRequestError,
  RemoteUnavailableError,
} from "./errors";
import {
  assembleProjectView,
  logCursorToRunCursor,
  remoteAttachResultToRemoteAttachInfo,
  remoteLaunchToCreateSessionResult,
  remoteLaunchToRestartResult,
  remotePresetToPreset,
  remoteProbeToProbeOutcome,
  remoteSecretAddResultToSecretMeta,
  remoteSecretStatusToBackendString,
  remoteSecretSummaryToSecretMeta,
  remoteStatusToStatusEventView,
  remoteSessionToSessionView,
  remoteSummaryToArchivedSessionView,
  remoteSupportedAgentToSupportedAgent,
  remoteWorktreeRemoveToDestructiveOutcome,
  remoteWorktreeToWorktreeView,
  statusCursorOf,
  type RemoteAttachInfo,
} from "./mapping";
import type {
  RemoteAttentionPollResult,
  RemoteBootSnapshot,
  RemoteProjectAddResult,
  RemoteProjectSummary,
  RemoteSecretBackendStatus,
  RemoteSecretSummary,
  RemoteSessionAttachResult,
  RemoteSessionLaunchResult,
  RemoteSessionPollResult,
  RemoteSessionSummary,
  RemoteStatusSummary,
  RemoteSupportedAgentSummary,
  RemoteAgentProbeResult,
  RemotePresetSummary,
  RemoteSessionControlResult,
  RemoteSessionInputResult,
  RemoteSessionStopResult,
  RemoteWorktreeRemoveResult,
  RemoteWorktreeSummary,
} from "./types";
import type { AttentionCursor } from "./types";
import {
  remoteBranchSnapshotToRepositoryStatus,
  type RemoteBranchSnapshot,
} from "./repositoryStatus";

/** terminal.geometry_v1 gates revisioned resize metadata on the bridge. */
const CAPABILITY_TERMINAL_GEOMETRY = "terminal.geometry_v1";

/** Bound on pre-registration event buffering per attachment (see RemoteBackend). */
const MAX_PENDING_ATTACHMENT_EVENTS = 4096;

/**
 * api.ts routing table for the T-005 dispatcher.
 * - localOnly: manage the local app or local OS; always invoke locally,
 *   regardless of the active device (settings/updater stay local by product
 *   decision; notification routing targets this Mac; pickers pick local paths).
 * - remoteCapable: implemented by RemoteBackend over the protocol.
 * - remoteUnavailable: meaningful against the active device but not covered
 *   by the protocol (or with unsafe remote semantics); UI gates these.
 * Note: desktop_relay_* (phone pairing) is not part of api.ts; it is local
 * by construction and therefore absent here.
 */
export const ROUTING = {
  localOnly: [
    "getSettings",
    "saveSettings",
    "updateStatus",
    "updateCheck",
    "updateDownload",
    "updateInstall",
    "openExternalUrl",
    "pickDirectory",
    "pickSavePath",
    "pickFile",
    "setNotificationSession",
    "takePendingNotificationSession",
    "notifyTest",
  ],
  remoteUnavailable: [
    "markSessionLogRendered",
    "renameDocumentEntry",
    "duplicateDocumentEntry",
    "deleteDocumentEntry",
    "rollbackNotificationSetup",
    "backupRestore",
    "revealInFileManager",
    "openInSystemTerminal",
    "openInVsCode",
    "openWithDefaultApp",
  ],
  remoteCapable: [
    "boot",
    "listProjects",
    "probeAgents",
    "probeAgent",
    "listSupportedAgents",
    "notificationSetups",
    "addProject",
    "renameProject",
    "setProjectLayout",
    "removeProject",
    "projectRemovePreflight",
    "deleteProjectArchivedSessions",
    "listPresets",
    "createSession",
    "attachSession",
    "detachSession",
    "markSessionSeen",
    "markSessionOutputUnread",
    "sendInput",
    "sendStructuredPrompt",
    "abortStructuredTurn",
    "autoRenameSessionFromFirstInput",
    "resizePty",
    "stopSession",
    "interruptSession",
    "resumeSession",
    "restartSession",
    "renameSession",
    "setSessionPinned",
    "archiveSession",
    "listArchivedSessions",
    "unarchiveSession",
    "deleteArchivedSession",
    "deleteAllArchivedSessions",
    "sessionHistory",
    "previewWorktree",
    "reconcileWorktrees",
    "createWorktree",
    "listWorktrees",
    "removeWorktree",
    "worktreeDeletePreflight",
    "worktreeStatusText",
    "getRepositoryStatus",
    "listLocalBranches",
    "createLocalBranch",
    "createAndSwitchLocalBranch",
    "switchLocalBranch",
    "deleteLocalBranch",
    "listAutoStashes",
    "restoreAutoStash",
    "cleanupAutoStash",
    "resolveGitContext",
    "adoptCurrentGitWorktreeBranch",
    "getGitChanges",
    "getGitDiff",
    "getGitHistory",
    "getGitCommitDetail",
    "getGitCommitDiff",
    "stageGitPaths",
    "unstageGitPaths",
    "discardGitPaths",
    "addGitIgnore",
    "trashGitPath",
    "resolveGitFile",
    "syncGitRemote",
    "generateGitCommitMessage",
    "prepareGitCommit",
    "commitGitChanges",
    "exportSession",
    "backupCreate",
    "backupList",
    "backupVerify",
    "search",
    "getNativeHistory",
    "getLegacyLogInventory",
    "deleteLegacyLogs",
    "rebuildSearchIndex",
    "getTimeline",
    "ackTimeline",
    "getCommitAiConfig",
    "saveCommitAiConfig",
    "clearCommitAiApiKey",
    "diagHosts",
    "diagSummary",
    "diagCapabilities",
    "secretStatus",
    "secretAdd",
    "secretList",
    "secretDelete",
    "readSessionDocument",
    "writeSessionDocument",
    "listDocumentDirectory",
    "createDocumentEntry",
  ],
} as const;

export type RemoteCapableFn = (typeof ROUTING.remoteCapable)[number];

export class RemoteBackend {
  readonly client: RemoteClient;

  /** sessionId → server-issued attachmentId for input/control routing. */
  private readonly attachments = new Map<string, string>();
  /** attachmentId → renderer consumer of synthesized ChannelMsg messages. */
  private readonly attachmentListeners = new Map<
    string,
    (message: ChannelMsg) => void
  >();
  /**
   * Events that arrived before their attachment listener registered (the
   * attach invoke result and the subscription stream are not ordered against
   * each other). Bounded; flushed in order on registration.
   */
  private readonly pendingAttachmentEvents = new Map<
    string,
    RemoteEventWire[]
  >();
  private batchCounter = 0;
  /** Optional observer for settled requests (remote sync engine mutation
   * hints). Invoked with the method name and success flag; never blocks the
   * request result. */
  private requestHook: ((method: string, ok: boolean) => void) | null = null;

  constructor(client: RemoteClient) {
    this.client = client;
    this.client.addEventListener((event) => this.routeAttachmentEvent(event));
  }

  /** Install/replace the request observer (null clears). */
  setRequestHook(hook: ((method: string, ok: boolean) => void) | null): void {
    this.requestHook = hook;
  }

  private async request<T>(method: string, params: unknown = {}): Promise<T> {
    try {
      const value = await this.client.request<T>(method, params);
      this.requestHook?.(method, true);
      return value;
    } catch (error) {
      this.requestHook?.(method, false);
      throw error;
    }
  }

  private attachmentFor(sessionId: string): string {
    const attachmentId = this.attachments.get(sessionId);
    if (!attachmentId) {
      throw new RemoteRequestError(
        "no_attachment",
        `session ${sessionId} has no remote attachment`,
      );
    }
    return attachmentId;
  }

  private nextBatchId(): string {
    this.batchCounter += 1;
    return `web-${this.client.deviceId}-${this.batchCounter}`;
  }

  /** Test/T-008 hook: current attachment for a session, if any. */
  attachmentIdFor(sessionId: string): string | null {
    return this.attachments.get(sessionId) ?? null;
  }

  // -----------------------------------------------------------------------
  // attachment event routing (subscription stream → ChannelMsg consumers)
  // -----------------------------------------------------------------------

  /**
   * Register the consumer for one server attachment. Events that arrived
   * before registration flush first, in stream order. Returns an unregister
   * function; unregistration also discards any still-pending events.
   */
  registerAttachmentListener(
    attachmentId: string,
    listener: (message: ChannelMsg) => void,
  ): () => void {
    this.attachmentListeners.set(attachmentId, listener);
    const pending = this.pendingAttachmentEvents.get(attachmentId);
    if (pending) {
      this.pendingAttachmentEvents.delete(attachmentId);
      for (const event of pending) this.deliverAttachmentEvent(event);
    }
    return () => {
      if (this.attachmentListeners.get(attachmentId) === listener) {
        this.attachmentListeners.delete(attachmentId);
      }
      this.pendingAttachmentEvents.delete(attachmentId);
    };
  }

  private routeAttachmentEvent(event: RemoteEventWire): void {
    if (event.eventType === "transport_closed") {
      // Connection-scoped: every live attachment loses its stream. Mirror the
      // local watch_loop EOF so each renderer runs its own retry path.
      this.client.markFailed();
      const payload = (event.payload ?? {}) as { reason?: string };
      const message: ChannelMsg = {
        t: "detached",
        code: "transport_closed",
        message: typeof payload.reason === "string" ? payload.reason : "",
      };
      const listeners = [...this.attachmentListeners.values()];
      this.attachmentListeners.clear();
      this.pendingAttachmentEvents.clear();
      for (const listener of listeners) listener(message);
      return;
    }
    const subscriptionId = event.subscriptionId;
    if (!subscriptionId) return;
    if (this.attachmentListeners.has(subscriptionId)) {
      this.deliverAttachmentEvent(event);
      return;
    }
    const pending = this.pendingAttachmentEvents.get(subscriptionId) ?? [];
    if (pending.length < MAX_PENDING_ATTACHMENT_EVENTS) {
      pending.push(event);
      this.pendingAttachmentEvents.set(subscriptionId, pending);
    }
    // Overflow: the renderer never registered (attach failed/cancelled); the
    // queue is dropped with the attachment listener on cleanup.
  }

  private deliverAttachmentEvent(event: RemoteEventWire): void {
    const listener = this.attachmentListeners.get(event.subscriptionId);
    if (!listener) return;
    const message = remoteEventToChannelMsg(event);
    if (message) listener(message);
  }

  // -----------------------------------------------------------------------
  // boot / projects / agents
  // -----------------------------------------------------------------------

  /** Raw remote boot snapshot; T-006 composes the desktop BootInfo from it. */
  boot(): Promise<RemoteBootSnapshot> {
    return this.request<RemoteBootSnapshot>("boot");
  }

  async listProjects(activeSession: string | null): Promise<ProjectView[]> {
    const [projects, sessions] = await Promise.all([
      this.request<RemoteProjectSummary[]>("project.list"),
      this.request<RemoteSessionSummary[]>("session.list"),
    ]);
    const summariesByProject = new Map<string, RemoteSessionSummary[]>();
    for (const session of sessions) {
      if (session.archivedAt) continue;
      const list = summariesByProject.get(session.projectId) ?? [];
      list.push(session);
      summariesByProject.set(session.projectId, list);
    }
    // Worktrees are per-project calls on the wire; bound the fan-out so a
    // large remote layout does not burst the connection.
    const views: ProjectView[] = [];
    for (const project of projects) {
      const worktreeSummaries = await this.request<RemoteWorktreeSummary[]>(
        "worktree.list",
        { projectId: project.id },
      );
      const sessionViews = (summariesByProject.get(project.id) ?? []).map(
        (summary) => remoteSessionToSessionView(summary, activeSession),
      );
      views.push(
        assembleProjectView(
          project,
          sessionViews,
          worktreeSummaries.map(remoteWorktreeToWorktreeView),
        ),
      );
    }
    return views;
  }

  async probeAgents(preserveSelections = false): Promise<ProbeOutcome[]> {
    const results = await this.request<RemoteAgentProbeResult[]>(
      "agent.probe_all",
      { preserveSelections },
    );
    return results.map(remoteProbeToProbeOutcome);
  }

  async probeAgent(agent: string, path: string | null): Promise<ProbeOutcome> {
    const result = await this.request<RemoteAgentProbeResult>("agent.probe", {
      agent,
      path,
    });
    return remoteProbeToProbeOutcome(result);
  }

  async listSupportedAgents(): Promise<SupportedAgent[]> {
    const summaries = await this.request<RemoteSupportedAgentSummary[]>(
      "agent.supported",
    );
    return summaries.map(remoteSupportedAgentToSupportedAgent);
  }

  /**
   * Read-only projection of agent.supported.notificationSetup. The remote
   * service may omit setups for some agents; only reported entries appear.
   */
  async notificationSetups(): Promise<NotificationSetup[]> {
    const summaries = await this.request<RemoteSupportedAgentSummary[]>(
      "agent.supported",
    );
    return summaries
      .map((summary) => summary.notificationSetup as NotificationSetup | null)
      .filter((setup): setup is NotificationSetup => setup !== null);
  }

  rollbackNotificationSetup(_agent: string): Promise<NotificationSetup> {
    return Promise.reject(new RemoteUnavailableError("notification.rollback"));
  }

  addProject(path: string, name: string | null): Promise<AddProjectResult> {
    return this.request<RemoteProjectAddResult>("project.add", { path, name }).then(
      (result) => ({
        id: result.project.id,
        name: result.project.name,
        rootPath: result.project.rootPath,
        gitRootPath: result.project.gitRootPath,
        focusedExisting: result.focusedExisting,
      }),
    );
  }

  renameProject(id: string, name: string): Promise<void> {
    return this.request<void>("project.rename", { projectId: id, name });
  }

  async setProjectLayout(
    entries: ProjectLayoutEntry[],
    activeSession: string | null,
  ): Promise<ProjectView[]> {
    await this.request<void>("project.layout.replace", {
      entries: entries.map((entry) => ({ projectId: entry.id, pinned: entry.pinned })),
    });
    return this.listProjects(activeSession);
  }

  async removeProject(
    preflight: ProjectRemovalPreflight,
  ): Promise<DestructiveRemovalOutcome> {
    const result = await this.request<RemoteWorktreeRemoveResult>(
      "project.remove",
      {
        projectId: preflight.projectId,
        revision: preflight.revision,
        sessions: preflight.sessions.map((session) => ({
          sessionId: session.id,
          archiveGeneration: session.archiveGeneration,
          archived: session.archived,
        })),
        worktreeIds: preflight.worktreeIds,
        recoverableOperationIds: preflight.recoverableOperationIds,
        pendingCommitOperationIds: preflight.pendingCommitOperationIds,
      },
    );
    return remoteWorktreeRemoveToDestructiveOutcome(result);
  }

  projectRemovePreflight(id: string): Promise<ProjectRemovalPreflight> {
    return this.request<ProjectRemovalPreflight>("project.remove.preflight", {
      projectId: id,
    });
  }

  /**
   * No generation fencing exists on the remote archives.delete path; delete
   * each confirmed archive sequentially instead (mapping-table gap).
   */
  async deleteProjectArchivedSessions(
    _projectId: string,
    sessions: ConfirmedArchivedSession[],
  ): Promise<void> {
    for (const session of sessions) {
      await this.request<void>("session.archives.delete", { sessionId: session.id });
    }
  }

  async listPresets(agent: string | null): Promise<Preset[]> {
    const presets = await this.request<RemotePresetSummary[]>("preset.list", {
      agent,
    });
    return presets.map(remotePresetToPreset);
  }

  // -----------------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------------

  async createSession(args: CreateSessionArgs): Promise<CreateSessionResult> {
    const result = await this.request<RemoteSessionLaunchResult>(
      "session.create",
      args,
    );
    return remoteLaunchToCreateSessionResult(result);
  }

  /**
   * Attaches and, when a Channel-like object is passed (the desktop attach
   * path always passes one), routes this attachment's subscription events
   * into `channel.onmessage` as synthesized ChannelMsg messages — the same
   * entry point the local Tauri Channel feeds, so veil/replay/parser/render
   * boundaries behave identically on both devices. Events arriving before
   * this call returns are buffered per attachment and flushed on wiring.
   */
  async attachSession(
    sessionId: string,
    replayTailBytes: number,
    channel?: ChannelLike<ChannelMsg>,
    resumeFrom: LogCursorView | null = null,
    screenSnapshot = false,
  ): Promise<RemoteAttachInfo> {
    const result = await this.request<RemoteSessionAttachResult>(
      "session.attach",
      {
        sessionId,
        replayTailBytes,
        resumeFrom: resumeFrom ? logCursorToRunCursor(resumeFrom) : null,
        subscribeOutput: true,
        screenSnapshot,
      },
    );
    this.attachments.set(sessionId, result.attachmentId);
    if (channel && typeof channel.onmessage === "function") {
      this.registerAttachmentListener(result.attachmentId, (message) =>
        channel.onmessage(message),
      );
    }
    return remoteAttachResultToRemoteAttachInfo(result);
  }

  async detachSession(sessionId: string, attachmentId: number | string): Promise<void> {
    const wireId = String(attachmentId);
    try {
      await this.request<void>("session.detach", { attachmentId: wireId });
    } finally {
      this.attachmentListeners.delete(wireId);
      this.pendingAttachmentEvents.delete(wireId);
      if (this.attachments.get(sessionId) === wireId) {
        this.attachments.delete(sessionId);
      }
    }
  }

  /**
   * Remote seen.mark requires an explicit cursor. With a null cursor (the
   * desktop "mark latest seen" form) resolve the session's latest status from
   * session.list; a session without any status has nothing to mark.
   */
  async markSessionSeen(
    sessionId: string,
    cursor: StatusCursorView | null = null,
  ): Promise<void> {
    let target = cursor;
    if (!target) {
      const summaries = await this.request<RemoteSessionSummary[]>("session.list");
      const summary = summaries.find((item) => item.id === sessionId);
      if (!summary?.latestStatus) return;
      target = summary.latestStatus;
    }
    await this.request<void>("session.seen.mark", {
      sessionId,
      cursor: statusCursorOf(target),
    });
  }

  /**
   * No-op by design: the renderer→Host rendered-cursor feedback has no remote
   * method. Kept callable (instead of throwing) because terminals.ts invokes
   * it on a hot render path; the ROUTING table still advertises the feature
   * as unavailable for UI gating.
   */
  markSessionLogRendered(
    _sessionId: string,
    _attachmentId: number | string,
    _cursor: LogCursorView,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The remote needs a full RunCursor; the desktop offset-only form is not
   * expressible and throws an explicit degradation error instead.
   */
  async markSessionOutputUnread(
    sessionId: string,
    _offset: number,
    cursor: LogCursorView | null = null,
  ): Promise<void> {
    if (!cursor) {
      throw new RemoteUnavailableError("session.outputUnreadCursor");
    }
    await this.request<void>("session.output.unread.mark", {
      sessionId,
      cursor: logCursorToRunCursor(cursor),
    });
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const result = await this.request<RemoteSessionInputResult>(
      "session.input",
      {
        attachmentId: this.attachmentFor(sessionId),
        batchId: this.nextBatchId(),
        dataBase64: data,
      },
    );
    if (result && result.phase === "not_executed") {
      throw new RemoteRequestError(
        "input_not_executed",
        `input batch ${result.batchId} was not executed by the remote host`,
        "not_executed",
      );
    }
  }

  async sendStructuredPrompt(sessionId: string, text: string): Promise<void> {
    await this.request<void>("session.structured_input", {
      attachmentId: this.attachmentFor(sessionId),
      text,
    });
  }

  async abortStructuredTurn(sessionId: string): Promise<void> {
    await this.request<void>("session.turn.abort", {
      attachmentId: this.attachmentFor(sessionId),
    });
  }

  autoRenameSessionFromFirstInput(sessionId: string, input: string): Promise<boolean> {
    return this.request<boolean>("session.auto_title", { sessionId, input });
  }

  /**
   * Pixel dimensions are dropped (the remote resize carries cols/rows only).
   * Revision/source metadata is sent only when the terminal.geometry_v1
   * capability was negotiated; otherwise the resize degrades to legacy form
   * because the bridge rejects unexpected revisions without it.
   */
  async resizePty(
    sessionId: string,
    cols: number,
    rows: number,
    _pixelWidth: number,
    _pixelHeight: number,
    authority?: ResizePtyAuthority,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      attachmentId: this.attachmentFor(sessionId),
      control: "resize",
      cols,
      rows,
    };
    if (authority && this.client.hasCapability(CAPABILITY_TERMINAL_GEOMETRY)) {
      params.expectedRevision = authority.expectedRevision;
      params.sourceKind = authority.sourceKind;
      if (authority.sourceDeviceId != null) {
        params.sourceDeviceId = authority.sourceDeviceId;
      }
      if (authority.orientation != null) {
        params.orientation = authority.orientation;
      }
    }
    await this.request<RemoteSessionControlResult>("session.control", params);
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.request<void>("session.control", {
      attachmentId: this.attachmentFor(sessionId),
      control: "interrupt",
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.request<void>("session.control", {
      attachmentId: this.attachmentFor(sessionId),
      control: "continue",
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request<RemoteSessionStopResult>("session.stop", { sessionId });
  }

  async restartSession(sessionId: string, riskAck: boolean): Promise<RestartResult> {
    const result = await this.request<RemoteSessionLaunchResult>(
      "session.restart",
      { sessionId, riskAck },
    );
    return remoteLaunchToRestartResult(result);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.request<void>("session.rename", { sessionId, title });
  }

  setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
    return this.request<void>("session.pin", { sessionId, pinned });
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.request<void>("session.archive", { sessionId });
  }

  unarchiveSession(sessionId: string): Promise<void> {
    return this.request<void>("session.unarchive", { sessionId });
  }

  async listArchivedSessions(): Promise<ArchivedSessionView[]> {
    const [summaries, projects] = await Promise.all([
      this.request<RemoteSessionSummary[]>("session.archives.list"),
      this.request<RemoteProjectSummary[]>("project.list"),
    ]);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return summaries.map((summary) =>
      remoteSummaryToArchivedSessionView(summary, names.get(summary.projectId) ?? ""),
    );
  }

  deleteArchivedSession(sessionId: string): Promise<void> {
    return this.request<void>("session.archives.delete", { sessionId });
  }

  deleteAllArchivedSessions(): Promise<void> {
    return this.request<void>("session.archives.delete_all");
  }

  async sessionHistory(sessionId: string): Promise<StatusEventView[]> {
    const history = await this.request<RemoteStatusSummary[]>(
      "session.status.history",
      { sessionId },
    );
    return history.map((status) => remoteStatusToStatusEventView(sessionId, status));
  }

  // -----------------------------------------------------------------------
  // worktrees
  // -----------------------------------------------------------------------

  previewWorktree(projectId: string, task: string): Promise<WorktreePreview> {
    return this.request<WorktreePreview>("worktree.preview", { projectId, task });
  }

  reconcileWorktrees(projectId: string): Promise<number> {
    return this.request<number>("worktree.reconcile", { projectId });
  }

  async createWorktree(
    projectId: string,
    task: string,
    baseRef: string | null,
    branch: string | null,
    branchMode: WorktreeBranchMode | null = null,
    expectedBranchOid: string | null = null,
  ): Promise<CreateWorktreeResult> {
    const result = await this.request<RemoteWorktreeSummary>("worktree.create", {
      projectId,
      task,
      baseRef,
      branch,
      branchMode,
      expectedBranchOid,
    });
    return {
      id: result.id,
      branch: result.branch,
      path: result.path,
      baseCommit: result.baseCommit,
    };
  }

  async listWorktrees(projectId: string): Promise<WorktreeView[]> {
    const summaries = await this.request<RemoteWorktreeSummary[]>(
      "worktree.list",
      { projectId },
    );
    return summaries.map(remoteWorktreeToWorktreeView);
  }

  async removeWorktree(worktreeId: string): Promise<DestructiveRemovalOutcome> {
    const result = await this.request<RemoteWorktreeRemoveResult>(
      "worktree.remove",
      { worktreeId },
    );
    return remoteWorktreeRemoveToDestructiveOutcome(result);
  }

  worktreeDeletePreflight(worktreeId: string): Promise<WorktreeDeletePreflight> {
    return this.request<WorktreeDeletePreflight>("worktree.remove.preflight", {
      worktreeId,
    });
  }

  worktreeStatusText(worktreeId: string): Promise<WorktreeStatus> {
    return this.request<WorktreeStatus>("worktree.status", { worktreeId });
  }

  // -----------------------------------------------------------------------
  // branches (git_commands surface)
  // -----------------------------------------------------------------------

  async getRepositoryStatus(projectId: string): Promise<RepositoryStatus> {
    const snapshot = await this.request<RemoteBranchSnapshot>("branch.status", {
      projectId,
    });
    // These are desktop-only additions to Core's BranchSnapshot. Resolve live
    // sessions against the actual checkout (not just the project id), and use
    // the remote stash inventory rather than pretending it is empty.
    const [context, stashes] = await Promise.all([
      this.resolveGitContext({ kind: "projectMain", projectId }),
      this.request<unknown[]>("branch.autostash.list", { projectId }),
    ]);
    return remoteBranchSnapshotToRepositoryStatus(
      projectId,
      snapshot,
      context.liveSessionIds,
      stashes.length,
    );
  }

  listLocalBranches(projectId: string): Promise<LocalBranchesResponse> {
    return this.request<LocalBranchesResponse>("branch.list", { projectId });
  }

  createLocalBranch(
    projectId: string,
    name: string,
    startPoint: string | null,
  ): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.create", {
      projectId,
      name,
      startPoint,
    });
  }

  createAndSwitchLocalBranch(
    projectId: string,
    name: string,
    startPoint: string | null,
  ): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.create_switch", {
      projectId,
      name,
      startPoint,
    });
  }

  switchLocalBranch(projectId: string, branch: string): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.switch", { projectId, branch });
  }

  deleteLocalBranch(
    projectId: string,
    branch: string,
    force = false,
  ): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.delete", {
      projectId,
      branch,
      force,
    });
  }

  listAutoStashes(projectId: string | null): Promise<AutoStashRecord[]> {
    return this.request<AutoStashRecord[]>("branch.autostash.list", { projectId });
  }

  restoreAutoStash(
    operationId: string,
    strategy: "target" | "source",
  ): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.autostash.restore", {
      operationId,
      strategy,
    });
  }

  cleanupAutoStash(operationId: string): Promise<BranchOperationResult> {
    return this.request<BranchOperationResult>("branch.autostash.cleanup", {
      operationId,
    });
  }

  // -----------------------------------------------------------------------
  // Git Center (git_workspace_commands surface) — wire shapes match desktop.
  // -----------------------------------------------------------------------

  resolveGitContext(locator: GitContextLocator): Promise<GitCheckoutDescriptor> {
    return this.request<GitCheckoutDescriptor>("git.context.resolve", { locator });
  }

  adoptCurrentGitWorktreeBranch(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedBranch: string,
    actualBranch: string,
  ): Promise<GitChangesSnapshot> {
    return this.request<GitChangesSnapshot>("git.worktree.branch.adopt", {
      locator,
      expectedCheckoutId,
      expectedBranch,
      actualBranch,
    });
  }

  getGitChanges(
    locator: GitContextLocator,
    includeIgnored = true,
  ): Promise<GitChangesSnapshot> {
    return this.request<GitChangesSnapshot>("git.changes", { locator, includeIgnored });
  }

  getGitDiff(
    locator: GitContextLocator,
    expectedStatusToken: string,
    side: GitDiffSide,
    pathToken: string,
  ): Promise<GitFileDiff> {
    return this.request<GitFileDiff>("git.diff", {
      locator,
      expectedStatusToken,
      side,
      pathToken,
    });
  }

  getGitHistory(
    locator: GitContextLocator,
    cursor: string | null,
    limit = 50,
  ): Promise<GitHistoryPage> {
    return this.request<GitHistoryPage>("git.history", { locator, cursor, limit });
  }

  getGitCommitDetail(
    locator: GitContextLocator,
    commitOid: string,
  ): Promise<GitCommitDetail> {
    return this.request<GitCommitDetail>("git.commit.detail", { locator, commitOid });
  }

  getGitCommitDiff(
    locator: GitContextLocator,
    commitOid: string,
    parentOid: string | null,
    pathToken: string | null,
  ): Promise<GitCommitPatch> {
    return this.request<GitCommitPatch>("git.commit.diff", {
      locator,
      commitOid,
      parentOid,
      pathToken,
    });
  }

  stageGitPaths(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.stage", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    });
  }

  unstageGitPaths(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.unstage", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    });
  }

  discardGitPaths(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.discard", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    });
  }

  addGitIgnore(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
    target: GitIgnoreTarget,
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.ignore", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
      target,
    });
  }

  trashGitPath(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.trash", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
    });
  }

  resolveGitFile(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
  ): Promise<GitResolvedFile> {
    return this.request<GitResolvedFile>("git.file.resolve", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
    });
  }

  syncGitRemote(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    action: GitRemoteAction,
  ): Promise<GitMutationResult> {
    return this.request<GitMutationResult>("git.remote.sync", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      action,
    });
  }

  generateGitCommitMessage(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
  ): Promise<GitCommitMessageSuggestion> {
    return this.request<GitCommitMessageSuggestion>("commit_ai.generate", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
    });
  }

  prepareGitCommit(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    message: string,
  ): Promise<GitCommitReview> {
    return this.request<GitCommitReview>("git.commit.prepare", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      message,
    });
  }

  commitGitChanges(
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedCommitToken: string,
    message: string,
  ): Promise<GitCommitResult> {
    return this.request<GitCommitResult>("git.commit.execute", {
      locator,
      expectedCheckoutId,
      expectedCommitToken,
      message,
    });
  }

  // -----------------------------------------------------------------------
  // export / backup
  // -----------------------------------------------------------------------

  /**
   * The remote export has no `last`/`stripAnsi` options and writes to a
   * SERVER-side destination. Option use is an explicit degradation error;
   * T-010 annotates the destination in the UI.
   */
  exportSession(args: ExportArgs): Promise<string> {
    if (args.last != null || args.stripAnsi) {
      return Promise.reject(new RemoteUnavailableError("export.options"));
    }
    return this.request<string>("export.session", {
      sessionId: args.sessionId,
      kind: args.kind,
      destination: args.dest,
    });
  }

  /**
   * Remote backup.create has no agent/requestId and emits no progress events;
   * the destination is server-side.
   */
  backupCreate(
    _agent: string,
    dest: string | null,
    _requestId: string,
  ): Promise<BackupCreateResult> {
    return this.request<BackupCreateResult>("backup.create", {
      destination: dest ?? undefined,
    });
  }

  backupList(): Promise<{ path: string; name: string; size: number; modifiedAt: string }[]> {
    return this.request("backup.list");
  }

  backupVerify(path: string): Promise<BackupVerifyResult> {
    return this.request<BackupVerifyResult>("backup.verify", { path });
  }

  /**
   * Divergent remote semantics: backup.restore writes into a target dir and
   * refuses the live data root, while the desktop restores in place.
   */
  backupRestore(): Promise<never> {
    return Promise.reject(
      new RemoteUnavailableError(
        "backup.restore",
        "remote restore targets a server-side directory instead of the live data root",
      ),
    );
  }

  // -----------------------------------------------------------------------
  // search / history / storage / timeline
  // -----------------------------------------------------------------------

  search(query: string, limit: number | null): Promise<SearchResult> {
    return this.request<SearchResult>("search.global", {
      query,
      ...(limit != null ? { limit } : {}),
    });
  }

  getNativeHistory(
    sessionId: string,
    cursor: string | null,
    limit = 200,
  ): Promise<HistoryPage> {
    return this.request<HistoryPage>("history.page", { sessionId, cursor, limit });
  }

  getLegacyLogInventory(): Promise<LegacyLogInventory> {
    return this.request<LegacyLogInventory>("storage.legacy.inventory");
  }

  deleteLegacyLogs(entryIds: string[], confirmed: boolean): Promise<LegacyDeleteReport> {
    return this.request<LegacyDeleteReport>("storage.legacy.delete", {
      entryIds,
      confirmed,
    });
  }

  rebuildSearchIndex(): Promise<void> {
    return this.request<void>("search.index.rebuild");
  }

  getTimeline(): Promise<TimelineData> {
    return this.request<TimelineData>("timeline.get");
  }

  ackTimeline(snapshots: TimelineAckSnapshot[]): Promise<void> {
    return this.request<void>("timeline.ack", { snapshots });
  }

  // -----------------------------------------------------------------------
  // commit AI config
  // -----------------------------------------------------------------------

  getCommitAiConfig(): Promise<CommitAiConfig> {
    return this.request<CommitAiConfig>("commit_ai.config.get");
  }

  saveCommitAiConfig(
    provider: CommitAiProvider,
    baseUrl: string,
    model: string,
    apiKey: string | null,
    language: CommitAiLanguage,
  ): Promise<CommitAiConfig> {
    return this.request<CommitAiConfig>("commit_ai.config.save", {
      provider,
      baseUrl,
      model,
      apiKey,
      language,
    });
  }

  clearCommitAiApiKey(): Promise<CommitAiConfig> {
    return this.request<CommitAiConfig>("commit_ai.key.clear");
  }

  // -----------------------------------------------------------------------
  // diagnostics
  // -----------------------------------------------------------------------

  /** Remote hosts expose the REMOTE device's socket paths; T-010 hides them. */
  diagHosts(): Promise<HostInfo[]> {
    return this.request<HostInfo[]>("diagnostics.hosts");
  }

  diagSummary(): Promise<string> {
    return this.request<string>("diagnostics.summary");
  }

  diagCapabilities(): Promise<string> {
    return this.request<string>("diagnostics.capabilities");
  }

  // -----------------------------------------------------------------------
  // secrets
  // -----------------------------------------------------------------------

  async secretStatus(): Promise<string> {
    const status = await this.request<RemoteSecretBackendStatus>("secret.status");
    return remoteSecretStatusToBackendString(status);
  }

  async secretAdd(presetId: string, envName: string, value: string): Promise<SecretMeta> {
    const result = await this.request<{ id: string; envName: string; backend: string }>(
      "secret.add",
      { envName, presetId, value },
    );
    return remoteSecretAddResultToSecretMeta(result);
  }

  async secretList(): Promise<SecretMeta[]> {
    const summaries = await this.request<RemoteSecretSummary[]>("secret.list");
    return summaries.map(remoteSecretSummaryToSecretMeta);
  }

  secretDelete(id: string): Promise<void> {
    return this.request<void>("secret.delete", { id });
  }

  // -----------------------------------------------------------------------
  // documents
  // -----------------------------------------------------------------------

  readSessionDocument(path: string): Promise<SessionDocument> {
    return this.request<SessionDocument>("document.read", { path });
  }

  writeSessionDocument(
    path: string,
    content: string,
  ): Promise<{ path: string; sizeBytes: number }> {
    return this.request("document.write", { path, content });
  }

  listDocumentDirectory(path: string): Promise<DocumentDirListing> {
    return this.request<DocumentDirListing>("document.list", { path });
  }

  createDocumentEntry(
    path: string,
    kind: "file" | "dir",
  ): Promise<{ path: string }> {
    return this.request("document.create", { path, kind });
  }

  renameDocumentEntry(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("document.rename"));
  }

  duplicateDocumentEntry(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("document.duplicate"));
  }

  deleteDocumentEntry(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("document.delete"));
  }

  // -----------------------------------------------------------------------
  // OS integration against device paths — meaningless across devices.
  // -----------------------------------------------------------------------

  revealInFileManager(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("os.revealInFileManager"));
  }

  openInSystemTerminal(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("os.openInSystemTerminal"));
  }

  openInVsCode(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("os.openInVsCode"));
  }

  openWithDefaultApp(): Promise<never> {
    return Promise.reject(new RemoteUnavailableError("os.openWithDefaultApp"));
  }

  // -----------------------------------------------------------------------
  // T-006 / T-008 helpers (not part of the api.ts surface)
  // -----------------------------------------------------------------------

  /** Raw session summaries, optionally including archived sessions. */
  listSessionSummaries(includeArchived = false): Promise<RemoteSessionSummary[]> {
    return this.request<RemoteSessionSummary[]>("session.list", { includeArchived });
  }

  /** Raw project summaries for boot assembly. */
  listProjectSummaries(): Promise<RemoteProjectSummary[]> {
    return this.request<RemoteProjectSummary[]>("project.list");
  }

  /** Long-poll one attachment when event push is unavailable (fallback). */
  pollSession(
    attachmentId: string,
    limit = 64,
    waitMs = 50,
  ): Promise<RemoteSessionPollResult> {
    return this.request<RemoteSessionPollResult>("session.poll", {
      attachmentId,
      limit,
      waitMs,
    });
  }

  /** Attention polling drives remote-mode unread/notification synthesis. */
  pollAttention(
    cursor: AttentionCursor | null = null,
    limit?: number,
  ): Promise<RemoteAttentionPollResult> {
    return this.request<RemoteAttentionPollResult>("attention.poll", {
      cursor,
      ...(limit != null ? { limit } : {}),
    });
  }
}
