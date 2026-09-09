import type { RemoteClient } from "./remoteClient";

const recoveries = new WeakMap<RemoteClient, Map<string, Promise<void>>>();

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
