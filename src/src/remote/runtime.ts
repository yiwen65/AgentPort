// Runtime registry: deviceId → RemoteBackend wired to the real Tauri
// runtime. Kept separate from dispatch.ts so the dispatcher stays testable
// without @tauri-apps/api, and so device-switch (T-006) can drop cached
// backends when a connection is torn down. New desktop code.

import { Channel, invoke } from "@tauri-apps/api/core";
import { RemoteBackend } from "./backend";
import { RemoteClient } from "./client";
import type { RemoteEventWire } from "./types";

export type RemoteBackendFactory = (deviceId: string) => RemoteBackend;

const backends = new Map<string, RemoteBackend>();
let factoryOverride: RemoteBackendFactory | null = null;

function defaultFactory(deviceId: string): RemoteBackend {
  const client = new RemoteClient({
    deviceId,
    invoker: (command, args) => invoke(command, args),
    channelFactory: () => new Channel<RemoteEventWire>(),
  });
  return new RemoteBackend(client);
}

/** Lazily create (and cache) the backend for one device. */
export function remoteBackendFor(deviceId: string): RemoteBackend {
  let backend = backends.get(deviceId);
  if (!backend) {
    backend = (factoryOverride ?? defaultFactory)(deviceId);
    backends.set(deviceId, backend);
  }
  return backend;
}

/** Forget a cached backend (device switch/teardown). Idempotent. */
export function dropRemoteBackend(deviceId: string): void {
  backends.delete(deviceId);
}

/** Test hook: substitute backend construction; pass null to restore. */
export function setRemoteBackendFactoryForTests(
  factory: RemoteBackendFactory | null,
): void {
  factoryOverride = factory;
  backends.clear();
}

/** Test hook: drop every cached backend. */
export function resetRemoteBackendsForTests(): void {
  factoryOverride = null;
  backends.clear();
}
