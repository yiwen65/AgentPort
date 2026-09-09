import type { AgentPreferences, SessionSummary, SupportedAgent } from "./types";

export type SessionLayout = "projects" | "active";

function time(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function activeSessionPriority(session: SessionSummary): number {
  if (session.unreadAttention || session.latestStatus?.state === "needs_input") return 0;
  if (session.lifecycle === "creating" || session.latestStatus?.state === "working") return 1;
  if (session.latestStatus?.state === "idle") return 2;
  return 3;
}

/** Mirrors the desktop Active Agent filter and ordering. */
export function activeAgentSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => session.hostAlive === true && session.adapterType !== "shell" && !session.archivedAt)
    .sort((a, b) => {
      const priority = activeSessionPriority(a) - activeSessionPriority(b);
      if (priority !== 0) return priority;
      const pinned = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
      if (pinned !== 0) return pinned;
      const recent = time(b.latestStatus?.occurredAt ?? b.createdAt) - time(a.latestStatus?.occurredAt ?? a.createdAt);
      return recent || a.id.localeCompare(b.id);
    });
}

export function orderedVisibleAgents(
  supported: readonly SupportedAgent[],
  preferences: AgentPreferences | undefined,
): SupportedAgent[] {
  const hidden = new Set(preferences?.agentHidden ?? []);
  const order = new Map((preferences?.agentOrder ?? []).map((agent, index) => [agent, index]));
  return supported
    .filter((agent) => (agent.install !== null || agent.agent === "shell") && !hidden.has(agent.agent))
    .sort((a, b) => (order.get(a.agent) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.agent) ?? Number.MAX_SAFE_INTEGER)
      || a.displayName.localeCompare(b.displayName));
}

export interface QuickStartParams {
  projectId: string;
  agent: string;
  title: null;
  presetId: null;
  worktreeId: null;
  permission: "native" | "bypass";
  transport: "pty";
  riskAck: true;
  cols: null;
  rows: null;
  extraArgs: null;
}

/** Exact mobile projection of desktop quickStartSession. */
export function quickStartParams(projectId: string, agent: string): QuickStartParams {
  return {
    projectId,
    agent,
    title: null,
    presetId: null,
    worktreeId: null,
    permission: agent === "shell" || agent === "pi" ? "native" : "bypass",
    transport: "pty",
    riskAck: true,
    cols: null,
    rows: null,
    extraArgs: null,
  };
}

export function statusClass(session: SessionSummary): string {
  if (session.lifecycle !== "running") return session.lifecycle;
  return session.latestStatus?.state ?? "unknown";
}
