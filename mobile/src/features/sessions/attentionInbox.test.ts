import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionInbox, DELIVERY_LIMIT, INBOX_PREFIX } from "./attentionInbox";
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
    expect(inbox.pendingCount).toBe(1);
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
      expect(inbox.pendingCount).toBe(1);
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
  it("keeps failed delivery pending even though the download cursor advanced", async () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page()); inbox.ingest(page(event(1), event(2)));
    const notify = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("transport"));
    await expect(inbox.deliver({ notify })).rejects.toThrow("transport");
    const restored = new AttentionInbox("h");
    expect(restored.cursor?.sequence).toBe(2); expect(restored.pendingCount).toBe(1);
    const retry = vi.fn(); await restored.deliver({ notify: retry });
    expect(retry).toHaveBeenCalledOnce(); expect(restored.pendingCount).toBe(0);
  });
  it("bounds delivery work and concurrent flushes", async () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page());
    inbox.ingest(page(...Array.from({ length: 12 }, (_, i) => event(i + 1))));
    let finish!: () => void;
    const notify = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = inbox.deliver({ notify }); await inbox.deliver({ notify });
    expect(notify).toHaveBeenCalledOnce(); finish(); await first;
    expect(notify).toHaveBeenCalledTimes(8); expect(inbox.pendingCount).toBe(4);
  });
  it("applies queue backpressure without advancing cursor or losing mail", () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page());
    inbox.ingest(page(...Array.from({ length: DELIVERY_LIMIT }, (_, i) => event(i + 1))));
    expect(() => inbox.ingest(page(event(DELIVERY_LIMIT + 1)))).toThrow("full");
    expect(inbox.cursor?.sequence).toBe(DELIVERY_LIMIT); expect(inbox.entries[0].sequence).toBe(DELIVERY_LIMIT);
  });
  it("storage failure does not acknowledge or advance in-memory state", () => {
    const setItem = vi.fn(); const inbox = new AttentionInbox("h", { getItem: () => null, setItem });
    inbox.ingest(page(event(1))); setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => inbox.acknowledge("s", { runOrdinal: 1, sequence: 1 })).toThrow("quota");
    expect(() => inbox.ingest(page(event(2)))).toThrow("quota");
    expect(inbox.entries[0].sequence).toBe(1); expect(inbox.cursor?.sequence).toBe(1);
  });
  it("still notifies a viewed completion without resurrecting it in Recent", async () => {
    const inbox = new AttentionInbox("h"); inbox.ingest(page());
    inbox.acknowledge("s", { runOrdinal: 1, sequence: 1 });
    inbox.ingest(page(event(1)));
    expect(inbox.entries).toHaveLength(0);
    const notify = vi.fn(); await inbox.deliver({ notify });
    expect(notify).toHaveBeenCalledOnce();
    inbox.ingest(page(event(1))); await inbox.deliver({ notify });
    expect(notify).toHaveBeenCalledOnce();
  });
  it("preserves phone-local legacy receipts without inheriting desktop seen state", () => {
    localStorage.setItem("agentport-mobile-v2:attention-receipts", JSON.stringify({ "h:s": { runOrdinal: 1, sequence: 2 } }));
    const inbox = new AttentionInbox("h"); inbox.ingest(page(event(1), event(2)));
    expect(inbox.entries).toHaveLength(0);
    inbox.ingest(page(event(3))); expect(inbox.entries[0].sequence).toBe(3);
  });
  it("persists globally distinct native identifiers and reuses them on retry", async () => {
    const a = new AttentionInbox("a"), b = new AttentionInbox("b");
    a.ingest(page()); b.ingest(page()); a.ingest(page(event(1))); b.ingest(page(event(1)));
    const notify = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(a.deliver({ notify })).rejects.toThrow();
    const id = notify.mock.calls[0][3];
    await expect(new AttentionInbox("a").deliver({ notify })).rejects.toThrow();
    expect(notify.mock.calls[1][3]).toBe(id);
    await expect(b.deliver({ notify })).rejects.toThrow();
    expect(notify.mock.calls[2][3]).not.toBe(id);
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
