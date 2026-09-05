import type { SessionSummary } from "./types";

export type AttentionReceipt = { runOrdinal: number; sequence: number };
export type AttentionReceipts = Record<string, AttentionReceipt>;
export const RECEIPTS_KEY = "agentport-mobile-v2:attention-receipts";
export const receiptKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;
export function readReceipts(): AttentionReceipts {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECEIPTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, cursor]) => cursor && Number.isInteger(cursor.runOrdinal) && Number.isInteger(cursor.sequence)));
  } catch { return {}; }
}
export function pendingAttention(session: SessionSummary, receipt?: AttentionReceipt) {
  if (!session.unreadAttention || session.archivedAt || !["turn_completed", "approval_requested"].includes(session.latestAttentionKind ?? "")) return false;
  const status = session.latestStatus;
  return !receipt || !status || status.runOrdinal > receipt.runOrdinal
    || (status.runOrdinal === receipt.runOrdinal && status.sequence > receipt.sequence);
}
