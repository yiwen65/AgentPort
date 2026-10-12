import { describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { TauriFileDownloadClient } from "./tauriFileDownloadClient";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}), isTauri: vi.fn().mockReturnValue(true) }));
describe("native file download adapter", () => {
  it("sends only remote source IDs and native-owned job IDs, never file bytes or local paths", async () => {
    const client = new TauriFileDownloadClient();
    const source = { profileId: "host", sessionId: "session", path: "binary.zip" };
    await client.start(source); await client.poll("job"); await client.cancel("job"); await client.save("job"); await client.discard("job");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["mobile_file_download_start", { request: source }], ["mobile_file_download_poll", { jobId: "job" }],
      ["mobile_file_download_cancel", { jobId: "job" }], ["mobile_file_download_save", { jobId: "job" }], ["mobile_file_download_discard", { jobId: "job" }],
    ]);
  });
  it("does not claim browser saving support", () => { vi.mocked(isTauri).mockReturnValueOnce(false); expect(new TauriFileDownloadClient().available()).toBe(false); });
});
