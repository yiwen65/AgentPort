/** Session IDs survive restart; status, exit, geometry and PTY cursors do not. */
export interface SessionRun {
  runId: string;
  runOrdinal: number;
}

export function staleSessionRun(incoming: Partial<SessionRun> | null | undefined, current: Partial<SessionRun> | null | undefined): boolean {
  if (!incoming?.runId || incoming.runOrdinal === undefined || !current?.runId || current.runOrdinal === undefined) return false;
  return incoming.runOrdinal < current.runOrdinal
    || (incoming.runOrdinal === current.runOrdinal && incoming.runId !== current.runId);
}

export function newerSessionRun(incoming: SessionRun | null | undefined, current: SessionRun | null | undefined): boolean {
  return !!incoming && !!current && incoming.runOrdinal > current.runOrdinal;
}
