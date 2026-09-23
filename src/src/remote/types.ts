// Wire DTOs for the AgentPort remote protocol (crates/agentport-remote-protocol
// + the agentport-service result shapes). Everything in this file describes
// JSON received from / sent to a remote Bridge — field names match the wire
// exactly. New desktop code; do not confuse with mobile's GPL client stack.
//
// Convention: the protocol crate serializes params camelCase; HostFrame event
// payloads keep snake_case fields with camelCase nested DTOs (LogCursor,
// TerminalGeometry). Both shapes live here, clearly separated.

import type {
  AgentStateStr,
  ConfidenceStr,
  LifecycleStr,
  LogCursorView,
  PermissionStr,
  ResumePrecisionStr,
  StateSourceStr,
  TerminalGeometry,
  WorktreeHealthStr,
} from "../types";

// ---------------------------------------------------------------------------
// Frozen Tauri command contract (src-tauri remote module, built in parallel)
// ---------------------------------------------------------------------------

/** remote_connect result: negotiated hello facts for one device. */
export interface RemoteHello {
  protocolVersion: string | number;
  capabilities: string[];
  deviceName: string;
}

/** remote_subscribe Channel message: one ServerEnvelope::Event. */
export interface RemoteEventWire {
  subscriptionId: string;
  eventType: string;
  cursor: RunCursor;
  payload: unknown;
}

/** Injectable invoke surface so tests never touch @tauri-apps/api. */
export type RemoteInvoker = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Minimal structural view of tauri.Channel used by remote_subscribe. */
export interface ChannelLike<T> {
  onmessage: (message: T) => void;
  toJSON?: () => unknown;
}

export type ChannelFactory<T> = () => ChannelLike<T>;

// ---------------------------------------------------------------------------
// Protocol primitives (camelCase wire)
// ---------------------------------------------------------------------------

/** agentport_remote_protocol::RunCursor — the remote consumed-byte position. */
export interface RunCursor {
  runId: string;
  runOrdinal: number;
  generation: number;
  offset: number;
  statusSequence: number;
}

/** agentport_remote_protocol::StatusCursor — required by session.seen.mark. */
export interface StatusCursor {
  runId: string;
  runOrdinal: number;
  sequence: number;
}

/** agentport_remote_protocol::AttentionCursor. */
export interface AttentionCursor {
  occurredAt: string;
  sessionId: string;
  runOrdinal: number;
  sequence: number;
}

// ---------------------------------------------------------------------------
// Service result DTOs (agentport-service, camelCase wire)
// ---------------------------------------------------------------------------

export interface RemoteStatusSummary {
  runId: string;
  runOrdinal: number;
  sequence: number;
  state: AgentStateStr;
  source: StateSourceStr;
  confidence: ConfidenceStr;
  occurredAt: string;
}

/** Remote-safe Session view: no Host token, socket path, PID, or log path. */
export interface RemoteSessionSummary {
  id: string;
  projectId: string;
  worktreeId: string | null;
  presetId: string;
  title: string;
  cwd: string;
  lifecycle: LifecycleStr;
  agentSessionId: string | null;
  resumePrecision: ResumePrecisionStr;
  adapterType: string;
  transport: string;
  permissionMode: PermissionStr;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  latestStatus: RemoteStatusSummary | null;
  hostAlive: boolean;
  latestAttentionKind:
    | "approval_requested"
    | "turn_completed"
    | "execution_failed"
    | null;
  unreadAttention: boolean;
}

export interface RemoteProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  gitRootPath: string | null;
  createdAt: string;
  pinned: boolean;
  sortOrder: number;
}

export interface RemoteWorktreeSummary {
  id: string;
  projectId: string;
  branch: string;
  baseCommit: string;
  path: string;
  health: WorktreeHealthStr;
  createdAt: string;
}

export interface RemoteServiceCapability {
  name: string;
  enabled: boolean;
  disabledReason?: string | null;
}

export interface RemoteServiceSnapshot {
  capabilities: RemoteServiceCapability[];
  limits: {
    maxSubscriptions: number;
    maxHostClients: number;
  };
}

export interface RemoteBootSnapshot {
  reconciledSessions: number;
  service: RemoteServiceSnapshot;
  projects: RemoteProjectSummary[];
  sessions: RemoteSessionSummary[];
}

/** session.attach result value. attachmentId is a server-issued STRING. */
export interface RemoteSessionAttachResult {
  attachmentId: string;
  sessionId: string;
  childAlive: boolean;
  agentSessionId: string | null;
  cursor: RunCursor | null;
  features: string[];
  runId: string;
  runOrdinal: number;
  terminalGeometry: TerminalGeometry | null;
  screenSnapshot?: unknown;
}

/** session.create / session.restart result value. */
export interface RemoteSessionLaunchResult {
  sessionId: string;
  resumePrecision: ResumePrecisionStr;
  agentSessionId: string | null;
  notices: { code: string; message: string }[];
  // hostPid / childAlive / command are desktop-only launch facts and are
  // never serialized onto the remote wire.
}

