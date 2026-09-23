// DTO adapters between the desktop view types (../types, camelCase) and the
// remote-protocol wire DTOs (./types). All shape knowledge of the remote
// surface lives here so backend.ts stays a thin method dispatcher.
// New desktop code.

import type {
  AdapterInstall,
  ArchivedSessionView,
  AttachInfo,
  CreateSessionResult,
  DestructiveRemovalOutcome,
  LogCursorView,
  NotificationSetup,
  Preset,
  ProbeCandidate,
  ProbeOutcome,
  ProjectView,
  RestartResult,
  RuntimeMessageEnvelope,
  SecretMeta,
  SessionView,
  StatusEventView,
  SupportedAgent,
  WorktreeView,
} from "../types";
import type {
  RemotePresetSummary,
  RemoteProjectSummary,
  RemoteSecretAddResult,
  RemoteSecretBackendStatus,
  RemoteSecretSummary,
  RemoteSessionAttachResult,
  RemoteSessionLaunchResult,
  RemoteSessionSummary,
  RemoteStatusSummary,
  RemoteSupportedAgentSummary,
  RemoteAgentProbeResult,
  RemoteWorktreeRemoveResult,
  RemoteWorktreeSummary,
  RunCursor,
  StatusCursor,
} from "./types";

/**
 * AttachInfo-shaped view of a remote attachment. Local-only Host facts
 * (hostPid, protocol revision, logBytes) are null: the wire deliberately
 * omits them. `attachmentId` is the server-issued STRING (AttachInfo carries
 * the `number | string` union; the `remote` discriminant identifies this
 * shape).
 */
export interface RemoteAttachInfo extends AttachInfo {
  remote: true;
  attachmentId: string;
  sessionId: string;
  features: string[];
}

/**
 * Desktop LogCursorView carries no status_sequence. Synthesizing 0 is
 * conservative: the remote treats the cursor as "status replay starts at run
 * start", which can re-deliver metadata but never skips output bytes.
 */
export function logCursorToRunCursor(
  cursor: LogCursorView,
  statusSequence = 0,
): RunCursor {
  return {
    runId: cursor.runId,
    runOrdinal: cursor.runOrdinal,
    generation: cursor.generation,
    offset: cursor.offset,
    statusSequence,
  };
}

export function runCursorToLogCursor(cursor: RunCursor): LogCursorView {
  return {
    runId: cursor.runId,
    runOrdinal: cursor.runOrdinal,
    generation: cursor.generation,
    offset: cursor.offset,
  };
}

export function statusCursorOf(event: {
  runId: string;
  runOrdinal: number;
  sequence: number;
}): StatusCursor {
  return {
    runId: event.runId,
    runOrdinal: event.runOrdinal,
    sequence: event.sequence,
  };
}

/** StatusSummary lacks sessionId/evidence/logCursor; they arrive on events. */
export function remoteStatusToStatusEventView(
  sessionId: string,
  status: RemoteStatusSummary,
): StatusEventView {
  return {
    sessionId,
    runId: status.runId,
    runOrdinal: status.runOrdinal,
    sequence: status.sequence,
    state: status.state,
    source: status.source,
    confidence: status.confidence,
    evidence: null,
    logCursor: null,
    occurredAt: status.occurredAt,
  };
}

/**
 * Remote unread maps to unreadAttention. The active Session is treated as
 * seen, mirroring the desktop list_projects activeSession hint.
 */
export function remoteSessionToSessionView(
  summary: RemoteSessionSummary,
  activeSessionId: string | null,
): SessionView {
  return {
    id: summary.id,
    projectId: summary.projectId,
    worktreeId: summary.worktreeId,
    title: summary.title,
    adapter: summary.adapterType,
    cwd: summary.cwd,
    lifecycle: summary.lifecycle,
    hostAlive: summary.hostAlive,
    agentSessionId: summary.agentSessionId,
    resumePrecision: summary.resumePrecision,
    permissionMode: summary.permissionMode,
    transport: summary.transport === "json_rpc" ? "json_rpc" : "pty",
    unread: summary.unreadAttention && summary.id !== activeSessionId,
    status: summary.latestStatus
      ? remoteStatusToStatusEventView(summary.id, summary.latestStatus)
      : null,
    pinnedAt: summary.pinnedAt,
    createdAt: summary.createdAt,
  };
}

/** WorktreeSummary has no baseRef on the wire; null is the honest value. */
export function remoteWorktreeToWorktreeView(
  summary: RemoteWorktreeSummary,
): WorktreeView {
  return {
    id: summary.id,
    branch: summary.branch,
    baseCommit: summary.baseCommit,
    baseRef: null,
    path: summary.path,
    health: summary.health,
  };
}

export function assembleProjectView(
  project: RemoteProjectSummary,
  sessions: SessionView[],
  worktrees: WorktreeView[],
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    gitRootPath: project.gitRootPath,
    pinned: project.pinned,
    sessions,
    worktrees,
  };
}

