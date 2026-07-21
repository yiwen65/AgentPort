// Shared view types mirroring the Tauri command contracts in
// src-tauri/src/main.rs and the core models in crates/agentport-core.
// Field names match the serialized JSON exactly (camelCase where the
// backend applies #[serde(rename_all = "camelCase")] or explicit json! keys).

export type AgentTypeStr = "claude" | "codex" | "kimi" | "shell";
export type AgentStateStr = "working" | "needs_input" | "idle" | "exited" | "unknown";
export type StateSourceStr = "hook" | "pty" | "process" | "adapter";
export type ConfidenceStr = "low" | "medium" | "high";
export type LifecycleStr = "creating" | "running" | "interrupted" | "exited" | "stopped";
export type PermissionStr = "native" | "auto" | "bypass";
export type ResumePrecisionStr = "exact" | "latest" | "unavailable";
export type WorktreeHealthStr = "clean" | "dirty" | "missing" | "locked";
export type ThemeSetting = "system" | "dark" | "light";
export type ReducedMotionSetting = "system" | "on" | "off";

/** One status transition with evidence (PRD 3.4 / 4.3). */
export interface StatusEventView {
  sessionId: string;
  sequence: number;
  state: AgentStateStr;
  source: StateSourceStr;
  confidence: ConfidenceStr;
  evidence: string | null;
  occurredAt: string;
}

export interface SessionView {
  id: string;
  projectId: string;
  worktreeId: string | null;
  title: string;
  adapter: string;
  cwd: string;
  lifecycle: LifecycleStr;
  agentSessionId: string | null;
  resumePrecision: ResumePrecisionStr;
  permissionMode: PermissionStr;
  logPath: string;
  unread: boolean;
  status: StatusEventView | null;
  createdAt: string;
}

/** Archived sessions are shown only in Settings > 归档会话. */
export interface ArchivedSessionView {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  adapter: AgentTypeStr;
  createdAt: string;
  archivedAt: string;
}

export interface WorktreeView {
  id: string;
  branch: string;
  baseCommit: string;
  baseRef: string | null;
  path: string;
  health: WorktreeHealthStr;
}

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  gitRootPath: string | null;
  sessions: SessionView[];
  worktrees: WorktreeView[];
}

export interface Settings {
  logLimitMib: number;
  notificationsEnabled: boolean;
  retentionDays: number;
  theme: ThemeSetting;
  terminalFontFamily: string;
  terminalFontSize: number;
  reducedMotion: ReducedMotionSetting;
  screenReaderMode: boolean;
  searchIndexEnabled: boolean;
  /** Hard constraint: always false (PRD ch.5). */
  telemetryEnabled: boolean;
}

export interface ProbeCandidate {
  path: string;
  versionText: string | null;
  /** "system_path" | "login_shell_path" | "well_known_dir" | "manual" */
  source: string;
}

export interface AdapterInstall {
  agentType: AgentTypeStr;
  executablePath: string;
  versionText: string;
  capabilityHash: string;
  exactResume: boolean;
  hookStatus: "supported" | "degraded" | "unavailable";
  probedAt: string;
  candidates: ProbeCandidate[];
  flags: string[];
}

export interface Preset {
  id: string;
  agentType: AgentTypeStr;
  name: string;
  executablePath: string;
  args: string[];
  permissionMode: PermissionStr;
  envNames: string[];
  secretRefIds: string[];
  builtIn: boolean;
}

export interface PlatformInfo {
  /** "macos" | "linux" */
  os: string;
  osVersion: string;
  arch: string;
  webview: string | null;
  appVersion: string;
}

export interface TimelineEntry {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  adapterType: AgentTypeStr;
  state: AgentStateStr;
  source: StateSourceStr;
  confidence: ConfidenceStr;
  occurredAt: string;
  logOffset: number | null;
  rotatedAway: boolean;
}

export interface TimelineData {
  completed: number;
  waiting: number;
  failed: number;
  entries: TimelineEntry[];
}

/** Normalized boot payload (see note in api.ts about snake_case keys). */
export interface BootInfo {
  platform: PlatformInfo;
  settings: Settings;
  adapters: AdapterInstall[];
  projects: ProjectView[];
  timeline: TimelineData;
  secretBackend: string;
  indexState: string;
  webview: string;
}

export interface ProbeOutcome {
  agent: AgentTypeStr;
  displayName: string;
  state: "available" | "conflict" | "unavailable";
  reason: string | null;
  install: AdapterInstall | null;
  candidates: ProbeCandidate[];
}

export interface CreateSessionResult {
  id: string;
  attach: { hostPid: number; childAlive: boolean };
  resumePrecision: ResumePrecisionStr;
  agentSessionId: string | null;
  notes: string[];
  command: string[];
}

export interface AttachInfo {
  hostPid: number;
  childAlive: boolean;
  logBytes: number;
  agentSessionId: string | null;
}

/** Messages pushed by the backend over the attach Channel (watch_loop). */
export type ChannelMsg =
  | { t: "output"; data: string; offset: number }
  | { t: "replay_done"; offset?: number }
  | { t: "state"; event: StatusEventView }
  | { t: "agent_session"; id: string }
  | { t: "heartbeat"; logBytes: number }
  | { t: "exit"; code: number | null; signal: number | null; groupCleaned: boolean }
  | { t: "error"; message: string }
  | { t: "detached"; message?: string };

export interface WorktreeStatus {
  health: WorktreeHealthStr;
  modified: number;
  staged: number;
  untracked: number;
  raw: string;
}

export interface SearchHit {
  kind: "project" | "session" | "branch" | "terminal";
  sessionId: string | null;
  projectId: string | null;
  title: string;
  snippet: string;
  logOffset: number | null;
  rotatedAway: boolean;
}

export interface SearchResult {
  partial: boolean;
  hits: SearchHit[];
  /** Present for a focused-session log query; independent from the display cap. */
  totalHits?: number;
}

export interface HostInfo {
  sessionId: string;
  title: string;
  hostPid: number | null;
  alive: boolean;
  socketPath: string | null;
  logBytes: number;
  lifecycle: string;
}

export interface SecretMeta {
  id: string;
  envName: string;
  backend: string;
  account?: string;
  updatedAt?: string;
}

export interface AddProjectResult {
  id: string;
  name?: string;
  rootPath?: string;
  gitRootPath?: string | null;
  focusedExisting?: boolean;
}

export interface CreateWorktreeResult {
  id: string;
  branch: string;
  path: string;
  baseCommit: string;
}

export interface RestartResult {
  resumePrecision: ResumePrecisionStr;
  agentSessionId: string | null;
  notes: string[];
  hostPid: number;
}

/** read_log_tail response: last bytes of a session's raw output log. */
export interface LogTail {
  /** base64 of the tail bytes */
  data: string;
  /** byte offset of data[0] within the current log generation */
  offset: number;
  /** total log size in bytes */
  total: number;
}
