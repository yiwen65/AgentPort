export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stale"
  | "failed";

export interface HostProfileSummary {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  preferredTransport: "ssh" | "mosh";
  connectionState: ConnectionState;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export interface RemoteCapability {
  name: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface RemoteConnectionStateEvent {
  profileId: string;
  state: ConnectionState;
  attempt?: number;
  reason?: string;
}

export interface RemoteConnectionSnapshot {
  profileId: string;
  protocolMajor: number;
  protocolMinor: number;
  agentportVersion: string;
  platform: string;
  capabilities: RemoteCapability[];
}

export interface RemoteEvent<T = unknown> {
  subscriptionId: string;
  eventType: string;
  cursor: unknown;
  payload: T;
}

export interface RemoteRequestOptions {
  precondition?: { revision?: number | string; cursor?: unknown };
  signal?: AbortSignal;
}

export type Unsubscribe = () => Promise<void>;

/**
 * Stable feature boundary. Feature modules never import Tauri APIs directly;
 * the platform adapter owns native invokes and event listeners.
 */
export interface RemoteClient {
  listHostProfiles(): Promise<HostProfileSummary[]>;
  connect(profileId: string, signal?: AbortSignal): Promise<RemoteConnectionSnapshot>;
  disconnect(profileId: string): Promise<void>;
  request<T>(
    profileId: string,
    method: string,
    params?: unknown,
    options?: RemoteRequestOptions,
  ): Promise<T>;
  subscribe<T>(
    profileId: string,
    topics: string[],
    listener: (event: RemoteEvent<T>) => void,
  ): Promise<Unsubscribe>;
  onConnectionState(listener: (event: RemoteConnectionStateEvent) => void): Promise<Unsubscribe>;
}
