import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HostAuthClient } from "../features/hosts-auth/types";
import type { OpenSession } from "../features/sessions/types";
import type { RemoteClient } from "../protocol/remoteClient";
import type { SessionSummary } from "../features/sessions/types";

interface PushTap { hostId: string; sessionId: string }
interface PushState {
  token: string | null;
  permission: string;
  environment: "sandbox" | "production" | null;
  pendingTap: PushTap | null;
}

/** APNs is only an OS-visible hint. Authoritative session/inbox state is fetched
 * over the authenticated connection after a tap or on foreground recovery. */
export function usePushAlerts(client: RemoteClient, hostAuth: HostAuthClient, profilesEpoch: number,
  onOpen: (session: OpenSession) => void) {
  const pending = useRef<PushTap | null>(null);
  const registered = useRef(new Set<string>());
  const current = useRef({ client, hostAuth, onOpen });
  current.current = { client, hostAuth, onOpen };
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let running = false;
    let again = false;
    let askedPermission = false;
    const sync = async () => {
      if (running) { again = true; return; }
      running = true;
      do {
        again = false;
        try {
          const state = await invoke<PushState>("mobile_push_take_state");
          if (stopped) break;
          if (state.pendingTap) pending.current = state.pendingTap;
          const { client, hostAuth, onOpen } = current.current;
          const hosts = await client.listHostProfiles();
          if (stopped) break;
          const paired = hosts.filter(host => host.preferredTransport === "relay");
          if (paired.length && state.permission === "notDetermined" && !askedPermission) {
            askedPermission = true;
            await invoke("mobile_push_register");
            again = true; // APNs returns its token asynchronously via mobile-push-token.
          }
          const target = pending.current;
          if (target) {
            for (const host of paired) {
              if (stopped || pending.current !== target) break;
              let profile;
              try { profile = await hostAuth.getProfile(host.id); } catch { continue; }
              // A push payload is untrusted: only a currently approved, pinned
              // Relay host with the matching identity can select a session.
              if (!profile.enabled || !profile.relay?.approved || profile.relay.peer.hostId !== target.hostId) continue;
              try {
                if (host.connectionState !== "connected") await client.connect(host.id);
                const sessions = await client.request<SessionSummary[]>(host.id, "session.list", { includeArchived: false });
                if (stopped || pending.current !== target) break;
                const session = sessions.find(item => item.id === target.sessionId);
                if (session) onOpen({ hostProfileId: host.id, hostName: host.name, session });
                // The native tap survives a webview reload until this trusted
                // host/session lookup is complete. Ack compares IDs so a newer
                // tap cannot be cleared by an older asynchronous lookup.
                await invoke("mobile_push_ack_tap", { tap: target });
                pending.current = null; // Missing/archived Session remains visible in the inbox.
                break;
              } catch { /* Leave the target pending until reconnection. */ }
            }
          }
          // Registration can take 15s per offline Mac. Never let that block
          // the cold-start tap's authenticated session lookup.
          if (state.token && (state.permission === "authorized" || state.permission === "provisional")
            && (state.environment === "sandbox" || state.environment === "production")) {
            for (const host of paired) {
              if (stopped) break;
              const key = `${host.id}:${state.environment}:${state.token}`;
              if (registered.current.has(key)) continue;
              try {
                await invoke("mobile_register_push_token", { profileId: host.id, token: state.token,
                  environment: state.environment });
                registered.current.add(key);
              } catch { /* Offline or old Connector: retry on foreground / reconnection. */ }
            }
          }
        } catch { /* Unsupported platform or temporarily unavailable state. */ }
      } while (again && !stopped);
      running = false;
    };
    refresh.current = sync;
    const onVisible = () => { if (document.visibilityState !== "hidden") void sync(); };
    document.addEventListener("visibilitychange", onVisible);
    let unsubToken: (() => void) | undefined;
    let unsubTap: (() => void) | undefined;
    let unsubConnection: (() => void) | undefined;
    void Promise.all([
      listen("mobile-push-token", () => { void sync(); }),
      listen("mobile-push-tap", () => { void sync(); }),
      current.current.client.onConnectionState(() => { if (pending.current) void sync(); }),
    ]).then(([token, tap, connection]) => {
      if (stopped) { token(); tap(); void connection(); }
      else { unsubToken = token; unsubTap = tap; unsubConnection = connection; }
    }).catch(() => {});
    void sync();
    return () => { stopped = true; document.removeEventListener("visibilitychange", onVisible);
      unsubToken?.(); unsubTap?.(); void unsubConnection?.(); };
  }, []);
  useEffect(() => { if (isTauri()) void refresh.current(); }, [profilesEpoch]);
}
