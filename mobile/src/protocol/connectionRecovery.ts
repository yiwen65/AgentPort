import { diag } from "../platform/diag";
import type { RemoteClient } from "./remoteClient";

const recoveries = new WeakMap<RemoteClient, Map<string, Promise<void>>>();
const probes = new WeakMap<RemoteClient, Map<string, Promise<boolean>>>();
/** A busy Bridge handles attach/git/output sequentially, so a foreground probe
 * queued behind that work is not evidence of a dead iOS transport. */
export const FOREGROUND_PROBE_TIMEOUT_MS = 8000;

/** A cheap, read-only Bridge round trip, not a cached native connection flag.
 * A reply proves the existing reader/writer is usable after iOS suspension. */
export function checkConnection(client: RemoteClient, profileId: string): Promise<boolean> {
  let pending = probes.get(client);
  if (!pending) { pending = new Map(); probes.set(client, pending); }
  const existing = pending.get(profileId);
  if (existing) return existing;
  const controller = new AbortController();
  const started = performance.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const probe = Promise.race([
    Promise.resolve().then(() => client.request(profileId, "agent.preferences", {}, { signal: controller.signal })).then(() => true, () => false),
    new Promise<false>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, FOREGROUND_PROBE_TIMEOUT_MS); }),
  ]).then(healthy => {
    diag("foreground-probe", {
      profileId,
      healthy,
      timedOut,
      ms: Math.round(performance.now() - started),
    });
    return healthy;
  }).finally(() => {
    clearTimeout(timer);
    controller.abort();
    if (pending.get(profileId) === probe) pending.delete(profileId);
  });
  pending.set(profileId, probe);
  return probe;
}

/** Replace only the phone's transport. Never restart a Host or replay a mutation. */
export function recoverConnection(client: RemoteClient, profileId: string): Promise<void> {
  let pending = recoveries.get(client);
  if (!pending) { pending = new Map(); recoveries.set(client, pending); }
  const existing = pending.get(profileId);
  if (existing) return existing;
  const recovery = (async () => {
    await client.disconnect(profileId);
    await client.connect(profileId);
  })().finally(() => { if (pending.get(profileId) === recovery) pending.delete(profileId); });
  pending.set(profileId, recovery);
  return recovery;
}
