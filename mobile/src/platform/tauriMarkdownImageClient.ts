import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RemoteClient } from "../protocol/remoteClient";
import { MAX_IMAGE_BYTES, type MarkdownImageClient, type MarkdownImageData } from "../protocol/markdownImageClient";

export function createMarkdownImageClient(remote: RemoteClient, profileId: string, sessionId: string): MarkdownImageClient {
  const native = <T,>(command: string, args: Record<string, unknown>) => {
    if (!isTauri()) return Promise.reject({ code: "image_native_required" });
    return invoke<T>(command, args);
  };
  return {
    scope: `${profileId}:${sessionId}`,
    remote: url => native<MarkdownImageData>("markdown_image_fetch", { url }),
    local: async (path, options) => {
      let downloadId: string | undefined;
      const check = () => { if (options?.signal?.aborted) throw { code: "image_cancelled" }; };
      // Never abort open: its eventual ID must be observed and closed, even if
      // the viewer exits while open is in flight. Close itself is uncancellable.
      const request = <T,>(method: string, params: Record<string, unknown>) => options?.signal && method !== "open" && method !== "close"
        ? remote.request<T>(profileId, `session.files.download.${method}`, params, { signal: options.signal })
        : remote.request<T>(profileId, `session.files.download.${method}`, params);
      try {
        check();
        const opened = await request<{ downloadId: string; sizeBytes: number; chunkBytes: number }>("open", { sessionId, path });
        downloadId = opened.downloadId;
        check();
        if (!downloadId || !Number.isSafeInteger(opened.sizeBytes) || opened.sizeBytes < 1) throw { code: "invalid_image" };
        if (opened.sizeBytes > MAX_IMAGE_BYTES) throw { code: "image_too_large" };
        const parts: string[] = []; let offset = 0;
        while (offset < opened.sizeBytes) {
          check();
          const chunk = await request<{ offset: number; contentBase64: string; eof: boolean }>("chunk", { downloadId, offset });
          if (typeof chunk.contentBase64 !== "string" || chunk.contentBase64.length > Math.ceil(256 * 1024 / 3) * 4) throw { code: "invalid_image" };
          check();
          const bytes = atob(chunk.contentBase64);
          if (chunk.offset !== offset || !bytes.length || bytes.length > 256 * 1024 || bytes.length > opened.sizeBytes - offset) throw { code: "invalid_image" };
          parts.push(bytes); offset += bytes.length;
          if (chunk.eof !== (offset === opened.sizeBytes)) throw { code: "invalid_image" };
        }
        const finished = await request<{ sizeBytes: number; sha256: string }>("finish", { downloadId });
        if (finished.sizeBytes !== offset || !/^[a-f0-9]{64}$/i.test(finished.sha256)) throw { code: "invalid_image" };
        const binary = parts.join("");
        if (globalThis.crypto?.subtle) {
          const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(binary, char => char.charCodeAt(0)));
          if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== finished.sha256.toLowerCase()) throw { code: "invalid_image" };
        }
        check();
        const data = await native<MarkdownImageData>("markdown_image_validate", { contentBase64: btoa(binary), ...(options?.animationLimits ? { animationLimits: true } : {}) });
        check();
        return data;
      } finally {
        if (downloadId) await request("close", { downloadId }).catch(() => undefined);
      }
    },
  };
}
