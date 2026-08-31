// Shared view types mirroring the Tauri command contracts in
// src-tauri/src/main.rs and the core models in crates/agentport-core.
// Field names match the serialized JSON exactly (camelCase where the
// backend applies #[serde(rename_all = "camelCase")] or explicit json! keys).

export type AgentTypeStr =
  | "claude"
  | "codex"
  | "kimi"
  | "qoder"
  | "pi"
  | "shell";
export type AgentTransportStr = "pty" | "json_rpc";
export type AgentStateStr =
  | "working"
  | "needs_input"
  | "idle"
  | "exited"
  | "unknown";
export type StateSourceStr = "hook" | "pty" | "process" | "adapter";
export type ConfidenceStr = "low" | "medium" | "high";
export type LifecycleStr =
  | "creating"
  | "running"
  | "interrupted"
  | "exited"
  | "stopped";
export type PermissionStr = "native" | "auto" | "bypass";
export type ResumePrecisionStr = "exact" | "latest" | "unavailable";
export type WorktreeHealthStr = "clean" | "dirty" | "missing" | "locked";
export type WorktreeBranchMode = "auto" | "new" | "existing";
export type ThemeSetting = "system" | "dark" | "light";
export type TerminalThemeId =
  | "one"
  | "cupertino"
  | "graphite"
  | "aurora"
  | "ember"
  | "sakura";
export type ReducedMotionSetting = "system" | "on" | "off";
export type UiLanguage = "zh-CN" | "en-US";

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
  /** Backend-verified Host liveness; absent legacy/test payloads fail closed. */
  hostAlive?: boolean;
  agentSessionId: string | null;
  resumePrecision: ResumePrecisionStr;
  permissionMode: PermissionStr;
  transport: AgentTransportStr;
  logPath: string;
  unread: boolean;
  status: StatusEventView | null;
  /** RFC3339 pin timestamp; null means unpinned. Latest pin sorts first. */
  pinnedAt: string | null;
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
  pinned: boolean;
  sessions: SessionView[];
  worktrees: WorktreeView[];
}

/** Complete canonical Project layout; pinned entries must come first. */
export interface ProjectLayoutEntry {
  id: string;
  pinned: boolean;
}

export interface Settings {
  logLimitMib: number;
  notificationsEnabled: boolean;
  uiLanguage: UiLanguage;
  theme: ThemeSetting;
  terminalTheme: TerminalThemeId;
  terminalFontFamily: string;
  terminalFontSize: number;
  /** Optional Linux terminal emulator executable; no arguments are parsed. */
  terminalCommand: string;
  reducedMotion: ReducedMotionSetting;
  screenReaderMode: boolean;
  searchIndexEnabled: boolean;
  /** Ordered quick-launch icons; new adapters append after saved entries. */
  agentOrder: string[];
  /** Adapters removed from pickers; detection results are kept for restore. */
  agentHidden: string[];
  /** Hard constraint: always false (PRD ch.5). */
  telemetryEnabled: boolean;
}

export interface ProbeCandidate {
  path: string;
  versionText: string | null;
  /** system_path | login_shell_path | version_manager | well_known_dir | manual */
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
  timelineMessage?: RuntimeMessageEnvelope | null;
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
  /** Localizable application message from newer backends; `reason` remains for compatibility. */
  reasonMessage?: RuntimeMessageEnvelope | null;
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
  /** Stable localizable notices. Fall back to `notes` when connected to an older backend. */
  notices?: RuntimeMessageEnvelope[];
  command: string[];
}

export type RuntimeMessageParams = Record<
  string,
  string | number | boolean | null
>;

