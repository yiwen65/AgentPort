import { invoke, isTauri } from "@tauri-apps/api/core";

let traceQueue: string[] = [];
let traceTimer: number | undefined;

function flushTraceQueue(): void {
  traceTimer = undefined;
  const lines = traceQueue;
  traceQueue = [];
  if (lines.length) void invoke("mobile_diag_log_batch", { lines }).catch(() => undefined);
}

/** High-volume offset traces must be batched; one synchronous native file open
 * per PTY chunk can make the mobile event reader fall behind the Host. */
export function diagTrace(event: string, detail?: Record<string, unknown>): void {
  if (!isTauri()) return;
  let line = event;
  try { line = detail ? `${event} ${JSON.stringify(detail)}` : event; }
  catch { line = `${event} <unserializable>`; }
  traceQueue.push(line);
  if (traceQueue.length >= 32) flushTraceQueue();
  else if (traceTimer === undefined) traceTimer = window.setTimeout(flushTraceQueue, 100);
}

/**
 * Lifecycle diagnostics for the terminal stream: attach/detach, transport
 * transitions and effect re-runs. Diagnostics must never affect the stream, so
 * every write is fire-and-forget and silently ignored outside Tauri (tests,
 * web preview). The native side caps and rotates the file.
 */
export function diag(event: string, detail?: Record<string, unknown>): void {
  if (!isTauri()) return;
  let line = event;
  if (detail) {
    try {
      line = `${event} ${JSON.stringify(detail)}`;
    } catch {
      line = `${event} <unserializable>`;
    }
  }
  void invoke("mobile_diag_log", { line }).catch(() => undefined);
}
