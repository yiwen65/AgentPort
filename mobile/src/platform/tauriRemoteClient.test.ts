import { beforeEach, describe, expect, it, vi } from "vitest";
import { TauriRemoteClient } from "./tauriRemoteClient";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  connectionListener: undefined as ((event: { payload: unknown }) => void) | undefined,
  inputListener: undefined as ((event: { payload: unknown }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_eventName: string, listener: (event: { payload: unknown }) => void) => {
    if (_eventName.endsWith("connection-state")) tauri.connectionListener = listener;
    else tauri.inputListener = listener;
    return () => undefined;
  }),
}));

describe("TauriRemoteClient ordered input submission", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.inputListener = undefined;
  });

  it("cancels an in-flight local wait and ignores its late reply without claiming a mutation was cancelled", async () => {
    let complete!: (value: unknown) => void;
    tauri.invoke.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const client = new TauriRemoteClient();
    const controller = new AbortController();
    const request = client.request("host-1", "session.list", {}, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError", status: "unknown" });
    complete([]);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not let an older profile snapshot overwrite a newly connected event", async () => {
    let complete!: (value: unknown) => void;
    tauri.invoke.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const client = new TauriRemoteClient();
    await client.onConnectionState(() => {});
    const listing = client.listHostProfiles();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    tauri.connectionListener?.({ payload: { profileId: "host-1", state: "connected" } });
    complete([{ id: "host-1", connectionState: "disconnected" }]);
    await expect(listing).resolves.toEqual([expect.objectContaining({ connectionState: "connected" })]);
  });

  it("separates local transport submission from the remote input result", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const client = new TauriRemoteClient();
    const onSubmitted = vi.fn();
    const result = client.request<{ phase: string }>("host-1", "session.input", {
      attachmentId: "att-1",
      batchId: "batch-1",
      dataBase64: "YQ==",
    }, { onSubmitted });

    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(tauri.invoke).toHaveBeenCalledWith("mobile_remote_submit_input", {
      command: expect.objectContaining({
        profileId: "host-1",
        method: "session.input",
        params: expect.objectContaining({ batchId: "batch-1" }),
      }),
    });

    let settled = false;
    void result.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    tauri.inputListener?.({ payload: {
      batchId: "batch-1",
      value: { phase: "completed" },
    } });
    await expect(result).resolves.toEqual({ phase: "completed" });
  });

  it("preserves structured unknown errors from the eventual result", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const client = new TauriRemoteClient();
    const result = client.request("host-1", "session.input", {
      attachmentId: "att-1",
      batchId: "batch-unknown",
      dataBase64: "Yg==",
    });
    await vi.waitFor(() => expect(tauri.inputListener).toBeTypeOf("function"));

    tauri.inputListener?.({ payload: {
      batchId: "batch-unknown",
      error: { code: "connection_unknown", message: "result unknown", status: "unknown" },
    } });

    await expect(result).rejects.toMatchObject({
      message: "result unknown",
      code: "connection_unknown",
      status: "unknown",
    });
  });
});