export interface RuntimeMessageEnvelope {
  /** Stable application-owned message identifier. Older Hosts may omit it. */
  code?: string;
  /** Named values safe to interpolate into localized UI copy. */
  params?: RuntimeMessageParams;
  /** Original backend detail retained for diagnostics, never used as a key. */
  technicalDetail?: string;
  /** Legacy display text kept for compatibility with already-running Hosts. */
  message?: string;
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
  | { t: "transient_output"; data: string }
  | { t: "process_status"; suspended: boolean; signal: number | null }
  | { t: "structured"; event: Record<string, unknown> }
  | {
      t: "replay_done";
      offset?: number;
      cursor?: LogCursorView;
      partialContext?: boolean;
    }
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
  | ({
      t: "error";
      message: string;
      persistenceDegraded?: boolean;
    } & RuntimeMessageEnvelope)
  | ({ t: "detached" } & RuntimeMessageEnvelope);

export interface WorktreeStatus {
  health: WorktreeHealthStr;
  modified: number;
  staged: number;
  untracked: number;
  ignored?: number;
  ignoredSample?: string[];
  raw: string;
}

export interface WorktreePreview {
  taskSlug: string;
  branch: string;
  path: string;
}

export interface WorktreeDeletePreflight {
  worktreeId: string;
  branch: string;
  path: string;
  health: WorktreeHealthStr;
  modified: number;
  staged: number;
  untracked: number;
  ignored: number;
  ignoredSample: string[];
  sessionCount: number;
  activeSessionCount: number;
  repositoryMissing: boolean;
  canRemove: boolean;
  blockers: string[];
}

export interface ConfirmedArchivedSession {
  id: string;
  archiveGeneration: number;
}

export interface DestructiveRemovalOutcome {
  stopWarnings: number;
  cleanupWarnings: number;
}

export interface ProjectRemovalPreflight {
  projectId: string;
  sessionCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  archivedSessions: ConfirmedArchivedSession[];
  worktreeCount: number;
  recoverableOperationCount: number;
  pendingCommitOperationCount: number;
  canRemove: boolean;
}

export interface SearchHit {
  kind: "project" | "session" | "branch" | "terminal";
  sessionId: string | null;
  projectId: string | null;
  title: string;
  snippet: string;
  eventId?: string;
  provider?: AgentTypeStr;
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
  notices?: RuntimeMessageEnvelope[];
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
  /** Stable action IDs from current backends; absent on older versions. */
  recoveryActionCodes?: string[];
  diagnostics: Record<string, unknown>;
  liveSessionIds: string[];
}

// ---------------------------------------------------------------------------
// Git Center — checkout-scoped contracts
// ---------------------------------------------------------------------------

export type GitContextLocator =
  | { kind: "session"; sessionId: string }
  | { kind: "projectMain"; projectId: string }
  | { kind: "worktree"; projectId: string; worktreeId: string };

export type GitCheckoutKind = "main" | "worktree";

export interface GitCheckoutDescriptor {
  target: {
    projectId: string;
    kind: GitCheckoutKind;
    worktreeId: string | null;
  };
  checkoutId: string;
  repoKey: string;
  projectName: string;
  projectRoot: string;
  checkoutRoot: string;
  expectedBranch: string | null;
  actualBranch: string | null;
  headOid: string | null;
  detached: boolean;
  unborn: boolean;
  ongoingOperation: string | null;
  hasRemote: boolean;
  remote: string | null;
  remoteUrl: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  worktreeHealth: string | null;
  liveSessionIds: string[];
  writable: boolean;
  blockers: string[];
  warnings: string[];
}

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "conflict"
  | "untracked"
  | "ignored";

export interface GitChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  ignored: number;
  conflict: number;
  renamed: number;
  submodule: number;
}

