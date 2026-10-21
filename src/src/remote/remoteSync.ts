// Remote sync engine: while a remote device is active there is no global
// event push (the bridge only streams per-attachment subscription events), so
// this engine drives the SAME store effects local tauri events produce —
// project/session/unread snapshots via the shared refreshProjects() (which is
// device-routed), plus LOCAL macOS notifications for fresh attention items via
// the local remote_attention_notify command. Polls are visibility-aware,
// coalesced, and stop completely on device switch/disconnect.
// New desktop code (desktop multi-device switching).

import { refreshProjects, refreshProjectsSoon } from "../actions";
import { api } from "../api";
import { activeDeviceContext } from "../deviceContext";
import { getState } from "../store";
import type { RemoteBackend } from "./backend";
import { isRemoteRequestError } from "./errors";
import { remoteBackendFor } from "./runtime";
import type { AttentionCursor, RemoteAttentionEvent } from "./types";

export const REMOTE_SYNC_POLL_MS = 5000;
/** Mirror of the Rust freshness window (remote/attention_notify.rs). */
export const REMOTE_ATTENTION_FRESHNESS_MS = 30_000;
const ATTENTION_POLL_LIMIT = 100;
/** Mutation hint → attention poll delay (the server needs a beat to journal). */
const MUTATION_ATTENTION_DELAY_MS = 500;

/** Methods whose success must not trigger a snapshot refresh: the engine's
 * own polls, long-polls, and pure connection calls. Everything else that
 * succeeds is treated as a possible mutation and earns one coalesced
 * refreshProjectsSoon() plus a delayed attention poll. */
const REFRESH_SKIP_METHODS: ReadonlySet<string> = new Set([
  "boot",
  "project.list",
  "session.list",
  "session.poll",
  "session.attach",
  "session.detach",
  // Input is terminal traffic, not a project/session mutation. Treating it
  // as one refreshed the whole remote snapshot on every keystroke/wheel
  // report, competing with the terminal stream on the same link.
  "session.input",
  "attention.poll",
  "agent.supported",
  "agent.probe",
  "agent.probe_all",
  "agent.preferences",
  "preset.list",
  "timeline.get",
  "search.global",
  "search.session",
  "history.page",
  "settings.get",
  "secret.status",
  "secret.list",
  "diagnostics.hosts",
  "diagnostics.summary",
  "diagnostics.capabilities",
  "backup.list",
  "backup.verify",
  "document.read",
  "document.list",
  "worktree.preview",
  "worktree.list",
  "worktree.status",
  "branch.status",
  "branch.list",
  "branch.autostash.list",
  "git.context.resolve",
  "git.changes",
  "git.diff",
  "git.history",
  "git.commit.detail",
  "git.commit.diff",
  "git.file.resolve",
  "commit_ai.config.get",
  "storage.legacy.inventory",
  "export.session",
  "image.begin",
  "image.chunk",
]);

export interface RemoteSyncDeps {
  backend: Pick<RemoteBackend, "pollAttention" | "setRequestHook">;
  deviceId: string;
  deviceName: string;
  /** Injected for tests; production binds actions.ts/api.ts/store. */
  refreshProjects: () => Promise<unknown>;
  refreshProjectsSoon: () => void;
  notifyAttention: (event: RemoteAttentionEvent) => Promise<unknown>;
  isDocumentHidden: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  now: () => number;
  pollIntervalMs: number;
}

export interface RemoteSync {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** RemoteBackend request-hook entry point (mutation hint). */
  onRemoteRequest(method: string, ok: boolean): void;
}