export interface RemoteSessionInputResult {
  batchId: string;
  serverSequence: number;
  phase: "accepted" | "completed" | "not_executed" | "unknown" | string;
}

export interface RemoteSessionControlResult {
  accepted: boolean;
  terminalGeometry?: TerminalGeometry | null;
}

export interface RemoteSessionStopResult {
  sessionId: string;
  groupCleaned: boolean;
}

export interface RemoteSessionEvent {
  eventType: string;
  cursor: RunCursor;
  payload: unknown;
}

export interface RemoteSessionPollResult {
  attachmentId: string;
  closed: boolean;
  events: RemoteSessionEvent[];
}

export interface RemoteAttentionEvent {
  sessionId: string;
  runId: string;
  kind: string;
  cursor: AttentionCursor;
}

/** Input of the local `remote_attention_notify` command (Rust synthesizes the
 * equivalent StatusEvent and runs the usual notification pipeline). */
export interface RemoteAttentionNotifyInput {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  sessionTitle: string;
  runId: string;
  runOrdinal: number;
  sequence: number;
  kind: string;
  occurredAt: string;
}

export interface RemoteAttentionPollResult {
  events: RemoteAttentionEvent[];
  nextCursor: AttentionCursor | null;
}

export interface RemoteSecretBackendStatus {
  state: string;
  backend: string | null;
  reason?: string | null;
}

export interface RemoteSecretSummary {
  id: string;
  envName: string;
  backend: string;
  updatedAt: string;
}

export interface RemoteSecretAddResult {
  id: string;
  envName: string;
  backend: string;
}

export interface RemotePresetSummary {
  id: string;
  agent: string;
  name: string;
  executablePath: string;
  permissionMode: PermissionStr;
  envNames: string[];
  secretRefIds: string[];
  builtIn: boolean;
}

export interface RemoteProjectAddResult {
  project: RemoteProjectSummary;
  focusedExisting: boolean;
}

export interface RemoteWorktreeRemoveResult {
  stopWarnings: number;
  cleanupWarnings: number;
  nativeCleanupWarnings: number;
}

export interface RemoteAgentProbeResult {
  agent: string;
  displayName: string;
  state: "available" | "conflict" | "unavailable";
  reason: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  install: unknown;
  candidates: unknown[];
  notificationSetup: unknown | null;
}

export interface RemoteSupportedAgentSummary {
  agent: string;
  displayName: string;
  commandNames: string[];
  install: unknown;
  notificationSetup: unknown | null;
}

// ---------------------------------------------------------------------------
// HostFrame event payloads (snake_case fields, camelCase nested DTOs)
// ---------------------------------------------------------------------------

interface HostFrameBase {
  type: string;
  session_id?: string;
}

export interface OutputPayload extends HostFrameBase {
  type: "output";
  data: string; // base64
  offset: number;
  cursor: LogCursorView;
}

export interface TransientOutputPayload extends HostFrameBase {
  type: "transient_output";
  data: string; // base64
}

export interface ProcessStatusPayload extends HostFrameBase {
  type: "process_status";
  suspended: boolean;
  signal: number | null;
}

export interface StructuredPayload extends HostFrameBase {
  type: "structured";
  event: Record<string, unknown>;
}

export interface ReplayDonePayload extends HostFrameBase {
  type: "replay_done";
  offset: number;
  cursor: LogCursorView;
  partial_context?: boolean;
}

export interface ResyncRequiredPayload extends HostFrameBase {
  type: "resync_required";
  earliest: LogCursorView;
  reason: string;
}

export interface StatePayload extends HostFrameBase {
  type: "state";
  run_id: string;
  run_ordinal: number;
  sequence: number;
  state: AgentStateStr;
  source: StateSourceStr;
  confidence: ConfidenceStr;
  evidence?: string | null;
  log_cursor?: LogCursorView | null;
  occurred_at: string;
}

export interface AgentSessionPayload extends HostFrameBase {
  type: "agent_session";
  agent_session_id: string;
  resume_precision?: string;
}

export interface HeartbeatPayload extends HostFrameBase {
  type: "heartbeat";
  at: string;
  log_bytes: number;
  log_cursor: LogCursorView;
}

export interface ExitPayload extends HostFrameBase {
  type: "exit";
  run_id: string;
  run_ordinal: number;
  code: number | null;
  signal: number | null;
  group_cleaned: boolean;
  reason: string;
}

export interface ResizeAckPayload extends HostFrameBase {
  type: "resize_ack";
  accepted: boolean;
  geometry: TerminalGeometry;
  reason?: string | null;
}

export interface TerminalGeometryChangedPayload extends HostFrameBase {
  type: "terminal_geometry_changed";
  geometry: TerminalGeometry;
}

export interface ErrorPayload {
  type: "error";
  session_id?: string | null;
  message: string;
  code?: string | null;
  params?: Record<string, unknown> | null;
  technical_detail?: string | null;
}

export interface InputBatchAckPayload extends HostFrameBase {
  type: "input_batch_ack";
  batch_id: string;
  server_sequence: number;
  phase: string;
  message?: string | null;
}
