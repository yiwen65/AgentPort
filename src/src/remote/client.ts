// RemoteClient: typed, injectable wrapper over the frozen Rust remote command
// contract (remote_connect / remote_disconnect / remote_request /
// remote_subscribe). The invoker and channel factory are injectable so tests
// never touch @tauri-apps/api. New desktop code.

import type {
  ChannelFactory,
  ChannelLike,
  RemoteEventWire,
  RemoteHello,
  RemoteInvoker,
} from "./types";
import { normalizeRequestError, RemoteRequestError } from "./errors";

export type RemoteConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

export interface RemoteClientOptions {
  deviceId: string;
  invoker: RemoteInvoker;
  /** Real runtime: () => new Channel<RemoteEventWire>() from @tauri-apps/api. */
  channelFactory: ChannelFactory<RemoteEventWire>;
  /** Called for every event pushed over the subscription channel. */
  onEvent?: (event: RemoteEventWire) => void;
  /** Called on every connection-state transition. */
  onStateChange?: (state: RemoteConnectionState) => void;
}

export class RemoteClient {
  readonly deviceId: string;

  private readonly invoker: RemoteInvoker;
  private readonly channelFactory: ChannelFactory<RemoteEventWire>;
  private readonly onStateChange?: (state: RemoteConnectionState) => void;

  private state: RemoteConnectionState = "disconnected";
  private hello: RemoteHello | null = null;
  private pendingConnect: Promise<RemoteHello> | null = null;
  private subscribed = false;
  private readonly eventListeners = new Set<(event: RemoteEventWire) => void>();

  constructor(options: RemoteClientOptions) {
    this.deviceId = options.deviceId;
    this.invoker = options.invoker;
    this.channelFactory = options.channelFactory;
    this.onStateChange = options.onStateChange;
    if (options.onEvent) this.eventListeners.add(options.onEvent);
  }

  /**
   * Subscribe to raw subscription events (RemoteBackend routes attachment
   * events from these). Returns an unsubscribe function; safe to call before
   * connect — listeners attach to the subscription channel when it opens.
   */
  addEventListener(
    listener: (event: RemoteEventWire) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  getState(): RemoteConnectionState {
    return this.state;
  }

  /** Negotiated hello facts; null before the first successful connect. */
  getHello(): RemoteHello | null {
    return this.hello;
  }

  hasCapability(name: string): boolean {
    return this.hello?.capabilities.includes(name) ?? false;
  }

  private setState(next: RemoteConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  /** Idempotent: concurrent callers share one in-flight connect. */
  connect(): Promise<RemoteHello> {
    if (this.state === "connected" && this.hello) {
      return Promise.resolve(this.hello);
    }
    if (this.pendingConnect) return this.pendingConnect;
    this.setState("connecting");
    const attempt = (async () => {
      try {
        const hello = (await this.invoker("remote_connect", {
          deviceId: this.deviceId,
        })) as RemoteHello;
        this.hello = hello;
        await this.ensureSubscribed();
        this.setState("connected");
        return hello;
      } catch (error) {
        this.setState("failed");
        throw normalizeRequestError(error);
      }
    })();
    this.pendingConnect = attempt;
    const releasePending = () => {
      if (this.pendingConnect === attempt) this.pendingConnect = null;
    };
    // then/catch form avoids a floating rejected promise on connect failure.
    attempt.then(releasePending, releasePending);
    return attempt;
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    const channel: ChannelLike<RemoteEventWire> = this.channelFactory();
    channel.onmessage = (event) => {
      // Copy: listeners may unsubscribe mid-dispatch (e.g. transport_closed
      // tearing attachments down).
      for (const listener of [...this.eventListeners]) listener(event);
    };
    await this.invoker("remote_subscribe", {
      deviceId: this.deviceId,
      channel,
    });
    this.subscribed = true;
  }

  async disconnect(): Promise<void> {
    this.subscribed = false;
    this.hello = null;
    try {
      await this.invoker("remote_disconnect", { deviceId: this.deviceId });
    } finally {
      this.setState("disconnected");
    }
  }

  /** Mark a live connection dead after a transport-level request failure. */
  markFailed(): void {
    if (this.state === "connected") this.setState("failed");
  }

  /**
   * One remote method call. Resolves with the method `value` on a succeeded
   * Result; rejects with RemoteRequestError otherwise. Never auto-connects —
   * connection lifecycle is owned by the device-switch flow (T-006).
   */
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.state !== "connected") {
      throw new RemoteRequestError(
        "not_connected",
        `device ${this.deviceId} is not connected`,
      );
    }
    try {
      return (await this.invoker("remote_request", {
        deviceId: this.deviceId,
        method,
        params,
      })) as T;
    } catch (error) {
      throw normalizeRequestError(error);
    }
  }
}
