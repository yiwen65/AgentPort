// Thin typed wrappers over the Tauri command surface (src-tauri/src/main.rs).
// Rust snake_case arguments are passed in camelCase — Tauri 2 converts
// automatically. Branch-management errors remain structured objects.

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  readImage as readNativeClipboardImage,
  readText as readNativeClipboardText,
  writeText as writeNativeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import type {
  AddProjectResult,
  ArchivedSessionView,
  AttachInfo,
  BootInfo,
  ChannelMsg,
  ConfirmedArchivedSession,
  CreateSessionResult,
  CreateWorktreeResult,
  AutoStashRecord,
  BranchOperationResult,
  HostInfo,
  LogCursorView,
  HistoryPage,
  LegacyDeleteReport,
  LegacyLogInventory,
  PermissionStr,
  Preset,
  ProbeOutcome,
  NotificationSetup,
  ProjectLayoutEntry,
  ProjectView,
  ProjectRemovalPreflight,
  LocalBranchesResponse,
  RepositoryOperationProgress,
  RepositoryStatus,
  StructuredGitError,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
  GitCommitDetail,
  GitCommitPatch,
  GitCommitResult,
  GitCommitReview,
  GitCommitMessageSuggestion,
  GitContextLocator,
  GitDiffSide,
  GitFileDiff,
  GitHistoryPage,
  GitIgnoreTarget,
  GitMutationResult,
  GitPathSelection,
  GitRemoteAction,
  GitResolvedFile,
  GitStateInvalidated,
  GitWorkspaceCommandError,
  CommitAiConfig,
  CommitAiLanguage,
  CommitAiProvider,
  DestructiveRemovalOutcome,
  RestartResult,
  DocumentDirListing,
  SearchResult,
  SecretMeta,
  SessionDocument,
  Settings,
  SupportedAgent,
  StatusEventView,
  StatusCursorView,
  TimelineData,
  TimelineAckSnapshot,
  WorktreeStatus,
  WorktreeDeletePreflight,
  WorktreeBranchMode,
  WorktreePreview,
  WorktreeView,
} from "./types";
import { runtimeMessageEnvelope, runtimeMessageText } from "./runtimeMessages";

