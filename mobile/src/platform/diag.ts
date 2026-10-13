import { invoke, isTauri } from "@tauri-apps/api/core";

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
