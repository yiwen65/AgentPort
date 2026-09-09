import type { AttentionEvent } from "./types";

export interface AttentionNotificationSink {
  notify(title: string, body: string, tag: string, id?: number): Promise<void> | void;
}

export function attentionEventKey(event: AttentionEvent): string {
  return `${event.sessionId}:${event.runId}:${event.runOrdinal}:${event.sequence}:${event.kind}`;
}

/** Mobile keeps attention as an in-app inbox only; system delivery is disabled. */
export async function deliverAttentionNotifications(
  _events: readonly AttentionEvent[] = [],
  _delivered: ReadonlySet<string> = new Set(),
  _sink?: AttentionNotificationSink,
): Promise<number> {
  return 0;
}
