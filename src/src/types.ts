// Shared view types mirroring the Tauri command contracts in
// src-tauri/src/main.rs and the core models in crates/agentport-core.
// Field names match the serialized JSON exactly (camelCase where the
// backend applies #[serde(rename_all = "camelCase")] or explicit json! keys).

export type AgentTypeStr = "claude" | "codex" | "kimi" | "qoder" | "pi" | "shell";
export type AgentTransportStr = "pty" | "json_rpc";
export type AgentStateStr = "working" | "needs_input" | "idle" | "exited" | "unknown";
export type StateSourceStr = "hook" | "pty" | "process" | "adapter";
export type ConfidenceStr = "low" | "medium" | "high";
export type LifecycleStr = "creating" | "running" | "interrupted" | "exited" | "stopped";
export type PermissionStr = "native" | "auto" | "bypass";
export type ResumePrecisionStr = "exact" | "latest" | "unavailable";
export type WorktreeHealthStr = "clean" | "dirty" | "missing" | "locked";
export type WorktreeBranchMode = "auto" | "new" | "existing";
export type ThemeSetting = "system" | "dark" | "light";
export type ReducedMotionSetting = "system" | "on" | "off";

/** A status ordering key: run ordinal first, then its local sequence. */
export interface StatusCursorView {
  runId: string;
  runOrdinal: number;
  sequence: number;
}

/** A terminal byte position. Generation disambiguates rotated log offsets. */
export interface LogCursorView {
  runId: string;
  runOrdinal: number;
  generation: number;
  offset: number;
}

/** One status transition with evidence (PRD 3.4 / 4.3). */
export interface StatusEventView {
  sessionId: string;
  runId: string;
  runOrdinal: number;
  sequence: number;
  state: AgentStateStr;
  source: StateSourceStr;
  confidence: ConfidenceStr;
  evidence: string | null;
  logCursor: LogCursorView | null;
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
  transport: AgentTransportStr;
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
  theme: ThemeSetting;
  terminalFontFamily: string;
  terminalFontSize: number;
  /** Optional Linux terminal emulator executable; no arguments are parsed. */
  terminalCommand: string;
  reducedMotion: ReducedMotionSetting;
  screenReaderMode: boolean;
  searchIndexEnabled: boolean;
  /** Ordered quick-launch icons; new adapters append after saved entries. */
  agentOrder: string[];
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
  approvalModel: "native_prompts" | "no_builtin_prompts";
  defaultTransport: AgentTransportStr;
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
  evidence: string | null;
  occurredAt: string;
  statusCursor: StatusCursorView | null;
  logCursor: LogCursorView | null;
  logOffset: number | null;
  rotatedAway: boolean;
  locationUnavailableReason: string | null;
}

export interface TimelineData {
  completed: number;
  waiting: number;
  failed: number;
  entries: TimelineEntry[];
  ackSnapshots: TimelineAckSnapshot[];
}

/** Exact recovery facts rendered in one GUI snapshot and safe to acknowledge. */
export interface TimelineAckSnapshot {
  sessionId: string;
  statusCursor: StatusCursorView | null;
  logCursor: LogCursorView | null;
}

/** Normalized boot payload (see note in api.ts about snake_case keys). */
export interface BootInfo {
  platform: PlatformInfo;
  settings: Settings;
  adapters: AdapterInstall[];
  projects: ProjectView[];
  timeline: TimelineData;
  timelineError: string | null;
  secretBackend: string;
  indexState: string;
  webview: string;
  exportsDir: string;
}

export interface ProbeOutcome {
  agent: AgentTypeStr;
  displayName: string;
  state: "available" | "conflict" | "unavailable";
  reason: string | null;
  install: AdapterInstall | null;
  candidates: ProbeCandidate[];
}

/** One compiled-in Agent adapter advertised by the backend registry. */
export interface SupportedAgent {
  agent: AgentTypeStr;
  displayName: string;
  commandNames: string[];
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
  /** Server-issued capability for this renderer attachment. */
  attachmentId: number;
  hostPid: number;
  protocol: number;
  childAlive: boolean;
  logBytes: number;
  agentSessionId: string | null;
  runId: string;
  runOrdinal: number;
  status: StatusEventView | null;
  logCursor: LogCursorView;
}

/** Messages pushed by the backend over the attach Channel (watch_loop). */
export type ChannelMsg =
  | { t: "output"; data: string; offset: number; cursor: LogCursorView }
  | { t: "structured"; event: Record<string, unknown> }
  | { t: "replay_done"; offset?: number; cursor?: LogCursorView; partialContext?: boolean }
  | { t: "resync_required"; earliest: LogCursorView; reason: string }
  | { t: "state"; event: StatusEventView }
  | { t: "agent_session"; id: string }
  | { t: "heartbeat"; logBytes: number; logCursor: LogCursorView }
  | {
      t: "exit";
      code: number | null;
      signal: number | null;
      groupCleaned: boolean;
      reason: string;
      runId: string;
      runOrdinal: number;
    }
  | { t: "error"; message: string; persistenceDegraded?: boolean }
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

/** Git checkout state used by local-branch management. */
export interface RepositoryStatus {
  projectId: string;
  isGitRepository: boolean;
  checkoutRoot: string | null;
  repoKey: string | null;
  head: {
    kind: "branch" | "detached" | "unborn";
    branch?: string | null;
    oid?: string | null;
    shortOid?: string | null;
  };
  changes: {
    staged: number;
    unstaged: number;
    untracked: number;
    unmerged: number;
    dirtySubmodules: number;
  };
  ongoingOperation?: string | null;
  liveSessionIds: string[];
  pendingAutoStashes: number;
  observedAt: string;
  snapshotToken: string;
}

export interface LocalBranch {
  name: string;
  oid: string;
  current: boolean;
  checkedOutPath?: string | null;
  agentPortWorktreeId?: string | null;
}

export interface AutoStashRecord {
  id: string;
  operationId: string;
  projectId: string;
  sourceKind: string;
  sourceBranch?: string | null;
  sourceOid?: string | null;
  targetBranch: string;
  stashOid?: string | null;
  marker: string;
  createdAt: string;
  state: string;
  lastError?: string | null;
  restorable: boolean;
}

export interface BranchOperationResult {
  operationId: string;
  status: RepositoryStatus;
  autoStash?: AutoStashRecord | null;
}

export interface LocalBranchesResponse {
  status: RepositoryStatus;
  branches: LocalBranch[];
  autoStashes: AutoStashRecord[];
}

export interface RepositoryOperationProgress {
  operationId: string;
  command: string;
  projectId: string | null;
  branch: string | null;
  phase: string;
  message: string;
  coreOperationId: string | null;
  recoverable: boolean;
  occurredAt: string;
}

/** Structured rejection returned by Tauri for guarded repository mutations. */
export interface StructuredGitError {
  code: string;
  message: string;
  phase: string;
  operationId: string;
  recoverable: boolean;
  currentStatus: RepositoryStatus | null;
  recoveryActions: string[];
  diagnostics: Record<string, unknown>;
  liveSessionIds: string[];
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

/** Bounded, generation-validated bytes surrounding a recovery cursor. */
export interface RecoveryLogContext extends LogTail {
  cursor: LogCursorView;
}
