/** Existing quick-launch order, chosen to preserve the four-icon layout. */
export const DEFAULT_AGENT_ORDER = ["shell", "codex", "claude", "kimi", "qoder", "pi"];

/**
 * Keep a user's saved ordering, discard stale duplicates, and append any
 * newly discovered adapter without imposing a display-count limit.
 */
export function orderAgentIds(savedOrder: readonly string[] | undefined, available: readonly string[]) {
  const availableSet = new Set(available);
  const result: string[] = [];
  const add = (agent: string) => {
    if (availableSet.has(agent) && !result.includes(agent)) result.push(agent);
  };

  for (const agent of savedOrder ?? DEFAULT_AGENT_ORDER) add(agent);
  for (const agent of available) add(agent);
  return result;
}

/** Drop agents the user removed from pickers, preserving the given order. */
export function visibleAgentIds(ids: readonly string[], hidden: readonly string[] | undefined) {
  if (!hidden || hidden.length === 0) return [...ids];
  const hiddenSet = new Set(hidden);
  return ids.filter((id) => !hiddenSet.has(id));
}
