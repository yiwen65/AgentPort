// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboardMocks = vi.hoisted(() => ({
  nativeReadImage: vi.fn(),
  nativeReadText: vi.fn(),
  nativeWriteText: vi.fn(),
  webReadText: vi.fn(),
  webWriteText: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: clipboardMocks.nativeReadImage,
  readText: clipboardMocks.nativeReadText,
  writeText: clipboardMocks.nativeWriteText,
}));

import capabilities from "../../src-tauri/capabilities/default.json";
import { clipboardHasImage, copyText, readClipboardText } from "./api";

describe("clipboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.nativeReadImage.mockRejectedValue(new Error("No image"));
    clipboardMocks.nativeReadText.mockResolvedValue("native text");
    clipboardMocks.nativeWriteText.mockResolvedValue(undefined);
    clipboardMocks.webReadText.mockResolvedValue("web text");
    clipboardMocks.webWriteText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: clipboardMocks.webReadText,
        writeText: clipboardMocks.webWriteText,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes Unicode text through the native Tauri clipboard", async () => {
    const text = '审查 @/Users/w/AD/Apollo/模块，给出“根因”';

    await expect(copyText(text)).resolves.toBe(true);

    expect(clipboardMocks.nativeWriteText).toHaveBeenCalledWith(text);
    expect(clipboardMocks.webWriteText).not.toHaveBeenCalled();
  });

  it("falls back to the web clipboard outside the Tauri runtime", async () => {
    clipboardMocks.nativeWriteText.mockRejectedValueOnce(new Error("Tauri unavailable"));

    await expect(copyText("fallback")).resolves.toBe(true);

    expect(clipboardMocks.webWriteText).toHaveBeenCalledWith("fallback");
  });

  it("reads text natively without opening WebKit's paste permission prompt", async () => {
    await expect(readClipboardText()).resolves.toBe("native text");

    expect(clipboardMocks.nativeReadText).toHaveBeenCalledOnce();
    expect(clipboardMocks.webReadText).not.toHaveBeenCalled();
  });

  it("grants the desktop window native clipboard text-read access", () => {
    expect(capabilities.permissions).toContain(
      "clipboard-manager:allow-read-text",
    );
  });

  it("detects and closes a native clipboard image", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    clipboardMocks.nativeReadImage.mockResolvedValueOnce({ close });

    await expect(clipboardHasImage()).resolves.toBe(true);

    expect(close).toHaveBeenCalledOnce();
  });

  it("reports an unavailable native clipboard image", async () => {
    await expect(clipboardHasImage()).resolves.toBe(false);
  });
});
