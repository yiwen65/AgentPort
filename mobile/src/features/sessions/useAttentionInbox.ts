import { useCallback, useEffect, useRef, useState } from "react";
import type { HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import { AttentionInbox, type InboxEntry } from "./attentionInbox";
import type { AttentionPollResult, SessionSummary } from "./types";

type SeenCursor = { runId: string; runOrdinal: number; sequence: number };
const EMPTY_SESSIONS_BY_HOST: ReadonlyMap<string, readonly SessionSummary[]> = new Map();

/** Metadata-only incremental fallback. APNs is the background delivery path;
 * never keep a suspended WebView alive to poll. Each Host has one in-flight
 * request, one timer and exponential idle/error backoff (5s..30s / 60s). */
export function useAttentionInbox(
  client: RemoteClient,
  hosts: HostProfileSummary[],
  visible: boolean,
  authoritativeSessions: ReadonlyMap<string, readonly SessionSummary[]> = EMPTY_SESSIONS_BY_HOST,
) {
  const boxes = useRef(new Map<string, AttentionInbox>());
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [error, setError] = useState("");
  const errors = useRef(new Map<string, string>());
  const pendingSeen = useRef(new Map<string, Map<string, SeenCursor>>());
  const seenFlushes = useRef(new Map<string, Promise<void>>());
  const titles = useRef(new Map<string, Map<string, string>>());
  const box = useCallback((host: string) => {
    let value = boxes.current.get(host);
    if (!value) { value = new AttentionInbox(host); boxes.current.set(host, value); }
    return value;
  }, []);
  const publish = useCallback(() => setEntries([...boxes.current.values()].flatMap(value => value.entries)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))), []);
  const report = useCallback((host: string, failure?: unknown) => {
    if (failure) errors.current.set(host, remoteErrorMessage(failure));
    else errors.current.delete(host);
    setError([...errors.current.values()][0] ?? "");
  }, []);
  const isHostNotConnected = (failure: unknown) => Boolean(failure && typeof failure === "object" && "code" in failure && (failure as { code?: unknown }).code === "host_not_connected");
  const flushSeen = useCallback((hostId: string): Promise<void> => {
    if (!visible) return Promise.resolve();
    const active = seenFlushes.current.get(hostId);
    if (active) return active;
    let task!: Promise<void>;
    task = (async () => {
      for (;;) {
        if (!visible) return;
        const pending = pendingSeen.current.get(hostId);
        if (!pending?.size) return;
        for (const [sessionId, cursor] of [...pending]) {
          try {
            await client.request<void>(hostId, "session.seen.mark", { sessionId, cursor });
            if (pending.get(sessionId) === cursor) pending.delete(sessionId);
          } catch (failure) {
            // A reader reconnect can briefly lag the profile's connected phase.
            // Keep the cursor queued and retry on the next successful poll.
            if (!isHostNotConnected(failure)) report(hostId, failure);
            return;
          }
        }
        if (!pending.size) pendingSeen.current.delete(hostId);
      }
    })().finally(() => {
      if (seenFlushes.current.get(hostId) === task) seenFlushes.current.delete(hostId);
    });
    seenFlushes.current.set(hostId, task);
    return task;
  }, [client, report]);
  const profiles = hosts.map(host => `${host.id}:${host.connectionState}`).sort().join("|");
  useEffect(() => {
    let changed = false;
    for (const [hostId, sessions] of authoritativeSessions) {
      try { changed = box(hostId).reconcile(sessions) || changed; }
      catch (failure) { report(hostId, failure); }
    }
    if (changed) publish();
  }, [authoritativeSessions, box, publish, report]);
  useEffect(() => {
    const retained = new Set(hosts.map(host => host.id));
    for (const id of boxes.current.keys()) if (!retained.has(id)) {
      boxes.current.delete(id); titles.current.delete(id); errors.current.delete(id);
    }
    const pollingHosts = visible ? hosts.filter(item => item.connectionState === "connected") : [];
    // A newly started connected polling lifecycle supersedes failures from its
    // predecessor. Do not keep presenting an old failure while the first fresh
    // poll is in flight; a failure in this lifecycle reports again.
    for (const host of pollingHosts) errors.current.delete(host.id);
    setError([...errors.current.values()][0] ?? "");
    for (const host of hosts) { try { box(host.id); } catch (failure) { report(host.id, failure); } }
    publish();
    if (!visible) return;
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    for (const host of pollingHosts) {
      let idle = 0, failures = 0;
      const poll = async () => {
        let delay = 5_000;
        try {
          const inbox = box(host.id);
          const result = await client.request<AttentionPollResult>(host.id, "attention.poll",
            { cursor: inbox.cursor ?? null, limit: 64 }, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!result || !Array.isArray(result.events)) throw new Error("Invalid attention response");
          let names = titles.current.get(host.id) ?? new Map<string, string>();
          if (result.events.some(event => !names.has(event.sessionId))) {
            // At most one metadata lookup per page, never per event or timer.
            const sessions = await client.request<SessionSummary[]>(host.id, "session.list", { includeArchived: false }, { signal: controller.signal });
            if (controller.signal.aborted) return;
            names = new Map(sessions.map(session => [session.id, session.title]));
            for (const event of result.events) if (!names.has(event.sessionId)) names.set(event.sessionId, event.sessionId);
            titles.current.set(host.id, names);
          }
          // A page can be short because we request 64. Pass explicit tail status
          // rather than treating every short page as a complete baseline.
          const changed = inbox.ingest(result, names, 64);
          if (changed) publish();
          void flushSeen(host.id);
          failures = 0;
          idle = result.events.length ? 0 : Math.min(idle + 1, 3);
          delay = result.events.length === 64 || inbox.pendingCount ? 250 : Math.min(30_000, 5_000 * 2 ** idle);
          report(host.id);
        } catch (failure) {
          if (controller.signal.aborted) return;
          report(host.id, failure);
          delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures++, 4));
        } finally {
          if (!controller.signal.aborted) {
            const timer = setTimeout(() => { timers.delete(timer); void poll(); }, delay);
            timers.add(timer);
          }
        }
      };
      void poll();
    }
    return () => { controller.abort(); for (const timer of timers) clearTimeout(timer); };
    // Connection topology, not mutable profile labels or Dashboard selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, profiles, visible, box, publish, report, flushSeen]);
  const acknowledge = useCallback(async (hostId: string, sessionId: string, cursor: SeenCursor) => {
    let pending = pendingSeen.current.get(hostId);
    if (!pending) { pending = new Map(); pendingSeen.current.set(hostId, pending); }
    pending.set(sessionId, cursor);
    // Clear the device-local inbox immediately. The shared Host acknowledgement
    // is retried independently if the transport is between reconnect phases.
    if (box(hostId).acknowledge(sessionId, cursor)) publish();
    report(hostId);
    if (visible) await flushSeen(hostId);
  }, [box, flushSeen, publish, report, visible]);
  const clearAll = useCallback(async () => {
    await Promise.all(entries.map(entry => acknowledge(entry.hostId, entry.sessionId, entry)));
  }, [entries, acknowledge]);
  return { entries, error, acknowledge, clearAll };
}
