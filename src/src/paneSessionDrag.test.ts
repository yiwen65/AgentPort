// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasSessionPaneDragPayload,
  readSessionPaneDragPayload,
  SESSION_PANE_DND_MIME,
  suppressOversizedDragImage,
  writeSessionPaneDragPayload,
} from "./paneSessionDrag";
import { setState } from "./store";
import type { PlatformInfo } from "./types";

function transfer() {
  const values = new Map<string, string>();
  return {
    values,
    dataTransfer: {
      effectAllowed: "uninitialized",
      get types() {
        return [...values.keys()];
      },
      setData(type: string, value: string) {
        values.set(type, value);
      },
      getData(type: string) {
        return values.get(type) ?? "";
      },
    } as unknown as DataTransfer,
  };
}

describe("Session pane drag payload", () => {
  it("uses only the dedicated MIME and round-trips the Session id", () => {
    const { values, dataTransfer } = transfer();
    writeSessionPaneDragPayload(dataTransfer, "ses_1");

    expect(values.has(SESSION_PANE_DND_MIME)).toBe(true);
    expect(values.has("text/plain")).toBe(false);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(hasSessionPaneDragPayload(dataTransfer)).toBe(true);
    expect(readSessionPaneDragPayload(dataTransfer)).toEqual({ sessionId: "ses_1" });
  });

  it("rejects missing, malformed, and empty payloads", () => {
    const { values, dataTransfer } = transfer();
    expect(hasSessionPaneDragPayload(dataTransfer)).toBe(false);
    expect(readSessionPaneDragPayload(dataTransfer)).toBeNull();

    values.set(SESSION_PANE_DND_MIME, "not-json");
    expect(readSessionPaneDragPayload(dataTransfer)).toBeNull();
    values.set(SESSION_PANE_DND_MIME, JSON.stringify({ sessionId: "" }));
    expect(readSessionPaneDragPayload(dataTransfer)).toBeNull();
  });
});

describe("suppressOversizedDragImage (WebKitGTK HiDPI ghost workaround)", () => {
  afterEach(() => {
    setState({ platform: null });
  });

  const platform = (os: string): PlatformInfo => ({
    os,
    osVersion: "24.04",
    arch: "x86_64",
    webview: "WebKitGTK",
    appVersion: "0.1.0",
    windowDecorated: false,
  });

  it("swaps the drag image for a transparent 1px element on Linux", () => {
    setState({ platform: platform("linux") });
    const { dataTransfer } = transfer();
    const setDragImage = vi.fn();
    dataTransfer.setDragImage = setDragImage;

    suppressOversizedDragImage(dataTransfer);
    suppressOversizedDragImage(dataTransfer);

    expect(setDragImage).toHaveBeenCalledTimes(2);
    const firstImage = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(firstImage.style.opacity).toBe("0");
    // One shared element is reused across drags (nothing accumulates).
    expect(setDragImage.mock.calls[1][0]).toBe(firstImage);
  });

  it("keeps the native drag image on macOS and unknown platforms", () => {
    for (const info of [platform("macos"), null] as Array<PlatformInfo | null>) {
      setState({ platform: info });
      const { dataTransfer } = transfer();
      const setDragImage = vi.fn();
      dataTransfer.setDragImage = setDragImage;

      suppressOversizedDragImage(dataTransfer);

      expect(setDragImage).not.toHaveBeenCalled();
    }
  });
});
