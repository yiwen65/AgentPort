import { describe, expect, it } from "vitest";
import { remoteEventConsumedCursor, remoteEventToChannelMsg } from "./events";
import type { RemoteEventWire, RunCursor } from "./types";

const CURSOR: RunCursor = {
  runId: "run-1",
  runOrdinal: 1,
  generation: 0,
  offset: 128,
  statusSequence: 2,
};

function wire(eventType: string, payload: unknown): RemoteEventWire {
  return { subscriptionId: "att-1", eventType, cursor: CURSOR, payload };
}

describe("remoteEventToChannelMsg", () => {
  it("maps output with its LogCursor payload untouched", () => {
    const cursor = { runId: "run-1", runOrdinal: 1, generation: 0, offset: 64 };
    expect(
      remoteEventToChannelMsg(
        wire("output", { type: "output", session_id: "ses_1", data: "aGk=", offset: 64, cursor }),
      ),
    ).toEqual({ t: "output", data: "aGk=", offset: 64, cursor });
  });

  it("maps transient_output and process_status", () => {
    expect(
      remoteEventToChannelMsg(
        wire("transient_output", { type: "transient_output", session_id: "s", data: "eA==" }),
      ),
    ).toEqual({ t: "transient_output", data: "eA==" });
    expect(
      remoteEventToChannelMsg(
        wire("process_status", {
          type: "process_status",
          session_id: "s",
          suspended: true,
          signal: 20,
        }),
      ),
    ).toEqual({ t: "process_status", suspended: true, signal: 20 });
  });

  it("maps structured and replay_done", () => {
    expect(
      remoteEventToChannelMsg(
        wire("structured", { type: "structured", session_id: "s", event: { kind: "x" } }),
      ),
    ).toEqual({ t: "structured", event: { kind: "x" } });
    const cursor = { runId: "run-1", runOrdinal: 1, generation: 0, offset: 128 };
    expect(
      remoteEventToChannelMsg(
        wire("replay_done", {
          type: "replay_done",
          session_id: "s",
          offset: 128,
          cursor,
          partial_context: true,
        }),
      ),
    ).toEqual({ t: "replay_done", offset: 128, cursor });
  });

  it("maps resync_required", () => {
    const earliest = { runId: "run-1", runOrdinal: 1, generation: 0, offset: 0 };
    expect(
      remoteEventToChannelMsg(
        wire("resync_required", {
          type: "resync_required",
          session_id: "s",
          earliest,
          reason: "log_rotated",
        }),
      ),
    ).toEqual({ t: "resync_required", earliest, reason: "log_rotated" });
  });

  it("remaps snake_case state payloads into a camelCase StatusEventView", () => {
    expect(
      remoteEventToChannelMsg(
        wire("state", {
          type: "state",
          session_id: "ses_1",
          run_id: "run-1",
          run_ordinal: 1,
          sequence: 9,
          state: "working",
          source: "pty",
          confidence: "medium",
          evidence: "pty:output",
          log_cursor: { runId: "run-1", runOrdinal: 1, generation: 0, offset: 10 },
          occurred_at: "2026-09-23T02:00:00Z",
        }),
      ),
    ).toEqual({
      t: "state",
      event: {
        sessionId: "ses_1",
        runId: "run-1",
        runOrdinal: 1,
        sequence: 9,
        state: "working",
        source: "pty",
        confidence: "medium",
        evidence: "pty:output",
        logCursor: { runId: "run-1", runOrdinal: 1, generation: 0, offset: 10 },
        occurredAt: "2026-09-23T02:00:00Z",
      },
    });
  });

  it("tolerates missing optional state fields", () => {
    const msg = remoteEventToChannelMsg(
      wire("state", {
        type: "state",
        run_id: "run-1",
        run_ordinal: 1,
        sequence: 1,
        state: "idle",
        source: "process",
        confidence: "low",
        occurred_at: "2026-09-23T02:00:00Z",
      }),
    );
    expect(msg).toMatchObject({
      t: "state",
      event: { sessionId: "", evidence: null, logCursor: null },
    });
  });

  it("maps agent_session and heartbeat", () => {
    expect(
      remoteEventToChannelMsg(
        wire("agent_session", {
          type: "agent_session",
          session_id: "s",
          agent_session_id: "agent-9",
        }),
      ),
    ).toEqual({ t: "agent_session", id: "agent-9" });
    const logCursor = { runId: "run-1", runOrdinal: 1, generation: 0, offset: 99 };
    expect(
      remoteEventToChannelMsg(
        wire("heartbeat", {
          type: "heartbeat",
          session_id: "s",
          at: "2026-09-23T02:00:00Z",
          log_bytes: 4096,
          log_cursor: logCursor,
        }),
      ),
    ).toEqual({ t: "heartbeat", logBytes: 4096, logCursor });
  });

  it("threads the subscriptionId through resize_ack and geometry events", () => {
    const geometry = {
      runId: "run-1",
      runOrdinal: 1,
      cols: 80,
      rows: 24,
      sourceKind: "desktop",
      revision: 3,
      updatedAt: "2026-09-23T02:00:00Z",
    };
    expect(
      remoteEventToChannelMsg(
        wire("resize_ack", {
          type: "resize_ack",
          session_id: "ses_1",
          accepted: false,
          geometry,
          reason: "stale_revision",
        }),
      ),
    ).toEqual({
      t: "resize_ack",
      payload: {
        sessionId: "ses_1",
        attachmentId: "att-1",
        accepted: false,
        geometry,
        reason: "stale_revision",
      },
    });
    expect(
      remoteEventToChannelMsg(
        wire("terminal_geometry_changed", {
          type: "terminal_geometry_changed",
          session_id: "ses_1",
          geometry,
        }),
      ),
    ).toEqual({
      t: "terminal_geometry_changed",
      payload: { sessionId: "ses_1", attachmentId: "att-1", geometry },
    });
  });

  it("maps exit and error payloads", () => {
    expect(
      remoteEventToChannelMsg(
        wire("exit", {
          type: "exit",
          session_id: "ses_1",
          run_id: "run-1",
          run_ordinal: 1,
          code: 0,
          signal: null,
          group_cleaned: true,
          reason: "natural",
        }),
      ),
    ).toEqual({
      t: "exit",
      code: 0,
      signal: null,
      groupCleaned: true,
      reason: "natural",
      runId: "run-1",
      runOrdinal: 1,
    });
    expect(
      remoteEventToChannelMsg(
        wire("error", {
          type: "error",
          session_id: "ses_1",
          message: "broken",
          code: "host_fault",
          params: { attempt: 2 },
          technical_detail: "stack",
        }),
      ),
    ).toEqual({
      t: "error",
      message: "broken",
      code: "host_fault",
      params: { attempt: 2 },
      technicalDetail: "stack",
    });
  });

  it("ignores pong, input_batch_ack, hello_ok and unknown event types", () => {
    for (const eventType of ["pong", "input_batch_ack", "hello_ok", "future_event"]) {
      expect(remoteEventToChannelMsg(wire(eventType, { type: eventType }))).toBeNull();
    }
  });

  it("returns null for missing or malformed payloads", () => {
    expect(remoteEventToChannelMsg(wire("output", null))).toBeNull();
    expect(remoteEventToChannelMsg(wire("output", "junk"))).toBeNull();
  });

  it("exposes the envelope consumed cursor for resume bookkeeping", () => {
    expect(remoteEventConsumedCursor(wire("heartbeat", {}))).toEqual(CURSOR);
  });
});
