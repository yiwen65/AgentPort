import { describe, expect, it, vi } from "vitest";
import { attentionEventKey, deliverAttentionNotifications } from "./attentionNotifications";
import type { AttentionEvent } from "./types";

const event = (kind: AttentionEvent["kind"], sequence: number): AttentionEvent => ({
  sessionId: "s", runId: "r", runOrdinal: 2, sequence,
  occurredAt: "2026-09-08T00:00:00Z", kind, sessionTitle: "Fix release",
});

describe("in-app-only attention delivery", () => {
  it("keeps stable event keys for inbox identity", () => {
    expect(attentionEventKey(event("approval_requested", 4))).toBe("s:r:2:4:approval_requested");
  });

  it("does not send system notifications", async () => {
    const notify = vi.fn();
    await expect(deliverAttentionNotifications([event("approval_requested", 1)], new Set(), { notify })).resolves.toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
