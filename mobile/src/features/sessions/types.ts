export interface RunCursor {
  runId: string;
  runOrdinal: number;
  generation: number;
  offset: number;
  statusSequence: number;
}

export interface SessionStatus {
  runId: string;
  runOrdinal: number;
  sequence: number;
  state: string;
  source: string;
  confidence: string;
  occurredAt: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  worktreeId?: string;
  presetId: string;
  title: string;
  cwd: string;
  lifecycle: string;
  agentSessionId?: string;
  resumePrecision: string;
  adapterType: string;
  transport: string;
  permissionMode: string;
  pinnedAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  latestStatus?: SessionStatus;
  hostAlive?: boolean;
  unreadAttention?: boolean;
  latestAttentionKind?: AttentionKind;
  statusEvidence?: string;
}

export type AttentionKind = "approval_requested" | "turn_completed" | "execution_failed";

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  pinned: boolean;
  sortOrder: number;
}

export interface SupportedAgent {
  agent: string;
  displayName: string;
  install: unknown | null;
}

export interface AgentPreferences {
  revision: number;
  agentOrder: string[];
  agentHidden: string[];
}

export interface AttentionEvent {
  sessionId: string;
  sessionTitle?: string;
  kind: AttentionKind;
  runId: string;
  runOrdinal: number;
  sequence: number;
  occurredAt: string;
}

export interface AttentionCursor {
  occurredAt: string;
  sessionId: string;
  runOrdinal: number;
  sequence: number;
}

export interface AttentionPollEvent {
  sessionId: string;
  runId: string;
  kind: AttentionKind;
  cursor: AttentionCursor;
}

export interface AttentionPollResult {
  events: AttentionPollEvent[];
  nextCursor?: AttentionCursor;
}

export interface TerminalGeometry {
  runId: string;
  runOrdinal: number;
  cols: number;
  rows: number;
  sourceKind: "desktop" | "mobile";
  sourceDeviceId?: string;
  attachmentId?: string;
  orientation?: "portrait" | "landscape";
  revision: number;
  updatedAt: string;
}

export interface SessionAttachResult {
  screenSnapshot?: import("../../terminal/terminalCheckpoint").TerminalScreen;
  attachmentId: string;
  sessionId: string;
  childAlive: boolean;
  agentSessionId?: string;
  cursor?: RunCursor;
  features: string[];
  runId: string;
  runOrdinal: number;
  terminalGeometry?: TerminalGeometry;
}

export interface SessionEventPayload {
  type?: string;
  sessionId?: string;
  session_id?: string;
  dataBase64?: string;
  data?: string;
  event?: unknown;
  state?: string;
  source?: string;
  confidence?: string;
  evidence?: string;
  occurredAt?: string;
  occurred_at?: string;
  runId?: string;
  run_id?: string;
  runOrdinal?: number;
  run_ordinal?: number;
  sequence?: number;
  groupCleaned?: boolean;
  group_cleaned?: boolean;
  reason?: string;
  message?: string;
  geometry?: TerminalGeometry;
}

export interface OpenSession {
  hostProfileId: string;
  hostName: string;
  projectName?: string;
  session: SessionSummary;
}
