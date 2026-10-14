import { Blob as NativeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageAsset } from "./markdownImageAssets";

// Capture actual Blob bytes, not just a mocked URL or byte-count metadata.
afterEach(() => vi.unstubAllGlobals());

describe("image asset byte conversion", () => {
  it.each([1, 2, 3, 256, 65_537])("preserves all binary code units and base64 padding for %s bytes", async length => {
    const expected = Uint8Array.from({ length }, (_, index) => index % 256);
    let captured: NativeBlob | undefined;
    vi.stubGlobal("Blob", NativeBlob);
    vi.stubGlobal("URL", { createObjectURL(blob: NativeBlob) { captured = blob; return "blob:byte-fixture"; } });
    const asset = createImageAsset({ mime: "image/png", width: 1, height: 1,
      contentBase64: btoa(Array.from(expected, byte => String.fromCharCode(byte)).join("")) });
    expect(asset).toEqual({ url: "blob:byte-fixture", width: 1, height: 1, bytes: length });
    expect(captured?.type).toBe("image/png");
    expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(expected);
  });

  it("rejects empty/malformed content before creating an object URL", () => {
    const create = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create });
    for (const contentBase64 of ["", "not base64!"]) {
      expect(() => createImageAsset({ mime: "image/png", width: 1, height: 1, contentBase64 })).toThrow();
    }
    expect(create).not.toHaveBeenCalled();
  });
});
