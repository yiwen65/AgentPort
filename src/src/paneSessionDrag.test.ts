import { describe, expect, it } from "vitest";
import {
  hasSessionPaneDragPayload,
  readSessionPaneDragPayload,
  SESSION_PANE_DND_MIME,
  writeSessionPaneDragPayload,
} from "./paneSessionDrag";

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