export function remoteAttachResultToRemoteAttachInfo(
  result: RemoteSessionAttachResult,
): RemoteAttachInfo {
  return {
    remote: true,
    attachmentId: result.attachmentId,
    sessionId: result.sessionId,
    hostPid: null,
    protocol: null,
    childAlive: result.childAlive,
    logBytes: null,
    agentSessionId: result.agentSessionId,
    runId: result.runId,
    runOrdinal: result.runOrdinal,
    status: null,
    logCursor: result.cursor ? runCursorToLogCursor(result.cursor) : null,
    terminalGeometry: result.terminalGeometry ?? null,
    screenSnapshot: result.screenSnapshot,
    features: result.features,
  };
}

function launchNoticesToEnvelopes(
  notices: { code: string; message: string }[],
): RuntimeMessageEnvelope[] {
  return notices.map((notice) => ({ code: notice.code, message: notice.message }));
}

/**
 * Remote launch results carry no hostPid/childAlive/command (desktop-only
 * facts). attach.childAlive is reported true optimistically: liveness arrives
 * authoritatively through session state/exit events. `command` is empty
 * because the remote launch argv is never exposed on the wire.
 */
export function remoteLaunchToCreateSessionResult(
  result: RemoteSessionLaunchResult,
): CreateSessionResult {
  return {
    id: result.sessionId,
    attach: { hostPid: 0, childAlive: true },
    resumePrecision: result.resumePrecision,
    agentSessionId: result.agentSessionId,
    notes: [],
    notices: launchNoticesToEnvelopes(result.notices),
    command: [],
  };
}

export function remoteLaunchToRestartResult(
  result: RemoteSessionLaunchResult,
): RestartResult {
  return {
    resumePrecision: result.resumePrecision,
    agentSessionId: result.agentSessionId,
    notes: [],
    notices: launchNoticesToEnvelopes(result.notices),
    hostPid: 0,
  };
}

export function remoteSummaryToArchivedSessionView(
  summary: RemoteSessionSummary,
  projectName: string,
): ArchivedSessionView {
  return {
    id: summary.id,
    projectId: summary.projectId,
    projectName,
    title: summary.title,
    adapter: summary.adapterType as ArchivedSessionView["adapter"],
    createdAt: summary.createdAt,
    archivedAt: summary.archivedAt ?? "",
  };
}

/** Desktop secret_status() resolves a plain backend label. */
export function remoteSecretStatusToBackendString(
  status: RemoteSecretBackendStatus,
): string {
  return status.backend ?? status.state;
}

export function remoteSecretSummaryToSecretMeta(
  summary: RemoteSecretSummary,
): SecretMeta {
  return {
    id: summary.id,
    envName: summary.envName,
    backend: summary.backend,
    updatedAt: summary.updatedAt,
  };
}

export function remoteSecretAddResultToSecretMeta(
  result: RemoteSecretAddResult,
): SecretMeta {
  return { id: result.id, envName: result.envName, backend: result.backend };
}

/** PresetSummary omits args on the wire; [] is the honest value. */
export function remotePresetToPreset(summary: RemotePresetSummary): Preset {
  return {
    id: summary.id,
    agentType: summary.agent as Preset["agentType"],
    name: summary.name,
    executablePath: summary.executablePath,
    args: [],
    permissionMode: summary.permissionMode,
    envNames: summary.envNames,
    secretRefIds: summary.secretRefIds,
    builtIn: summary.builtIn,
  };
}

export function remoteProbeToProbeOutcome(result: RemoteAgentProbeResult): ProbeOutcome {
  return {
    agent: result.agent as ProbeOutcome["agent"],
    displayName: result.displayName,
    state: result.state,
    reason: result.reason,
    reasonMessage: result.reasonCode
      ? {
          code: result.reasonCode,
          technicalDetail: result.reasonDetail ?? undefined,
          message: result.reason ?? undefined,
        }
      : null,
    notificationSetup: (result.notificationSetup ?? null) as NotificationSetup | null,
    install: (result.install ?? null) as AdapterInstall | null,
    candidates: (result.candidates ?? []) as ProbeCandidate[],
  };
}

export function remoteSupportedAgentToSupportedAgent(
  summary: RemoteSupportedAgentSummary,
): SupportedAgent {
  return {
    agent: summary.agent as SupportedAgent["agent"],
    displayName: summary.displayName,
    commandNames: summary.commandNames,
  };
}

/** Native cleanup warnings travel via a local-only event; remotely dropped. */
export function remoteWorktreeRemoveToDestructiveOutcome(
  result: RemoteWorktreeRemoveResult,
): DestructiveRemovalOutcome {
  return {
    stopWarnings: result.stopWarnings,
    cleanupWarnings: result.cleanupWarnings,
  };
}
