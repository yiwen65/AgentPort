import type { TaskListResponse, TaskReadParams } from "./taskApi";

const CACHE_PREFIX = "agentport-mobile-v2:tasks:";
const CACHE_VERSION = 1;
const MAX_ENTRIES = 24;

export interface CachedTaskList {
  savedAt: number;
  response: TaskListResponse;
}

export function taskCacheKey(profileId: string, params: TaskReadParams): string {
  return `${CACHE_PREFIX}${JSON.stringify([profileId, params.provider, params.projectId, params.scope])}`;
}

function isCachedTaskList(value: unknown): value is CachedTaskList {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === CACHE_VERSION
    && typeof item.savedAt === "number"
    && Boolean(item.response && typeof item.response === "object");
}

export function readTaskCache(profileId: string, params: TaskReadParams): CachedTaskList | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(taskCacheKey(profileId, params)) ?? "null") as unknown;
    return isCachedTaskList(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeTaskCache(profileId: string, params: TaskReadParams, response: TaskListResponse, savedAt = Date.now()): void {
  try {
    localStorage.setItem(taskCacheKey(profileId, params), JSON.stringify({ version: CACHE_VERSION, savedAt, response }));
    const keys = Object.keys(localStorage).filter(key => key.startsWith(CACHE_PREFIX));
    if (keys.length <= MAX_ENTRIES) return;
    const entries = keys.map(key => {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null") as CachedTaskList;
        return { key, savedAt: typeof value.savedAt === "number" ? value.savedAt : 0 };
      } catch {
        return { key, savedAt: 0 };
      }
    }).sort((left, right) => left.savedAt - right.savedAt);
    entries.slice(0, entries.length - MAX_ENTRIES).forEach(entry => localStorage.removeItem(entry.key));
  } catch {
    // A full/private storage area must not make remote reads fail.
  }
}

export function clearTaskCache(): void {
  try {
    Object.keys(localStorage).filter(key => key.startsWith(CACHE_PREFIX)).forEach(key => localStorage.removeItem(key));
  } catch {
    // Best effort only; the next read will still be authoritative.
  }
}
