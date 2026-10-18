import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { RemoteClient } from "../protocol/remoteClient";
import { createMarkdownImageClient } from "./tauriMarkdownImageClient";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
const data = { mime: "image/gif", width: 1, height: 1, contentBase64: "YQ==" };
const opened = { downloadId: "owned", sizeBytes: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup() {
  const request = vi.fn().mockImplementation(async (_host, method) => method.endsWith(".open") ? opened : method.endsWith(".chunk") ? { offset: 0, contentBase64: "YQ==", eof: true } : method.endsWith(".finish") ? { sizeBytes: 1, sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" } : { closed: true });
  return { request, client: createMarkdownImageClient({ request } as unknown as RemoteClient, "host", "session") };
}
beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(data));
describe("standalone image client lifecycle", () => {
  it("opts into native animation limits without changing the RPC surface", async () => {
    const state = setup(); const controller = new AbortController();
    await expect(state.client.local("a.gif", { animationLimits: true, signal: controller.signal })).resolves.toEqual(data);
    expect(invoke).toHaveBeenCalledWith("markdown_image_validate", { contentBase64: "YQ==", animationLimits: true });
    expect(state.request).toHaveBeenNthCalledWith(2, "host", "session.files.download.chunk", { downloadId: "owned", offset: 0 }, { signal: controller.signal });
    expect(state.request).toHaveBeenLastCalledWith("host", "session.files.download.close", { downloadId: "owned" });
  });
  it("does not open a handle when already cancelled", async () => {
    const state = setup(); const controller = new AbortController(); controller.abort();
    await expect(state.client.local("a.gif", { signal: controller.signal })).rejects.toMatchObject({ code: "image_cancelled" }); expect(state.request).not.toHaveBeenCalled();
  });
  it("observes and closes a late open instead of orphaning its handle", async () => {
    const state = setup(); const pending = deferred<typeof opened>(); state.request.mockReturnValueOnce(pending.promise);
    const controller = new AbortController(); const work = state.client.local("a.gif", { signal: controller.signal });
    controller.abort(); pending.resolve(opened);
    await expect(work).rejects.toMatchObject({ code: "image_cancelled" });
    expect(state.request.mock.calls.map(([, method]) => method)).toEqual(["session.files.download.open", "session.files.download.close"]); expect(invoke).not.toHaveBeenCalled();
  });
  it("closes after a cancelled chunk and does not run native validation", async () => {
    const state = setup(); const controller = new AbortController();
    state.request.mockImplementation(async (_host, method) => {
      if (method.endsWith(".open")) return opened;
      if (method.endsWith(".chunk")) { controller.abort(); throw { code: "request_cancelled" }; }
      return { closed: true };
    });
    await expect(state.client.local("a.gif", { signal: controller.signal })).rejects.toMatchObject({ code: "request_cancelled" });
    expect(state.request.mock.calls.at(-1)?.[1]).toBe("session.files.download.close"); expect(invoke).not.toHaveBeenCalled();
  });
  it("ignores a native result arriving after exit but still closes the handle", async () => {
    const state = setup(); const controller = new AbortController();
    vi.mocked(invoke).mockImplementationOnce(async () => { controller.abort(); return data; });
    await expect(state.client.local("a.gif", { signal: controller.signal })).rejects.toMatchObject({ code: "image_cancelled" });
    expect(state.request.mock.calls.at(-1)?.[1]).toBe("session.files.download.close");
  });
});
