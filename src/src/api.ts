// Thin typed wrappers over the Tauri command surface (src-tauri/src/main.rs).
// Rust snake_case arguments are passed in camelCase — Tauri 2 converts
// automatically. All backend errors come back as plain strings.

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
  HostInfo,
  LogTail,
  PermissionStr,
  Preset,
  ProbeOutcome,
  ProjectView,
  RestartResult,
  SearchResult,
  SecretMeta,
  Settings,
  StatusEventView,
  TimelineData,
  WorktreeStatus,
  WorktreeView,
} from "./types";

// ---------------------------------------------------------------------------
// base64 helpers (send_input / channel output are base64 payloads)
// ---------------------------------------------------------------------------

export function strToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
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

/** Normalize any invoke rejection into a displayable string. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
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
  addProject: (path: string, name: string | null) =>
    invoke<AddProjectResult>("add_project", { path, name }),
  renameProject: (id: string, name: string) =>
    invoke<void>("rename_project", { id, name }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  listPresets: (agent: string | null) => invoke<Preset[]>("list_presets", { agent }),
  createSession: (args: CreateSessionArgs) =>
    invoke<CreateSessionResult>("create_session", args),
  attachSession: (sessionId: string, replayTailBytes: number, channel: Channel<ChannelMsg>) =>
    invoke<AttachInfo>("attach_session", { sessionId, replayTailBytes, channel }),
  detachSession: (sessionId: string) => invoke<void>("detach_session", { sessionId }),
  markSessionSeen: (sessionId: string) => invoke<void>("mark_session_seen", { sessionId }),
  markSessionOutputUnread: (sessionId: string, offset: number) =>
    invoke<void>("mark_session_output_unread", { sessionId, offset }),
  sendInput: (sessionId: string, data: string) =>
    invoke<void>("send_input", { sessionId, data }),
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
  createWorktree: (projectId: string, task: string, baseRef: string | null, branch: string | null) =>
    invoke<CreateWorktreeResult>("create_worktree", { projectId, task, baseRef, branch }),
  listWorktrees: (projectId: string) =>
    invoke<WorktreeView[]>("list_worktrees", { projectId }),
  removeWorktree: (worktreeId: string) => invoke<void>("remove_worktree", { worktreeId }),
  worktreeStatusText: (worktreeId: string) =>
    invoke<WorktreeStatus>("worktree_status_text", { worktreeId }),
  exportSession: (args: ExportArgs) => invoke<string>("export_session", args),
  search: (query: string, limit: number | null) =>
    invoke<SearchResult>("search", { query, limit }),
  /** Full persisted output for one Session, including text outside xterm's scrollback. */
  searchSessionLog: (sessionId: string, query: string, limit: number | null) =>
    invoke<SearchResult>("search_session_log", { sessionId, query, limit }),
  rebuildSearchIndex: () => invoke<void>("rebuild_search_index"),
  getTimeline: () => invoke<TimelineData>("get_timeline"),
  ackTimeline: () => invoke<void>("ack_timeline"),
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
  readLogTail: (sessionId: string, bytes: number) =>
    invoke<LogTail>("read_log_tail", { sessionId, bytes }),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  openInSystemTerminal: (path: string) => invoke<void>("open_in_system_terminal", { path }),
  pickDirectory: () => invoke<string | null>("pick_directory"),
  pickSavePath: (defaultName: string) =>
    invoke<string | null>("pick_save_path", { defaultName }),
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
  cb: (ev: { sessionId: string; code: number | null; signal: number | null }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; code: number | null; signal: number | null }>(
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
