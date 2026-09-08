import type { AttentionCursor, AttentionEvent, AttentionPollResult } from "./types";
import { attentionEventKey, type AttentionNotificationSink } from "./attentionNotifications";
import { RECEIPTS_KEY } from "./sessionRecent";

export const INBOX_PREFIX = "agentport-mobile:inbox:v1:";
export const INBOX_LIMIT = 2048;
export const DELIVERY_LIMIT = 256;
export interface InboxEntry extends AttentionEvent { hostId: string; notificationId?: number }
const NEXT_NOTIFICATION_ID = "agentport-mobile:next-notification-id";
interface Receipt { runOrdinal: number; sequence: number }
interface InboxState {
  version: 1;
  cursor?: AttentionCursor;
  seeded: boolean;
  entries: Record<string, InboxEntry>;
  receipts: Record<string, Receipt>;
  received: Record<string, Receipt>;
  pending: InboxEntry[];
}
const newer = (a: Receipt, b: Receipt) => a.runOrdinal > b.runOrdinal || (a.runOrdinal === b.runOrdinal && a.sequence > b.sequence);
const empty = (): InboxState => ({ version: 1, seeded: false, entries: {}, receipts: {}, received: {}, pending: [] });

/** One durable transaction commits both the page and its cursor. Capacity or
 * storage failure applies backpressure; it never silently evicts unread mail.
 * Only semantic metadata is stored, not terminal output or notification body. */
export class AttentionInbox {
  private state: InboxState;
  private delivering = false;
  constructor(readonly hostId: string, private storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    const raw = storage.getItem(INBOX_PREFIX + hostId);
    this.state = raw ? JSON.parse(raw) : empty();
    this.state.received ??= {};
    if (!raw) {
      // Preserve this phone's old acknowledgements, never the shared desktop
      // unread bit or old download cursor (which did not persist an inbox).
      const saved = storage.getItem(RECEIPTS_KEY);
      if (saved) {
        const receipts = JSON.parse(saved) as Record<string, Receipt>;
        for (const [key, receipt] of Object.entries(receipts)) {
          if (key.startsWith(`${hostId}:`) && receipt && Number.isSafeInteger(receipt.runOrdinal) && Number.isSafeInteger(receipt.sequence)) {
            this.state.receipts[key.slice(hostId.length + 1)] = receipt;
          }
        }
      }
    }
    if (this.state.version !== 1 || !this.state.entries || !this.state.receipts || !Array.isArray(this.state.pending)) {
      throw new Error("Cannot read saved notification inbox");
    }
  }
  get cursor() { return this.state.cursor; }
  get entries() { return Object.values(this.state.entries); }
  get pendingCount() { return this.state.pending.length; }
  private commit(next: InboxState) {
    this.storage.setItem(INBOX_PREFIX + this.hostId, JSON.stringify(next));
    this.state = next;
  }
  ingest(page: AttentionPollResult, titles: ReadonlyMap<string, string> = new Map(), pageSize = 256): boolean {
    if (!page.events.length && this.state.seeded && !page.nextCursor) return false;
    const entries = { ...this.state.entries };
    const received = { ...this.state.received };
    const pending = [...this.state.pending];
    const queued = new Set(pending.map(attentionEventKey));
    let changed = false;
    const allocated = Number(this.storage.getItem(NEXT_NOTIFICATION_ID) ?? "0");
    let nextId = allocated;
    for (const item of page.events) {
      if (!["approval_requested", "turn_completed"].includes(item.kind)) continue;
      const event: InboxEntry = { hostId: this.hostId, sessionId: item.sessionId, runId: item.runId,
        runOrdinal: item.cursor.runOrdinal, sequence: item.cursor.sequence, occurredAt: item.cursor.occurredAt,
        kind: item.kind, sessionTitle: titles.get(item.sessionId) ?? entries[item.sessionId]?.sessionTitle };
      const previous = received[event.sessionId];
      if (previous && !newer(event, previous)) continue;
      received[event.sessionId] = { runOrdinal: event.runOrdinal, sequence: event.sequence };
      const receipt = this.state.receipts[event.sessionId];
      if (!receipt || newer(event, receipt)) {
        entries[event.sessionId] = event;
        changed = true;
      }
      if (this.state.seeded && !queued.has(attentionEventKey(event))) {
        if (!Number.isSafeInteger(nextId) || nextId < 0 || nextId >= 2_147_483_647) throw new Error("Notification identifier capacity reached");
        event.notificationId = ++nextId;
        pending.push(event); queued.add(attentionEventKey(event));
      }
    }
    if (Object.keys(entries).length > INBOX_LIMIT || pending.length > DELIVERY_LIMIT) {
      throw new Error("Notification inbox is full; open or dismiss messages to resume syncing");
    }
    // Reserve IDs before the page commit. A crash can skip IDs but never reuse
    // another Host's notification ID. Retries retain the persisted same ID.
    if (nextId !== allocated) this.storage.setItem(NEXT_NOTIFICATION_ID, String(nextId));
    this.commit({ ...this.state, cursor: page.nextCursor ?? this.state.cursor,
      seeded: this.state.seeded || page.events.length < pageSize, entries, received, pending });
    return changed;
  }
  acknowledge(sessionId: string, cursor: Receipt): boolean {
    const previous = this.state.receipts[sessionId];
    if (previous && !newer(cursor, previous)) return false;
    return this.acknowledgeMany([{ sessionId, runOrdinal: cursor.runOrdinal, sequence: cursor.sequence }]);
  }
  acknowledgeMany(displayed: readonly (Receipt & { sessionId: string })[]): boolean {
    if (!displayed.length) return false;
    const entries = { ...this.state.entries };
    const receipts = { ...this.state.receipts };
    const confirmed = new Set<string>();
    for (const cursor of displayed) {
      const previous = receipts[cursor.sessionId];
      if (previous && !newer(cursor, previous)) continue;
      receipts[cursor.sessionId] = { runOrdinal: cursor.runOrdinal, sequence: cursor.sequence };
      if (entries[cursor.sessionId] && !newer(entries[cursor.sessionId], cursor)) delete entries[cursor.sessionId];
      confirmed.add(cursor.sessionId);
    }
    if (!confirmed.size) return false;
    // One local transaction per Host, not a write per row. Confirm only the
    // displayed cursors; a newer arrival must survive Clear all.
    this.commit({ ...this.state, entries, receipts,
      pending: this.state.pending.filter(event => !confirmed.has(event.sessionId) || newer(event, receipts[event.sessionId])) });
    return true;
  }
  async deliver(sink: AttentionNotificationSink): Promise<void> {
    if (this.delivering || !this.state.pending.length) return;
    this.delivering = true;
    const completed = new Set<string>();
    try {
      // Bound each flush; don't monopolize the event loop after reconnecting.
      for (const event of this.state.pending.slice(0, 8)) {
        if (!this.state.pending.some(current => attentionEventKey(current) === attentionEventKey(event))) continue;
        await sink.notify(event.sessionTitle ?? "AgentPort", event.kind === "approval_requested" ? "请求批准" : "任务已完成",
          `${this.hostId}:${attentionEventKey(event)}`, event.notificationId);
        completed.add(attentionEventKey(event));
      }
    } finally {
      try {
        if (completed.size) this.commit({ ...this.state,
          pending: this.state.pending.filter(event => !completed.has(attentionEventKey(event))) });
      } finally { this.delivering = false; }
    }
  }
}
