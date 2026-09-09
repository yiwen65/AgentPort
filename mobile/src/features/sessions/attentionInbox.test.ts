import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionInbox, INBOX_PREFIX } from "./attentionInbox";
import type { AttentionPollEvent } from "./types";
const event = (sequence: number, sessionId = "s", runOrdinal = 1): AttentionPollEvent => ({
  sessionId, runId: `r${runOrdinal}`, kind: "turn_completed",
  cursor: { occurredAt: `2026-09-08T00:00:${String(sequence % 60).padStart(2, "0")}Z`, sessionId, runOrdinal, sequence },
});
const page = (...events: AttentionPollEvent[]) => ({ events, nextCursor: events.at(-1)?.cursor });
beforeEach(() => localStorage.clear());
describe("durable device-local attention inbox", () => {
  it("keeps metadata through restart independently of shared unread/current status", () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page(event(1)), new Map([["s", "Build"]]));
    expect(new AttentionInbox("h").entries).toEqual([expect.objectContaining({ sessionTitle: "Build", sequence: 1 })]);
    expect(inbox.pendingCount).toBe(0); // Silent initial history, not a flood of alerts.
    inbox.ingest(page(event(2)));
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.pendingCount).toBe(0);
  });
  it("dismisses locally, does not erase a newer turn and does not resurrect replay", () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page(event(1)));
    inbox.ingest(page(event(2)));
    inbox.acknowledge("s", { runOrdinal: 1, sequence: 1 });
    expect(inbox.entries[0].sequence).toBe(2);
    inbox.acknowledge("s", { runOrdinal: 1, sequence: 2 });
    inbox.ingest(page(event(2)));
    expect(inbox.entries).toHaveLength(0);
    inbox.ingest(page(event(1, "s", 2)));
    expect(inbox.entries[0].runOrdinal).toBe(2);
  });
  it("keeps only the latest notification for a Session across kinds and runs", () => {
    const inbox = new AttentionInbox("h");
    inbox.ingest(page(event(1), { ...event(2), kind: "approval_requested" }));
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0].kind).toBe("approval_requested");
    inbox.ingest(page(event(3), event(1)));
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({ sequence: 3, kind: "turn_completed" });
    inbox.ingest(page({ ...event(1, "s", 2), kind: "approval_requested" }));
    expect(new AttentionInbox("h").entries).toEqual([expect.objectContaining({ runOrdinal: 2, sequence: 1, kind: "approval_requested" })]);
  });
  it("clears a displayed batch in one write while preserving newer unseen messages", () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page());
    inbox.ingest(page(event(1, "a"), event(1, "b")));
    const displayed = inbox.entries;
    inbox.ingest(page(event(2, "a")));
    const writes = vi.spyOn(Storage.prototype, "setItem");
    try {
      inbox.acknowledgeMany(displayed);
      expect(writes).toHaveBeenCalledOnce();
      expect(inbox.entries).toEqual([expect.objectContaining({ sessionId: "a", sequence: 2 })]);
      expect(inbox.pendingCount).toBe(0);
      inbox.acknowledgeMany(inbox.entries);
      expect(inbox.entries).toHaveLength(0);
      expect(new AttentionInbox("h").entries).toHaveLength(0);
      inbox.ingest(page(event(2, "b")));
      expect(inbox.entries).toEqual([expect.objectContaining({ sessionId: "b", sequence: 2 })]);
    } finally { writes.mockRestore(); }
  });
  it("keeps the entire batch when clearing cannot be persisted", () => {
    const setItem = vi.fn(); const inbox = new AttentionInbox("h", { getItem: () => null, setItem });
    inbox.ingest(page(event(1, "a"), event(1, "b")));
    setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => inbox.acknowledgeMany(inbox.entries)).toThrow("quota");
    expect(inbox.entries).toHaveLength(2);
  });
  it("does not let one host acknowledgement affect another", () => {
    const a = new AttentionInbox("a"), b = new AttentionInbox("b");
    a.ingest(page(event(1))); b.ingest(page(event(1)));
    a.acknowledge("s", { runOrdinal: 1, sequence: 1 });
    expect(b.entries).toHaveLength(1);
  });
  it("never queues or delivers system notifications", async () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page()); inbox.ingest(page(event(1), event(2)));
    expect(inbox.pendingCount).toBe(0);
    const notify = vi.fn(); await inbox.deliver({ notify });
    expect(notify).not.toHaveBeenCalled();
    const restored = new AttentionInbox("h");
    expect(restored.cursor?.sequence).toBe(2); expect(restored.pendingCount).toBe(0);
  });
  it("storage failure does not acknowledge or advance in-memory state", () => {
    const setItem = vi.fn(); const inbox = new AttentionInbox("h", { getItem: () => null, setItem });
    inbox.ingest(page(event(1))); setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => inbox.acknowledge("s", { runOrdinal: 1, sequence: 1 })).toThrow("quota");
    expect(() => inbox.ingest(page(event(2)))).toThrow("quota");
    expect(inbox.entries[0].sequence).toBe(1); expect(inbox.cursor?.sequence).toBe(1);
  });
  it("keeps viewed completions out of Recent without system delivery", async () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page());
    inbox.acknowledge("s", { runOrdinal: 1, sequence: 1 });
    inbox.ingest(page(event(1)));
    expect(inbox.entries).toHaveLength(0);
    const notify = vi.fn(); await inbox.deliver({ notify });
    expect(notify).not.toHaveBeenCalled();
  });
  it("preserves phone-local legacy receipts without inheriting desktop seen state", () => {
    localStorage.setItem("agentport-mobile-v2:attention-receipts", JSON.stringify({ "h:s": { runOrdinal: 1, sequence: 2 } }));
    const inbox = new AttentionInbox("h"); inbox.ingest(page(event(1), event(2)));
    expect(inbox.entries).toHaveLength(0);
    inbox.ingest(page(event(3))); expect(inbox.entries[0].sequence).toBe(3);
  });
  it("does not rewrite storage on idle polls", () => {
    const setItem = vi.fn(); const inbox = new AttentionInbox("h", { getItem: () => null, setItem });
    inbox.ingest(page()); setItem.mockClear();
    for (let i = 0; i < 100; i++) inbox.ingest(page());
    expect(setItem).not.toHaveBeenCalled();
  });
  it("fails visibly rather than silently resetting a corrupt inbox", () => {
    localStorage.setItem(INBOX_PREFIX + "h", "{broken");
    expect(() => new AttentionInbox("h")).toThrow();
  });
});
