import { describe, expect, it } from "vitest";
import { activeAgentSessions, isSystemNotificationKind, orderedVisibleAgents, quickStartParams, statusClass } from "./sessionModel";
import type { SessionSummary } from "./types";

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectId: "project",
    presetId: "preset",
    title: id,
    cwd: "/repo",
    lifecycle: "running",
    resumePrecision: "exact",
    adapterType: "claude",
    transport: "pty",
    permissionMode: "bypass",
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    hostAlive: true,
    ...overrides,
  };
}

describe("V2 session model", () => {
  it("uses desktop Active Agent filtering and priority order", () => {
    const result = activeAgentSessions([
      session("idle", { latestStatus: { runId: "r", runOrdinal: 1, sequence: 1, state: "idle", source: "hook", confidence: "high", occurredAt: "2026-09-02T00:02:00Z" } }),
      session("attention", { unreadAttention: true }),
      session("working", { latestStatus: { runId: "r", runOrdinal: 1, sequence: 1, state: "working", source: "hook", confidence: "high", occurredAt: "2026-09-02T00:01:00Z" } }),
      session("shell", { adapterType: "shell" }),
      session("dead", { hostAlive: false }),
      session("archived", { archivedAt: "2026-09-02T00:03:00Z" }),
    ]);
    expect(result.map((item) => item.id)).toEqual(["attention", "working", "idle"]);
  });

  it("orders and hides installed quick-launch agents using desktop preferences", () => {
    expect(orderedVisibleAgents([
      { agent: "claude", displayName: "Claude", install: {} },
      { agent: "pi", displayName: "Pi", install: {} },
      { agent: "codex", displayName: "Codex", install: null },
    ], { revision: 3, agentOrder: ["pi", "claude"], agentHidden: ["claude"] }).map((item) => item.agent)).toEqual(["pi"]);
  });

  it("matches desktop quick-start permission semantics", () => {
    expect(quickStartParams("p", "claude")).toMatchObject({ permission: "bypass", riskAck: true, transport: "pty" });
    expect(quickStartParams("p", "pi")).toMatchObject({ permission: "native", riskAck: true });
    expect(quickStartParams("p", "shell")).toMatchObject({ permission: "native", riskAck: true });
  });

  it("allows system notifications only for desktop AttentionKind values", () => {
    expect(isSystemNotificationKind("approval_requested")).toBe(true);
    expect(isSystemNotificationKind("turn_completed")).toBe(true);
    expect(isSystemNotificationKind("working")).toBe(false);
    expect(isSystemNotificationKind("failed")).toBe(false);
  });

  it("uses lifecycle first and desktop status state while running", () => {
    expect(statusClass(session("stopped", { lifecycle: "stopped" }))).toBe("stopped");
    expect(statusClass(session("needs", { latestStatus: { runId: "r", runOrdinal: 1, sequence: 1, state: "needs_input", source: "hook", confidence: "high", occurredAt: "2026-09-02T00:00:00Z" } }))).toBe("needs_input");
  });
});
