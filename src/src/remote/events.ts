// Synthesize desktop ChannelMsg messages from remote event envelopes. This
// mirrors the local watch_loop conversion in src-tauri/src/main.rs so the
// xterm attach path consumes one message shape regardless of device.
// New desktop code.

import type {
  ChannelMsg,
  RuntimeMessageParams,
  StatusEventView,
  TerminalResizeAck,
  TerminalGeometryEvent,
} from "../types";
import type {
  AgentSessionPayload,
  ErrorPayload,
  ExitPayload,
  HeartbeatPayload,
  OutputPayload,
  ProcessStatusPayload,
  RemoteEventWire,
  ReplayDonePayload,
  ResizeAckPayload,
  ResyncRequiredPayload,
  RunCursor,
  StatePayload,
  StructuredPayload,
  TerminalGeometryChangedPayload,
  TransientOutputPayload,
} from "./types";

function statePayloadToStatusEventView(payload: StatePayload): StatusEventView {
  return {
    sessionId: payload.session_id ?? "",
    runId: payload.run_id,
    runOrdinal: payload.run_ordinal,
    sequence: payload.sequence,
    state: payload.state,
    source: payload.source,
    confidence: payload.confidence,
    evidence: payload.evidence ?? null,
    logCursor: payload.log_cursor ?? null,
    occurredAt: payload.occurred_at,
  };
}

/**
 * The remote attachmentId is a string and flows through unchanged: the
 * desktop geometry event types carry `number | string` attachment ids and
 * terminals.ts only echoes them back into resize authority checks.
 */

/**
 * Convert one remote event envelope into the equivalent desktop ChannelMsg.
 * Returns null for events the desktop watch_loop also ignores (pong,
 * input_batch_ack, hello_ok) and for unknown future event types, so callers
 * can forward the result unconditionally.
 */
export function remoteEventToChannelMsg(event: RemoteEventWire): ChannelMsg | null {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return null;

  switch (event.eventType) {
    case "output": {
      const p = payload as unknown as OutputPayload;
      return { t: "output", data: p.data, offset: p.offset, cursor: p.cursor };
    }
    case "transient_output": {
      const p = payload as unknown as TransientOutputPayload;
      return { t: "transient_output", data: p.data };
    }
    case "process_status": {
      const p = payload as unknown as ProcessStatusPayload;
      return { t: "process_status", suspended: p.suspended, signal: p.signal };
    }
    case "structured": {
      const p = payload as unknown as StructuredPayload;
      return { t: "structured", event: p.event };
    }
    case "replay_done": {
      const p = payload as unknown as ReplayDonePayload;
      return { t: "replay_done", offset: p.offset, cursor: p.cursor };
    }
    case "resync_required": {
      const p = payload as unknown as ResyncRequiredPayload;
      return { t: "resync_required", earliest: p.earliest, reason: p.reason };
    }
    case "state": {
      const p = payload as unknown as StatePayload;
      return { t: "state", event: statePayloadToStatusEventView(p) };
    }
    case "agent_session": {
      const p = payload as unknown as AgentSessionPayload;
      return { t: "agent_session", id: p.agent_session_id };
    }
    case "heartbeat": {
      const p = payload as unknown as HeartbeatPayload;
      return { t: "heartbeat", logBytes: p.log_bytes, logCursor: p.log_cursor };
    }
    case "resize_ack": {
      const p = payload as unknown as ResizeAckPayload;
      const ack: TerminalResizeAck = {
        sessionId: p.session_id ?? "",
        attachmentId: event.subscriptionId,
        accepted: p.accepted,
        geometry: p.geometry,
        reason: p.reason ?? null,
      };
      return { t: "resize_ack", payload: ack };
    }
    case "terminal_geometry_changed": {
      const p = payload as unknown as TerminalGeometryChangedPayload;
      const changed: TerminalGeometryEvent = {
        sessionId: p.session_id ?? "",
        attachmentId: event.subscriptionId,
        geometry: p.geometry,
      };
      return { t: "terminal_geometry_changed", payload: changed };
    }
    case "exit": {
      const p = payload as unknown as ExitPayload;
      return {
        t: "exit",
        code: p.code,
        signal: p.signal,
        groupCleaned: p.group_cleaned,
        reason: p.reason,
        runId: p.run_id,
        runOrdinal: p.run_ordinal,
      };
    }
    case "error": {
      const p = payload as unknown as ErrorPayload;
      return {
        t: "error",
        message: p.message,
        code: p.code ?? undefined,
        params: (p.params ?? undefined) as RuntimeMessageParams | undefined,
        technicalDetail: p.technical_detail ?? undefined,
      };
    }
    // Ignored exactly like the desktop watch_loop ignores them.
    case "pong":
    case "input_batch_ack":
    case "hello_ok":
      return null;
    default:
      return null;
  }
}

/**
 * The envelope cursor names bytes consumed AFTER this event — the resume
 * position a later attach can pass as resumeFrom without losing output.
 */
export function remoteEventConsumedCursor(event: RemoteEventWire): RunCursor {
  return event.cursor;
}
