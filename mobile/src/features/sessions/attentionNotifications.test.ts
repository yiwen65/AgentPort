import { describe, expect, it, vi } from "vitest";
import { attentionEventKey, deliverAttentionNotifications, SystemNotificationSink } from "./attentionNotifications";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: vi.fn() }));
import type { AttentionEvent } from "./types";

function event(kind: string, sequence: number): AttentionEvent {
  return {
    sessionId: "s",
    sessionTitle: "Fix release",
    kind: kind as AttentionEvent["kind"],
    runId: "r",
    runOrdinal: 2,
    sequence,
    occurredAt: "2026-09-02T00:00:00Z",
  };
}

describe("attention notification delivery", () => {
  it("awaits native rejection rather than treating a void JS call as delivery", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("native refused"));
    await expect(new SystemNotificationSink().notify("Title", "Body", "event-key")).rejects.toThrow("native refused");
    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", { options: { title: "Title", body: "Body", extra: { eventKey: "event-key" } } });
  });
  it("uses a run and sequence stable dedup key", () => {
    expect(attentionEventKey(event("approval_requested", 4))).toBe("s:r:2:4:approval_requested");
  });

  it("delivers only approval and completion once", async () => {
    const notify = vi.fn();
    const delivered = new Set<string>();
    const events = [event("approval_requested", 1), event("turn_completed", 2), event("working", 3)];
    await expect(deliverAttentionNotifications(events, delivered, { notify })).resolves.toBe(2);
    await expect(deliverAttentionNotifications(events, delivered, { notify })).resolves.toBe(0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, "Fix release", "请求批准", expect.any(String));
    expect(notify).toHaveBeenNthCalledWith(2, "Fix release", "任务已完成", expect.any(String));
  });

  it("does not mark a failed notification as delivered", async () => {
    const delivered = new Set<string>();
    const item = event("approval_requested", 1);
    await expect(deliverAttentionNotifications([item], delivered, { notify: () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    expect(delivered.has(attentionEventKey(item))).toBe(false);
  });
});