export interface GitChangeEntry {
  entryToken: string;
  pathToken: string;
  displayPath: string;
  oldPathToken: string | null;
  displayOldPath: string | null;
  indexStatus: string | null;
  worktreeStatus: string | null;
  conflictCode: string | null;
  kind: GitChangeKind;
  submoduleState: string | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

export interface GitChangesSnapshot {
  context: GitCheckoutDescriptor;
  statusToken: string;
  complete: boolean;
  partialReason: string | null;
  counts: GitChangeCounts;
  entries: GitChangeEntry[];
  observedAt: string;
}

export type GitDiffSide = "staged" | "unstaged";
export type GitDiffFormat = "text" | "binary" | "summary" | "conflict";

export interface GitFileDiff {
  context: GitCheckoutDescriptor;
  statusToken: string;
  side: GitDiffSide;
  pathToken: string;
  displayPath: string;
  format: GitDiffFormat;
  patch: string | null;
  additions: number | null;
  deletions: number | null;
  fileSize: number | null;
  truncated: boolean;
  reason: string | null;
  conflictCode: string | null;
}

export interface GitCommitSummary {
  oid: string;
  shortOid: string;
  parentOids: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
}

export interface GitHistoryPage {
  context: GitCheckoutDescriptor;
  anchorOid: string | null;
  commits: GitCommitSummary[];
  nextCursor: string | null;
  headChanged: boolean;
  observedAt: string;
}

export interface GitCommitFile {
  status: string;
  pathToken: string;
  displayPath: string;
  oldPathToken: string | null;
  displayOldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCommitDetail {
  context: GitCheckoutDescriptor;
  commit: GitCommitSummary;
  message: string;
  files: GitCommitFile[];
  selectedParentOid: string | null;
}

export interface GitCommitPatch {
  context: GitCheckoutDescriptor;
  commitOid: string;
  parentOid: string | null;
  pathToken: string | null;
  format: GitDiffFormat;
  patch: string | null;
  truncated: boolean;
  reason: string | null;
}

export interface GitPathSelection {
  pathToken: string;
  entryToken: string;
}

export interface GitMutationResult {
  operationId: string;
  changes: GitChangesSnapshot;
}

export type GitIgnoreTarget = "repository" | "local";
export type GitRemoteAction =
  | "fetch"
  | "pull"
  | "pull_autostash"
  | "pull_rebase"
  | "pull_rebase_autostash"
  | "push"
  | "force_push";

export type CommitAiProvider = "openai" | "anthropic";

export type CommitAiLanguage = "zh" | "en";

export interface CommitAiConfig {
  provider: CommitAiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  language: CommitAiLanguage;
}

export interface GitCommitMessageSuggestion {
  statusToken: string;
  subject: string;
  body: string;
  message: string;
  truncated: boolean;
}

export interface GitResolvedFile {
  context: GitCheckoutDescriptor;
  displayPath: string;
  absolutePath: string;
}

export interface GitCommitScopeFile {
  status: string;
  pathToken: string;
  displayPath: string;
  oldPathToken: string | null;
  displayOldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  outsideProject: boolean;
}

export interface GitCommitReview {
  context: GitCheckoutDescriptor;
  commitToken: string;
  message: string;
  messageHash: string;
  beforeHead: string | null;
  indexHash: string;
  expectedTreeOid: string;
  files: GitCommitScopeFile[];
  outsideProjectPaths: string[];
  subjectOver72: boolean;
  warnings: string[];
}

export type GitCommitOutcome =
  | "succeeded"
  | "not_executed"
  | "scope_drift"
  | "indeterminate";

export interface GitCommitResult {
  operationId: string;
  outcome: GitCommitOutcome;
  beforeHead: string | null;
  afterHead: string | null;
  expectedTreeOid: string;
  actualTreeOid: string | null;
  changes: GitChangesSnapshot;
  error: string | null;
}

export interface GitWorkspaceCommandError {
  code: string;
  message: string;
  recoverable: boolean;
  currentChanges: GitChangesSnapshot | null;
}

export interface GitStateInvalidated {
  repoKey: string | null;
  checkoutIds: string[];
  scopes: string[];
  reason: string;
  operationId: string;
  observedAt: string;
}

/** Bounded binary log slice returned by recovery diagnostics. */
export interface LogTail {
  /** base64 of the tail bytes */
  data: string;
  /** byte offset of data[0] within the current log generation */
  offset: number;
  /** total log size in bytes */
  total: number;
}

export type HistoryRole = "user" | "assistant" | "tool" | "system";

export interface HistoryEvent {
  id: string;
  sourceId: string;
  provider: AgentTypeStr;
  kind: string;
  role: HistoryRole | null;
  timestamp: string | null;
  text: string;
}

export interface HistorySourceInfo {
  id: string;
  provider: AgentTypeStr;
  path: string;
  bytes: number;
}

export type HistorySourceStatus =
  | { status: "available"; sources: HistorySourceInfo[] }
  | { status: "unavailable"; reason: string }
  | { status: "ambiguous"; reason: string; candidates: number };

export interface HistoryPage {
  sourceStatus: HistorySourceStatus;
  events: HistoryEvent[];
  nextCursor: string | null;
  skippedLines: number;
}

export interface LegacyLogEntry {
  id: string;
  sessionId: string;
  runId: string | null;
  path: string;
  bytes: number;
  active: boolean;
  nativeStatus: HistorySourceStatus;
}

export interface LegacyLogInventory {
  entries: LegacyLogEntry[];
  totalBytes: number;
  deletableBytes: number;
}

export interface LegacyDeleteReport {
  deleted: string[];
  bytesReclaimed: number;
}

/** Bounded, generation-validated bytes surrounding a recovery cursor. */
export interface RecoveryLogContext extends LogTail {
  cursor: LogCursorView;
}

/** read_session_document response: text content for the in-app viewer. */
export interface SessionDocument {
  /** Canonical absolute path of the file that was read. */
  path: string;
  /** UTF-8 text; lossy-decoded and capped at the backend limit. */
  content: string;
  /** True when the file exceeded the backend cap and content is a prefix. */
  truncated: boolean;
  /** Full file size in bytes, even when truncated. */
  sizeBytes: number;
}

/** One entry from list_document_directory. */
export interface DocumentDirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** list_document_directory response. */
export interface DocumentDirListing {
  path: string;
  entries: DocumentDirEntry[];
  truncated: boolean;
}