export function createRemoteSync(deps: RemoteSyncDeps): RemoteSync {
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let attentionTimer: ReturnType<typeof setTimeout> | null = null;
  let removeVisibilityListener: (() => void) | null = null;
  let attentionCursor: AttentionCursor | null = null;
  let tickInFlight = false;

  async function pollAttentionOnce(): Promise<void> {
    try {
      const result = await deps.backend.pollAttention(
        attentionCursor,
        ATTENTION_POLL_LIMIT,
      );
      const now = deps.now();
      for (const event of result.events) {
        attentionCursor = event.cursor;
        const occurredAt = Date.parse(event.cursor.occurredAt);
        if (Number.isNaN(occurredAt) || now - occurredAt > REMOTE_ATTENTION_FRESHNESS_MS) {
          // Replayed history stays durable/unread but is not a fresh alert.
          continue;
        }
        try {
          await deps.notifyAttention(event);
        } catch {
          // A single notification failure must not stall cursor advancement.
        }
      }
      if (result.nextCursor) attentionCursor = result.nextCursor;
    } catch (error) {
      if (isRemoteRequestError(error) && error.code === "not_connected") {
        stop();
      }
      // Other poll failures are retried at the next cadence.
    }
  }

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await deps.refreshProjects();
      await pollAttentionOnce();
    } finally {
      tickInFlight = false;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    pollTimer = setInterval(() => {
      if (deps.isDocumentHidden()) return;
      void tick();
    }, deps.pollIntervalMs);
    removeVisibilityListener = deps.onVisibilityChange(() => {
      if (!deps.isDocumentHidden()) void tick();
    });
    deps.backend.setRequestHook((method, ok) => sync.onRemoteRequest(method, ok));
    void tick();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (attentionTimer !== null) {
      clearTimeout(attentionTimer);
      attentionTimer = null;
    }
    removeVisibilityListener?.();
    removeVisibilityListener = null;
    deps.backend.setRequestHook(null);
  }

  const sync: RemoteSync = {
    start,
    stop,
    isRunning: () => running,
    onRemoteRequest(method, ok) {
      if (!running || !ok || REFRESH_SKIP_METHODS.has(method)) return;
      deps.refreshProjectsSoon();
      if (attentionTimer === null) {
        attentionTimer = setTimeout(() => {
          attentionTimer = null;
          if (running && !deps.isDocumentHidden()) void pollAttentionOnce();
        }, MUTATION_ATTENTION_DELAY_MS);
      }
    },
  };
  return sync;
}

// ---------------------------------------------------------------------------
// Production wiring (device-switch lifecycle owns start/stop)
// ---------------------------------------------------------------------------

let active: { deviceId: string; sync: RemoteSync } | null = null;

function sessionTitleFor(sessionId: string): string | null {
  for (const project of getState().projects) {
    const session = project.sessions.find((entry) => entry.id === sessionId);
    if (session) return session.title;
  }
  return null;
}

/** Start syncing the now-active remote device. Idempotent per device. */
export function startRemoteSync(deviceId: string): void {
  stopRemoteSync();
  const context = activeDeviceContext();
  const deviceName =
    context.kind === "remote" && context.deviceId === deviceId
      ? context.deviceName
      : deviceId;
  const backend = remoteBackendFor(deviceId);
  const sync = createRemoteSync({
    backend,
    deviceId,
    deviceName,
    refreshProjects: () => refreshProjects(),
    refreshProjectsSoon: () => refreshProjectsSoon(),
    notifyAttention: (event) =>
      api.remoteAttentionNotify({
        deviceId,
        deviceName,
        sessionId: event.sessionId,
        sessionTitle: sessionTitleFor(event.sessionId) ?? event.sessionId,
        runId: event.runId,
        runOrdinal: event.cursor.runOrdinal,
        sequence: event.cursor.sequence,
        kind: event.kind,
        occurredAt: event.cursor.occurredAt,
      }),
    isDocumentHidden: () => document.hidden,
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    now: () => Date.now(),
    pollIntervalMs: REMOTE_SYNC_POLL_MS,
  });
  sync.start();
  active = { deviceId, sync };
}

/** Stop the engine (device switch/teardown, disconnect). Idempotent. */
export function stopRemoteSync(): void {
  active?.sync.stop();
  active = null;
}

/** Test hook: the device id currently being synced, if any. */
export function activeRemoteSyncDevice(): string | null {
  return active?.deviceId ?? null;
}
