import type { ProjectSummary } from "../sessions/types";

export interface AddedProjectResult {
  project: ProjectSummary;
  focusedExisting: boolean;
}

export interface PendingProjectAdd {
  id: string;
  path: string;
  canonicalPath?: string;
  name: string | null;
  state: "pending" | "confirmed";
  result?: AddedProjectResult;
}

const PREFIX = "agentport-mobile-v2:pending-project-add:";
const listeners = new Map<string, Set<() => void>>();
const key = (hostId: string) => PREFIX + hostId;
const emit = (hostId: string) => listeners.get(hostId)?.forEach(listener => listener());

/** Unlike cosmetic UI preferences, failure to read/save this journal blocks writes. */
export function readPendingProjectAdd(hostId: string): PendingProjectAdd | null {
  const raw = localStorage.getItem(key(hostId));
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingProjectAdd;
  if (!value || typeof value.id !== "string" || typeof value.path !== "string"
    || (value.name !== null && typeof value.name !== "string")
    || (value.canonicalPath !== undefined && typeof value.canonicalPath !== "string")
    || (value.state !== "pending" && value.state !== "confirmed")
    || (value.state === "confirmed" && (!value.result?.project || typeof value.result.project.rootPath !== "string"))) {
    throw new Error("Invalid pending project record");
  }
  return value;
}

/** Synchronous check + durable save, before invoking the non-retryable write. */
export function beginPendingProjectAdd(hostId: string, value: PendingProjectAdd): boolean {
  if (readPendingProjectAdd(hostId)) return false;
  localStorage.setItem(key(hostId), JSON.stringify(value));
  emit(hostId);
  return true;
}

export function updatePendingProjectAdd(hostId: string, value: PendingProjectAdd): void {
  if (readPendingProjectAdd(hostId)?.id !== value.id) return;
  localStorage.setItem(key(hostId), JSON.stringify(value));
  emit(hostId);
}

export function clearPendingProjectAdd(hostId: string, id: string): void {
  if (readPendingProjectAdd(hostId)?.id !== id) return;
  localStorage.removeItem(key(hostId));
  emit(hostId);
}

/** Also observes late responses from a dialog that has already been closed. */
export function observePendingProjectAdd(hostId: string, listener: () => void): () => void {
  const hostListeners = listeners.get(hostId) ?? new Set();
  listeners.set(hostId, hostListeners);
  hostListeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === key(hostId) || event.key === null) listener(); };
  window.addEventListener("storage", storage);
  return () => {
    hostListeners.delete(listener);
    if (!hostListeners.size) listeners.delete(hostId);
    window.removeEventListener("storage", storage);
  };
}
