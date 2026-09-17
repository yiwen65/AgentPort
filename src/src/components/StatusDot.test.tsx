import { beforeEach, describe, expect, it } from "vitest";
import { dotTipFor } from "./StatusDot";
import { setState } from "../store";
import type { SessionView } from "../types";

const session = (state: SessionView["status"]): SessionView => ({
  id: "ses_status_dot",
  projectId: "prj_status_dot",
  worktreeId: null,
  title: "Claude approval",
  adapter: "claude",
  cwd: "/tmp/status-dot",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: state,
  pinnedAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
});

describe("StatusDot tooltip", () => {
  beforeEach(() => {
    setState({ runtime: {} });
  });

  it("shows waiting for approval without technical source details", () => {
    const tip = dotTipFor(session({
      sessionId: "ses_status_dot",
      runId: "run_status_dot",
      runOrdinal: 1,
      sequence: 7,
      state: "needs_input",
      source: "hook",
      confidence: "high",
      evidence: "hook:PermissionRequest",
      logCursor: null,
      occurredAt: "2026-07-24T00:13:09.000Z",
    }));

    const lines = tip.split("\n");
    expect(lines[0]).toBe("等待批准");
    expect(lines).toHaveLength(2);
    expect(tip).not.toContain("来源");
    expect(tip).not.toContain("Hook");
    expect(tip).not.toContain("高置信度");
  });
});