// ---------------------------------------------------------------------------
// base64 helpers (send_input / channel output are base64 payloads)
// ---------------------------------------------------------------------------

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Narrow unknown structured payloads without repeating unsafe casts. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Normalize any invoke rejection into a displayable string. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const envelope = runtimeMessageEnvelope(e);
  if (envelope) return runtimeMessageText(envelope);
  const record = asRecord(e);
  if (record) {
    // Keep structured Tauri rejections intact: branch management reads the
    // JSON again to expose live-session recovery actions to the user.
    try {
      return JSON.stringify(record);
    } catch {
      const message = record.message;
      return typeof message === "string" ? message : String(e);
    }
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Tauri invoke rejects with the serialized error object itself. Keep this
 * guard separate from errorText so callers never need to parse a flattened
 * message string (and can preserve recovery/session metadata).
 */
export function isStructuredGitError(value: unknown): value is StructuredGitError {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.phase === "string" &&
    typeof record.operationId === "string" &&
    typeof record.recoverable === "boolean" &&
    (record.currentStatus === null || (typeof record.currentStatus === "object" && record.currentStatus !== null)) &&
    isStringArray(record.recoveryActions) &&
    (record.recoveryActionCodes === undefined || isStringArray(record.recoveryActionCodes)) &&
    typeof record.diagnostics === "object" && record.diagnostics !== null &&
    isStringArray(record.liveSessionIds);
}

/** Structured Git Center rejection with an optional authoritative refresh. */
export function isGitWorkspaceCommandError(
  value: unknown,
): value is GitWorkspaceCommandError {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.recoverable === "boolean" &&
    (record.currentChanges === null ||
      (typeof record.currentChanges === "object" && record.currentChanges !== null));
}

/** Commit AI errors are structured but do not carry Git snapshots. */
export function commitAiErrorText(value: unknown): string {
  const record = asRecord(value);
  return record &&
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.recoverable === "boolean"
    ? record.message
    : errorText(value);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type CreateSessionArgs = {
  projectId: string;
  agent: string;
  title: string | null;
  presetId: string | null;
  worktreeId: string | null;
  permission: PermissionStr;
  transport: "pty" | "json_rpc";
  riskAck: boolean;
  cols: number | null;
  rows: number | null;
  extraArgs: string[] | null;
};

export type ExportArgs = {
  sessionId: string;
  kind: "md" | "json" | "zip";
  dest: string;
  last: number | null;
  stripAnsi: boolean;
};

export type ResizePtyAuthority = {
  expectedRevision: number;
  sourceKind: "desktop" | "mobile";
  sourceDeviceId?: string | null;
  orientation?: string | null;
};

export type NativeCoverageSummary = {
  total: number;
  captured: number;
  missing: number;
  ambiguous: number;
  unsupported: number;
};

export type BackupProgress = {
  requestId: string;
  agent: string;
  phase: "database" | "filtering" | "native" | "files" | "archive" | "verify";
  completed: number;
  total: number;
};

export type BackupCreateResult = {
  path: string;
  files: number;
  bytes: number;
  verified: boolean;
  nativeCoverage: NativeCoverageSummary;
};

export type BackupVerifyResult = {
  ok: boolean;
  agentType?: string | null;
  formatVersion: number;
  createdAt: string;
  files: number;
  dataModelVersion: number;
  nativeCoverage: NativeCoverageSummary;
};

export const api = {
  boot: () => invoke<BootInfo>("boot"),
  listProjects: (activeSession: string | null) =>
    invoke<ProjectView[]>("list_projects", { activeSession }),
  probeAgents: (preserveSelections = false) =>
    invoke<ProbeOutcome[]>("probe_agents", { preserveSelections }),
  probeAgent: (agent: string, path: string | null) =>
    invoke<ProbeOutcome>("probe_agent", { agent, path }),
  listSupportedAgents: () => invoke<SupportedAgent[]>("list_supported_agents"),
  notificationSetups: () => invoke<NotificationSetup[]>("notification_setups"),
  rollbackNotificationSetup: (agent: string) =>
    invoke<NotificationSetup>("rollback_notification_setup", { agent }),
  addProject: (path: string, name: string | null) =>
    invoke<AddProjectResult>("add_project", { path, name }),
  renameProject: (id: string, name: string) =>
    invoke<void>("rename_project", { id, name }),
  setProjectLayout: (entries: ProjectLayoutEntry[], activeSession: string | null) =>
    invoke<ProjectView[]>("set_project_layout", { entries, activeSession }),
  removeProject: (preflight: ProjectRemovalPreflight) =>
    invoke<DestructiveRemovalOutcome>("remove_project", { preflight }),
  projectRemovePreflight: (id: string) =>
    invoke<ProjectRemovalPreflight>("project_remove_preflight", { id }),
  deleteProjectArchivedSessions: (
    projectId: string,
    sessions: ConfirmedArchivedSession[],
  ) => invoke<void>("delete_project_archived_sessions", { projectId, sessions }),
  listPresets: (agent: string | null) => invoke<Preset[]>("list_presets", { agent }),
  createSession: (args: CreateSessionArgs) =>
    invoke<CreateSessionResult>("create_session", args),
  attachSession: (
    sessionId: string,
    replayTailBytes: number,
    channel: Channel<ChannelMsg>,
    resumeFrom: LogCursorView | null = null,
  ) => invoke<AttachInfo>("attach_session", { sessionId, replayTailBytes, channel, resumeFrom }),
  detachSession: (sessionId: string, attachmentId: number) =>
    invoke<void>("detach_session", { sessionId, attachmentId }),
  markSessionSeen: (sessionId: string, cursor: StatusCursorView | null = null) =>
    invoke<void>("mark_session_seen", { sessionId, cursor }),
  markSessionLogRendered: (
    sessionId: string,
    attachmentId: number,
    cursor: LogCursorView,
  ) => invoke<void>("mark_session_log_rendered", { sessionId, attachmentId, cursor }),
  markSessionOutputUnread: (
    sessionId: string,
    offset: number,
    cursor: LogCursorView | null = null,
  ) => invoke<void>("mark_session_output_unread", { sessionId, offset, cursor }),
  sendInput: (sessionId: string, data: string) =>
    invoke<void>("send_input", { sessionId, data }),
  sendStructuredPrompt: (sessionId: string, text: string) =>
    invoke<void>("send_structured_prompt", { sessionId, text }),
  abortStructuredTurn: (sessionId: string) =>
    invoke<void>("abort_structured_turn", { sessionId }),
  autoRenameSessionFromFirstInput: (sessionId: string, input: string) =>
    invoke<boolean>("auto_rename_session_from_first_input", { sessionId, input }),
  resizePty: (
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth: number,
    pixelHeight: number,
    authority?: ResizePtyAuthority,
  ) => invoke<void>("resize_pty", {
    sessionId,
    cols,
    rows,
    pixelWidth,
    pixelHeight,
    expectedRevision: authority?.expectedRevision ?? null,
    sourceKind: authority?.sourceKind ?? null,
    sourceDeviceId: authority?.sourceDeviceId ?? null,
    orientation: authority?.orientation ?? null,
  }),
  stopSession: (sessionId: string) => invoke<void>("stop_session", { sessionId }),
  interruptSession: (sessionId: string) => invoke<void>("interrupt_session", { sessionId }),
  resumeSession: (sessionId: string) => invoke<void>("resume_session", { sessionId }),
  restartSession: (sessionId: string, riskAck: boolean) =>
    invoke<RestartResult>("restart_session", { sessionId, riskAck }),
  renameSession: (sessionId: string, title: string) =>
    invoke<void>("rename_session", { sessionId, title }),
  setSessionPinned: (sessionId: string, pinned: boolean) =>
    invoke<void>("set_session_pinned", { sessionId, pinned }),
  archiveSession: (sessionId: string) => invoke<void>("archive_session", { sessionId }),
  listArchivedSessions: () => invoke<ArchivedSessionView[]>("list_archived_sessions"),
  unarchiveSession: (sessionId: string) => invoke<void>("unarchive_session", { sessionId }),
  deleteArchivedSession: (sessionId: string) =>
    invoke<void>("delete_archived_session", { sessionId }),
  deleteAllArchivedSessions: () => invoke<void>("delete_all_archived_sessions"),
  sessionHistory: (sessionId: string) =>
    invoke<StatusEventView[]>("session_history", { sessionId }),
  previewWorktree: (projectId: string, task: string) =>
    invoke<WorktreePreview>("preview_worktree", { projectId, task }),
  reconcileWorktrees: (projectId: string) =>
    invoke<number>("reconcile_worktrees", { projectId }),
  createWorktree: (
    projectId: string,
    task: string,
    baseRef: string | null,
    branch: string | null,
    branchMode: WorktreeBranchMode | null = null,
    expectedBranchOid: string | null = null,
  ) =>
    invoke<CreateWorktreeResult>("create_worktree", {
      projectId,
      task,
      baseRef,
      branch,
      branchMode,
      expectedBranchOid,
    }),
  listWorktrees: (projectId: string) =>
    invoke<WorktreeView[]>("list_worktrees", { projectId }),
  removeWorktree: (worktreeId: string) =>
    invoke<DestructiveRemovalOutcome>("remove_worktree", { worktreeId }),
  worktreeDeletePreflight: (worktreeId: string) =>
    invoke<WorktreeDeletePreflight>("worktree_delete_preflight", { worktreeId }),
  worktreeStatusText: (worktreeId: string) =>
    invoke<WorktreeStatus>("worktree_status_text", { worktreeId }),
  getRepositoryStatus: (projectId: string) =>
    invoke<RepositoryStatus>("get_repository_status", { projectId }),
  listLocalBranches: (projectId: string) =>
    invoke<LocalBranchesResponse>("list_local_branches", { projectId }),
  createLocalBranch: (
    projectId: string,
    name: string,
    startPoint: string | null,
  ) =>
    invoke<BranchOperationResult>("create_local_branch", {
      projectId,
      name,
      startPoint,
    }),
  createAndSwitchLocalBranch: (
    projectId: string,
    name: string,
    startPoint: string | null,
  ) =>
    invoke<BranchOperationResult>("create_and_switch_local_branch", {
      projectId,
      name,
      startPoint,
    }),
  switchLocalBranch: (projectId: string, branch: string) =>
    invoke<BranchOperationResult>("switch_local_branch", { projectId, branch }),
  deleteLocalBranch: (projectId: string, branch: string, force = false) =>
    invoke<BranchOperationResult>("delete_local_branch", { projectId, branch, force }),
  listAutoStashes: (projectId: string | null) =>
    invoke<AutoStashRecord[]>("list_auto_stashes", { projectId }),
  restoreAutoStash: (operationId: string, strategy: "target" | "source") =>
    invoke<BranchOperationResult>("restore_auto_stash", { operationId, strategy }),
  cleanupAutoStash: (operationId: string) =>
    invoke<BranchOperationResult>("cleanup_auto_stash", { operationId }),
  resolveGitContext: (locator: GitContextLocator) =>
    invoke<GitCheckoutDescriptor>("resolve_git_context", { locator }),
  adoptCurrentGitWorktreeBranch: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedBranch: string,
    actualBranch: string,
  ) =>
    invoke<GitChangesSnapshot>("adopt_git_worktree_branch", {
      locator,
      expectedCheckoutId,
      expectedBranch,
      actualBranch,
    }),
  getGitChanges: (locator: GitContextLocator, includeIgnored = true) =>
    invoke<GitChangesSnapshot>("get_git_changes", { locator, includeIgnored }),
  getGitDiff: (
    locator: GitContextLocator,
    expectedStatusToken: string,
    side: GitDiffSide,
    pathToken: string,
  ) =>
    invoke<GitFileDiff>("get_git_diff", {
      locator,
      expectedStatusToken,
      side,
      pathToken,
    }),
  getGitHistory: (
    locator: GitContextLocator,
    cursor: string | null,
    limit = 50,
  ) =>
    invoke<GitHistoryPage>("get_git_history", { locator, cursor, limit }),
  getGitCommitDetail: (locator: GitContextLocator, commitOid: string) =>
    invoke<GitCommitDetail>("get_git_commit_detail", { locator, commitOid }),
  getGitCommitDiff: (
    locator: GitContextLocator,
    commitOid: string,
    parentOid: string | null,
    pathToken: string | null,
  ) =>
    invoke<GitCommitPatch>("get_git_commit_diff", {
      locator,
      commitOid,
      parentOid,
      pathToken,
    }),
  stageGitPaths: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ) =>
    invoke<GitMutationResult>("stage_git_paths", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    }),
  unstageGitPaths: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ) =>
    invoke<GitMutationResult>("unstage_git_paths", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    }),
  discardGitPaths: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selections: GitPathSelection[],
  ) =>
    invoke<GitMutationResult>("discard_git_paths", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selections,
    }),
  addGitIgnore: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
    target: GitIgnoreTarget,
  ) =>
    invoke<GitMutationResult>("add_git_ignore", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
      target,
    }),
  trashGitPath: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
  ) =>
    invoke<GitMutationResult>("trash_git_path", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
    }),
  resolveGitFile: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    selection: GitPathSelection,
  ) =>
    invoke<GitResolvedFile>("resolve_git_file", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      selection,
    }),
  syncGitRemote: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    action: GitRemoteAction,
  ) =>
    invoke<GitMutationResult>("sync_git_remote", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      action,
    }),
  generateGitCommitMessage: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
  ) =>
    invoke<GitCommitMessageSuggestion>("generate_git_commit_message", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
    }),
  prepareGitCommit: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedStatusToken: string,
    message: string,
  ) =>
    invoke<GitCommitReview>("prepare_git_commit", {
      locator,
      expectedCheckoutId,
      expectedStatusToken,
      message,
    }),
  commitGitChanges: (
    locator: GitContextLocator,
    expectedCheckoutId: string,
    expectedCommitToken: string,
    message: string,
  ) =>
    invoke<GitCommitResult>("commit_git_changes", {
      locator,
      expectedCheckoutId,
      expectedCommitToken,
      message,
    }),
  exportSession: (args: ExportArgs) => invoke<string>("export_session", args),
  backupCreate: (agent: string, dest: string | null, requestId: string) =>
    invoke<BackupCreateResult>("backup_create", { agent, dest, requestId }),
  backupList: () =>
    invoke<{ path: string; name: string; size: number; modifiedAt: string }[]>("backup_list"),
  backupVerify: (path: string) =>
    invoke<BackupVerifyResult>("backup_verify", { path }),
  backupRestore: (path: string, agent: string) =>
    invoke<{ imported: string[]; skipped: string[]; nativeCoverage: NativeCoverageSummary }>("backup_restore", { path, agent }),
  search: (query: string, limit: number | null) =>
    invoke<SearchResult>("search", { query, limit }),
  getNativeHistory: (sessionId: string, cursor: string | null, limit = 200) =>
    invoke<HistoryPage>("get_native_history", { sessionId, cursor, limit }),
  getLegacyLogInventory: () =>
    invoke<LegacyLogInventory>("get_legacy_log_inventory"),
  deleteLegacyLogs: (entryIds: string[], confirmed: boolean) =>
    invoke<LegacyDeleteReport>("delete_legacy_logs", { entryIds, confirmed }),
  rebuildSearchIndex: () => invoke<void>("rebuild_search_index"),
  getTimeline: () => invoke<TimelineData>("get_timeline"),
  ackTimeline: (snapshots: TimelineAckSnapshot[]) => invoke<void>("ack_timeline", { snapshots }),
  setNotificationSession: (sessionId: string | null) =>
    invoke<void>("set_notification_session", { sessionId }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  getCommitAiConfig: () => invoke<CommitAiConfig>("get_commit_ai_config"),
  saveCommitAiConfig: (
    provider: CommitAiProvider,
    baseUrl: string,
    model: string,
    apiKey: string | null,
    language: CommitAiLanguage,
  ) =>
    invoke<CommitAiConfig>("save_commit_ai_config", {
      provider,
      baseUrl,
      model,
      apiKey,
      language,
    }),
  clearCommitAiApiKey: () =>
    invoke<CommitAiConfig>("clear_commit_ai_api_key"),
  diagHosts: () => invoke<HostInfo[]>("diag_hosts"),
  diagSummary: () => invoke<string>("diag_summary"),
  diagCapabilities: () => invoke<string>("diag_capabilities"),
  secretStatus: () => invoke<string>("secret_status"),
  secretAdd: (presetId: string, envName: string, value: string) =>
    invoke<SecretMeta>("secret_add", { presetId, envName, value }),
  secretList: () => invoke<SecretMeta[]>("secret_list"),
  secretDelete: (id: string) => invoke<void>("secret_delete", { id }),
  notifyTest: () => invoke<void>("notify_test"),
  takePendingNotificationSession: () => invoke<string | null>("take_pending_notification_session"),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  openInSystemTerminal: (path: string) => invoke<void>("open_in_system_terminal", { path }),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
  readSessionDocument: (path: string) =>
    invoke<SessionDocument>("read_session_document", { path }),
  writeSessionDocument: (path: string, content: string) =>
    invoke<{ path: string; sizeBytes: number }>("write_session_document", { path, content }),
  listDocumentDirectory: (path: string) =>
    invoke<DocumentDirListing>("list_document_directory", { path }),
  createDocumentEntry: (path: string, kind: "file" | "dir") =>
    invoke<{ path: string }>("create_document_entry", { path, kind }),
  renameDocumentEntry: (oldPath: string, newPath: string) =>
    invoke<{ path: string }>("rename_document_entry", { oldPath, newPath }),
  duplicateDocumentEntry: (path: string) =>
    invoke<{ path: string }>("duplicate_document_entry", { path }),
  deleteDocumentEntry: (path: string) =>
    invoke<void>("delete_document_entry", { path }),
  openInVsCode: (path: string) => invoke<void>("open_in_vs_code", { path }),
  openWithDefaultApp: (path: string) => invoke<void>("open_with_default_app", { path }),
  pickDirectory: () => invoke<string | null>("pick_directory"),
  pickSavePath: (defaultName: string) =>
    invoke<string | null>("pick_save_path", { defaultName }),
  pickFile: (filterName: string | null) =>
    invoke<string | null>("pick_file", { filterName }),
};

