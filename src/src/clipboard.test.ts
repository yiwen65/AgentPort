// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboardMocks = vi.hoisted(() => ({
  nativeWriteText: vi.fn(),
  webWriteText: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardMocks.nativeWriteText,
}));

import { copyText } from "./api";

describe("clipboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.nativeWriteText.mockResolvedValue(undefined);
    clipboardMocks.webWriteText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: clipboardMocks.webWriteText },
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
});
