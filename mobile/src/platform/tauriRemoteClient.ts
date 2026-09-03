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

interface InputResultEvent<T> {
  batchId: string;
  value?: T;
  error?: { code: string; message: string; status: string };
}

export class TauriRemoteClient implements RemoteClient {
  private readonly inputResults = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  private inputListener?: Promise<UnlistenFn>;

  private ensureInputListener(): Promise<UnlistenFn> {
    this.inputListener ??= listen<InputResultEvent<unknown>>(
      "agentport-mobile://input-result",
      ({ payload }) => {
        const pending = this.inputResults.get(payload.batchId);
        if (!pending) return;
        this.inputResults.delete(payload.batchId);
        if (payload.error) {
          pending.reject(Object.assign(new Error(payload.error.message), payload.error));
        } else {
          pending.resolve(payload.value);
        }
      },
    );
    return this.inputListener;
  }

  private async submitInput<T>(
    command: RequestCommand<T>,
    options: RemoteRequestOptions,
  ): Promise<T> {
    await this.ensureInputListener();
    const batchId = command.params && typeof command.params === "object" && "batchId" in command.params
      ? String(command.params.batchId)
      : "";
    if (!batchId || this.inputResults.has(batchId)) {
      throw new Error("Input batch ID must be unique");
    }
    return new Promise<T>((resolve, reject) => {
      this.inputResults.set(batchId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      void invoke("mobile_remote_submit_input", { command }).then(() => {
        options.onSubmitted?.();
      }).catch((error) => {
        this.inputResults.delete(batchId);
        options.onSubmitted?.();
        reject(error);
      });
    });
  }

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
    if (method === "session.input") return this.submitInput(command, options);
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