// ---------------------------------------------------------------------------
// app-level events
// ---------------------------------------------------------------------------

export function onBackupProgress(cb: (progress: BackupProgress) => void): Promise<UnlistenFn> {
  return listen<BackupProgress>("backup-progress", (event) => cb(event.payload));
}

export function onProjectsChanged(cb: (projects: ProjectView[]) => void): Promise<UnlistenFn> {
  return listen<ProjectView[]>("projects-changed", (e) => cb(e.payload));
}

/** Payload includes sessionId (status_value in main.rs). */
export function onSessionState(cb: (ev: StatusEventView) => void): Promise<UnlistenFn> {
  return listen<StatusEventView>("session-state", (e) => cb(e.payload));
}

export function onSessionExit(
  cb: (ev: {
    sessionId: string;
    code: number | null;
    signal: number | null;
    reason?: string;
    runId?: string;
    runOrdinal?: number;
  }) => void,
): Promise<UnlistenFn> {
  return listen<{
    sessionId: string;
    code: number | null;
    signal: number | null;
    reason?: string;
    runId?: string;
    runOrdinal?: number;
  }>(
    "session-exit",
    (e) => cb(e.payload),
  );
}

export function onSessionAgentId(
  cb: (ev: { sessionId: string; agentSessionId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; agentSessionId: string }>("session-agent-id", (e) =>
    cb(e.payload),
  );
}

/** Emitted when a purge succeeded but some agent-native files could not be removed. */
export function onNativeCleanupWarning(cb: (ev: { count: number }) => void): Promise<UnlistenFn> {
  return listen<{ count: number }>("native-cleanup-warning", (e) => cb(e.payload));
}

export function onNotificationActivated(cb: (sessionId: string) => void): Promise<UnlistenFn> {
  return listen<string>("notification-activated", (event) => cb(event.payload));
}

export function onRepositoryOperationProgress(
  cb: (ev: RepositoryOperationProgress) => void,
): Promise<UnlistenFn> {
  return listen<RepositoryOperationProgress>("repo-operation-progress", (e) => cb(e.payload));
}

export function onRepositoryStateChanged(
  cb: (status: RepositoryStatus) => void,
): Promise<UnlistenFn> {
  return listen<RepositoryStatus>("repository-state-changed", (e) => cb(e.payload));
}

export function onAutoStashChanged(cb: (stash: AutoStashRecord) => void): Promise<UnlistenFn> {
  return listen<AutoStashRecord>("auto-stash-changed", (e) => cb(e.payload));
}

/** Invalidation only; callers must perform a fresh authoritative read. */
export function onGitStateInvalidated(
  cb: (event: GitStateInvalidated) => void,
): Promise<UnlistenFn> {
  return listen<GitStateInvalidated>("git-state-invalidated", (event) => cb(event.payload));
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
  try {
    // WKWebView's ClipboardEvent and execCommand paths can reinterpret UTF-8
    // bytes as MacRoman. The Tauri plugin writes the Unicode string through
    // the native platform clipboard and is the authoritative desktop path.
    await writeNativeClipboardText(text);
    return true;
  } catch {
    // Keep browser/dev previews usable when the native Tauri runtime is absent.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for webviews where async clipboard is unavailable.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    return await readNativeClipboardText();
  } catch {
    return navigator.clipboard.readText();
  }
}

/** Native fallback for WebKit paste events that omit image file metadata. */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const image = await readNativeClipboardImage();
    await image.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
