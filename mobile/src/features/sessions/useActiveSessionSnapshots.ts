import { useCallback, useEffect, useRef, useState } from "react";
import type { HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import type { SessionSummary } from "./types";

export interface ActiveSessionSnapshot {
  sessions: SessionSummary[];
  loading: boolean;
  error?: string;
}

interface Completion {
  promise: Promise<void>;
  resolve: () => void;
}

interface PendingRead extends Completion {
  controller: AbortController;
  trailing?: Completion;
}

interface HostReads {
  pending?: PendingRead;
}

function completion(): Completion {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

function invalidate(host: HostReads) {
  const pending = host.pending;
  host.pending = undefined;
  pending?.controller.abort();
  pending?.resolve();
  pending?.trailing?.resolve();
}

/** Read-only, per-connected-host polling. Selection and profile labels do not
 * restart requests; each connection lifecycle owns its replies and pending lock. */
export function useActiveSessionSnapshots(client: RemoteClient, hosts: readonly HostProfileSummary[], active: boolean): {
  snapshots: ReadonlyMap<string, ActiveSessionSnapshot>;
  refreshing: boolean;
  refresh: (hostId?: string, afterPending?: boolean) => Promise<void>;
} {
  const store = useRef({
    client,
    active: false,
    mounted: false,
    hosts: new Map<string, HostReads>(),
    snapshots: new Map<string, ActiveSessionSnapshot>(),
  });
  const [view, setView] = useState<{ snapshots: ReadonlyMap<string, ActiveSessionSnapshot>; refreshing: boolean }>({
    snapshots: new Map(), refreshing: false,
  });
  const publish = useCallback(() => {
    const state = store.current;
    if (state.mounted) setView({
      snapshots: new Map(state.snapshots),
      refreshing: [...state.hosts.values()].some(host => !!host.pending),
    });
  }, []);

  const read = useCallback(function readHost(id: string, host: HostReads): Promise<void> {
    const state = store.current;
    if (!state.mounted || !state.active || state.hosts.get(id) !== host) return Promise.resolve();
    const pending: PendingRead = { ...completion(), controller: new AbortController() };
    host.pending = pending;
    state.snapshots.set(id, { sessions: [], ...state.snapshots.get(id), loading: true });
    publish();
    const current = () => state.mounted && state.active && state.hosts.get(id) === host && host.pending === pending;
    void (async () => {
      try {
        const sessions = await state.client.request<SessionSummary[]>(id, "session.list", { includeArchived: false },
          { signal: pending.controller.signal });
        if (current()) state.snapshots.set(id, { sessions, loading: false });
      } catch (error) {
        if (current()) state.snapshots.set(id, {
          sessions: state.snapshots.get(id)?.sessions ?? [], loading: false, error: remoteErrorMessage(error),
        });
      } finally {
        // An aborted request may finish after reactivation/reconnection. It must
        // never clear the newer lifecycle's lock or publish its stale reply.
        if (current()) {
          host.pending = undefined;
          pending.resolve();
          if (pending.trailing) void readHost(id, host).then(pending.trailing.resolve);
          else publish();
        }
      }
    })();
    return pending.promise;
  }, [publish]);

  const refresh = useCallback(async (hostId?: string, afterPending = true) => {
    const state = store.current;
    if (!state.mounted || !state.active) return;
    const selected = hostId === undefined ? [...state.hosts] : state.hosts.has(hostId) ? [[hostId, state.hosts.get(hostId)!] as const] : [];
    await Promise.all(selected.map(([id, host]) => {
      if (!host.pending) return read(id, host);
      if (!afterPending) return host.pending.promise;
      // Explicit refreshes share one successor, rather than each creating work.
      host.pending.trailing ??= completion();
      return host.pending.trailing.promise;
    }));
  }, [read]);

  useEffect(() => {
    store.current.mounted = true;
    return () => {
      store.current.mounted = false;
      store.current.active = false;
      for (const host of store.current.hosts.values()) invalidate(host);
    };
  }, []);

  const connectedKey = JSON.stringify([...new Set(hosts.filter(host => host.connectionState === "connected").map(host => host.id))].sort());
  useEffect(() => {
    const state = store.current;
    const replaced = state.client !== client;
    const resumed = active && !state.active;
    if (replaced || !active) {
      for (const host of state.hosts.values()) invalidate(host);
      for (const [id, snapshot] of state.snapshots) state.snapshots.set(id, { ...snapshot, loading: false });
    }
    if (replaced) {
      state.hosts.clear();
      state.snapshots.clear();
    }
    state.client = client;
    state.active = active;
    const connected = new Set<string>(JSON.parse(connectedKey));
    for (const [id, host] of state.hosts) if (!connected.has(id)) {
      invalidate(host);
      state.hosts.delete(id);
      state.snapshots.delete(id);
    }
    for (const id of connected) {
      const added = !state.hosts.has(id);
      if (added) state.hosts.set(id, {});
      if (active && (added || resumed || replaced)) void read(id, state.hosts.get(id)!);
    }
    publish();
  }, [client, active, connectedKey, publish, read]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      // Skip pending hosts outright: even a hung read must not accumulate
      // timer waiters or schedule a trailing poll.
      for (const [id, host] of store.current.hosts) if (!host.pending) void read(id, host);
    }, 5_000);
    return () => clearInterval(timer);
  }, [client, active, read]);

  return { ...view, refresh };
}
