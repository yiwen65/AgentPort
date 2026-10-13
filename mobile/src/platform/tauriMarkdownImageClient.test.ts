import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownImageClient } from "./tauriMarkdownImageClient";
import type { RemoteClient } from "../protocol/remoteClient";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue({ mime: "image/png", width: 1, height: 1, contentBase64: "YQ==" }));
function remote(size = 1) {
  const request = vi.fn().mockImplementation(async (_profile, method) => method.endsWith(".open") ? { downloadId: "id", sizeBytes: size, chunkBytes: 256 * 1024 } : method.endsWith(".chunk") ? { offset: 0, contentBase64: "YQ==", eof: true } : method.endsWith(".finish") ? { sizeBytes: 1, sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" } : { closed: true });
  return { client: { request } as unknown as RemoteClient, request };
}
describe("native image client", () => {
  it("fetches remote images on the reader, never through the document host", async () => {
    const state = remote(); const client = createMarkdownImageClient(state.client, "host", "session");
    await client.remote("https://example.com/image.png"); expect(invoke).toHaveBeenCalledWith("markdown_image_fetch", { url: "https://example.com/image.png" }); expect(state.request).not.toHaveBeenCalled();
  });
  it("streams local bytes via fixed Session and validates only after finish", async () => {
    const state = remote(); const client = createMarkdownImageClient(state.client, "host", "session");
    await client.local("images/a.png");
    expect(state.request.mock.calls.map(([, method]) => method)).toEqual(["session.files.download.open", "session.files.download.chunk", "session.files.download.finish", "session.files.download.close"]);
    expect(state.request).toHaveBeenNthCalledWith(1, "host", "session.files.download.open", { sessionId: "session", path: "images/a.png" });
    expect(invoke).toHaveBeenCalledWith("markdown_image_validate", { contentBase64: "YQ==" });
  });
  it("rejects size before transferring and closes its handle without using global download state", async () => {
    const state = remote(20 * 1024 * 1024 + 1);
    await expect(createMarkdownImageClient(state.client, "host", "session").local("a.png")).rejects.toMatchObject({ code: "image_too_large" });
    expect(state.request.mock.calls.map(([, method]) => method)).toEqual(["session.files.download.open", "session.files.download.close"]); expect(invoke).not.toHaveBeenCalled();
  });
  it("always closes malformed streams and does not validate them", async () => {
    const state = remote(); state.request.mockImplementation(async (_profile, method) => method.endsWith(".open") ? { downloadId: "id", sizeBytes: 1 } : method.endsWith(".chunk") ? { offset: 9, contentBase64: "YQ==", eof: true } : { closed: true });
    await expect(createMarkdownImageClient(state.client, "host", "session").local("a.png")).rejects.toMatchObject({ code: "invalid_image" }); expect(state.request.mock.calls.at(-1)?.[1]).toBe("session.files.download.close"); expect(invoke).not.toHaveBeenCalled();
  });
});
