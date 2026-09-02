import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  HostProfileSummary,
  RemoteClient,
  RemoteConnectionSnapshot,
  RemoteConnectionStateEvent,
  RemoteEvent,
  RemoteRequestOptions,
  Unsubscribe,
} from "../protocol/remoteClient";

interface RequestCommand<T> {
  profileId: string;
  method: string;
  params: unknown;
  precondition: RemoteRequestOptions["precondition"];
}

export class TauriRemoteClient implements RemoteClient {
  listHostProfiles(): Promise<HostProfileSummary[]> {
    return invoke("mobile_list_host_profiles");
  }

  async connect(profileId: string, signal?: AbortSignal): Promise<RemoteConnectionSnapshot> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const cancel = () => { void invoke("mobile_disconnect_host", { profileId }); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await invoke("mobile_connect_host", { profileId });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  disconnect(profileId: string): Promise<void> {
    return invoke("mobile_disconnect_host", { profileId });
  }

  request<T>(
    profileId: string,
    method: string,
    params: unknown = {},
    options: RemoteRequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    const command: RequestCommand<T> = {
      profileId,
      method,
      params,
      precondition: options.precondition,
    };
    return invoke("mobile_remote_request", { command });
  }

  async onConnectionState(
    listener: (event: RemoteConnectionStateEvent) => void,
  ): Promise<Unsubscribe> {
    const unlisten = await listen<RemoteConnectionStateEvent>(
      "agentport-mobile://connection-state",
      ({ payload }) => listener(payload),
    );
    return async () => unlisten();
  }

  async subscribe<T>(
    profileId: string,
    topics: string[],
    listener: (event: RemoteEvent<T>) => void,
  ): Promise<Unsubscribe> {
    const subscriptionId = await invoke<string>("mobile_subscribe", { profileId, topics });
    const eventName = `agentport-mobile://remote/${subscriptionId}`;
    const unlisten: UnlistenFn = await listen<RemoteEvent<T>>(eventName, ({ payload }) => {
      listener(payload);
    });
    return async () => {
      unlisten();
      await invoke("mobile_unsubscribe", { profileId, subscriptionId });
    };
  }
}

export const remoteClient: RemoteClient = new TauriRemoteClient();
