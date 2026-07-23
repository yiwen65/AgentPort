// Thin typed wrappers over the Tauri command surface (src-tauri/src/main.rs).
// Rust snake_case arguments are passed in camelCase — Tauri 2 converts
// automatically. Branch-management errors remain structured objects.

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AddProjectResult,
  ArchivedSessionView,
  AttachInfo,
  BootInfo,
  ChannelMsg,
  CreateSessionResult,
  CreateWorktreeResult,
  AutoStashRecord,
  BranchOperationResult,
  HostInfo,
  LogCursorView,
  RecoveryLogContext,
  LogTail,
  PermissionStr,
  Preset,
  ProbeOutcome,
  ProjectView,
  LocalBranchesResponse,
  RepositoryOperationProgress,
  RepositoryStatus,
  StructuredGitError,
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
  WorktreeBranchMode,
  WorktreeView,
} from "./types";
import { runtimeMessageEnvelope, runtimeMessageText } from "./runtimeMessages";

// ---------------------------------------------------------------------------
// base64 helpers (send_input / channel output are base64 payloads)
// ---------------------------------------------------------------------------

export function strToB64(s: string): string {
  return bytesToB64(new TextEncoder().encode(s));
}

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
  kind: "log" | "md" | "zip";
  dest: string;
  last: number | null;
  stripAnsi: boolean;
};

export const api = {
  boot: () => invoke<BootInfo>("boot"),
  listProjects: (activeSession: string | null) =>
    invoke<ProjectView[]>("list_projects", { activeSession }),
  probeAgents: () => invoke<ProbeOutcome[]>("probe_agents"),
  probeAgent: (agent: string, path: string | null) =>
    invoke<ProbeOutcome>("probe_agent", { agent, path }),
  listSupportedAgents: () => invoke<SupportedAgent[]>("list_supported_agents"),
  addProject: (path: string, name: string | null) =>
    invoke<AddProjectResult>("add_project", { path, name }),
  renameProject: (id: string, name: string) =>
    invoke<void>("rename_project", { id, name }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  listPresets: (agent: string | null) => invoke<Preset[]>("list_presets", { agent }),
  createSession: (args: CreateSessionArgs) =>
    invoke<CreateSessionResult>("create_session", args),
  attachSession: (
    sessionId: string,
    replayTailBytes: number,
    channel: Channel<ChannelMsg>,
    resumeFrom: LogCursorView | null = null,
    recoveryTarget: LogCursorView | null = null,
  ) => invoke<AttachInfo>("attach_session", { sessionId, replayTailBytes, channel, resumeFrom, recoveryTarget }),
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
  resizePty: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize_pty", { sessionId, cols, rows }),
  stopSession: (sessionId: string) => invoke<void>("stop_session", { sessionId }),
  interruptSession: (sessionId: string) => invoke<void>("interrupt_session", { sessionId }),
  restartSession: (sessionId: string, riskAck: boolean) =>
    invoke<RestartResult>("restart_session", { sessionId, riskAck }),
  renameSession: (sessionId: string, title: string) =>
    invoke<void>("rename_session", { sessionId, title }),
  archiveSession: (sessionId: string) => invoke<void>("archive_session", { sessionId }),
  listArchivedSessions: () => invoke<ArchivedSessionView[]>("list_archived_sessions"),
  unarchiveSession: (sessionId: string) => invoke<void>("unarchive_session", { sessionId }),
  deleteArchivedSession: (sessionId: string) =>
    invoke<void>("delete_archived_session", { sessionId }),
  deleteAllArchivedSessions: () => invoke<void>("delete_all_archived_sessions"),
  sessionHistory: (sessionId: string) =>
    invoke<StatusEventView[]>("session_history", { sessionId }),
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
  removeWorktree: (worktreeId: string) => invoke<void>("remove_worktree", { worktreeId }),
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
  switchLocalBranch: (projectId: string, branch: string) =>
    invoke<BranchOperationResult>("switch_local_branch", { projectId, branch }),
  deleteLocalBranch: (projectId: string, branch: string) =>
    invoke<BranchOperationResult>("delete_local_branch", { projectId, branch }),
  listAutoStashes: (projectId: string | null) =>
    invoke<AutoStashRecord[]>("list_auto_stashes", { projectId }),
  restoreAutoStash: (operationId: string, strategy: "target" | "source") =>
    invoke<BranchOperationResult>("restore_auto_stash", { operationId, strategy }),
  cleanupAutoStash: (operationId: string) =>
    invoke<BranchOperationResult>("cleanup_auto_stash", { operationId }),
  exportSession: (args: ExportArgs) => invoke<string>("export_session", args),
  backupCreate: (dest: string | null) =>
    invoke<{ path: string; files: number; bytes: number; verified: boolean }>("backup_create", {
      dest,
    }),
  backupList: () =>
    invoke<{ path: string; name: string; size: number; modifiedAt: string }[]>("backup_list"),
  backupVerify: (path: string) =>
    invoke<{ ok: boolean; createdAt: string; files: number; dataModelVersion: number }>(
      "backup_verify",
      { path },
    ),
  backupRestore: (path: string, target: string) =>
    invoke<{ restored: string; previousKeptAt: string }>("backup_restore", { path, target }),
  search: (query: string, limit: number | null) =>
    invoke<SearchResult>("search", { query, limit }),
  /** Full persisted output for one Session, including text outside xterm's scrollback. */
  searchSessionLog: (sessionId: string, query: string, limit: number | null) =>
    invoke<SearchResult>("search_session_log", { sessionId, query, limit }),
  rebuildSearchIndex: () => invoke<void>("rebuild_search_index"),
  getTimeline: () => invoke<TimelineData>("get_timeline"),
  ackTimeline: (snapshots: TimelineAckSnapshot[]) => invoke<void>("ack_timeline", { snapshots }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
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
  readLogTail: (sessionId: string, bytes: number) =>
    invoke<LogTail>("read_log_tail", { sessionId, bytes }),
  readRecoveryLogContext: (sessionId: string, cursor: LogCursorView) =>
    invoke<RecoveryLogContext>("read_recovery_log_context", { sessionId, cursor }),
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
  }) => void,
): Promise<UnlistenFn> {
  return listen<{
    sessionId: string;
    code: number | null;
    signal: number | null;
    reason?: string;
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

// ---------------------------------------------------------------------------
// clipboard (no dialog/clipboard plugin is registered; use the webview API)
// ---------------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
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
