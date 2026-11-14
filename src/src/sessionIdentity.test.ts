import { describe, expect, it } from "vitest";
import {
  activeSessionKey,
  deviceKeyForContext,
  isLocalSessionKey,
  namespaceSessionKeys,
  parseSessionKey,
  sessionKeyFor,
} from "./sessionIdentity";
import type { DeviceContext } from "./deviceContext";

const remote: DeviceContext = {
  kind: "remote",
  deviceId: "dev_abc",
  deviceName: "PC",
  capabilities: [],
};

describe("sessionIdentity", () => {
  it("keeps local keys byte-identical to plain session ids", () => {
    expect(sessionKeyFor("local", "ses_123")).toBe("ses_123");
    expect(parseSessionKey("ses_123")).toEqual({
      deviceKey: "local",
      sessionId: "ses_123",
    });
    expect(isLocalSessionKey("ses_123")).toBe(true);
  });

  it("namespaces remote keys and parses them back", () => {
    expect(sessionKeyFor("dev_abc", "ses_123")).toBe("dev_abc:ses_123");
    expect(parseSessionKey("dev_abc:ses_123")).toEqual({
      deviceKey: "dev_abc",
      sessionId: "ses_123",
    });
    expect(isLocalSessionKey("dev_abc:ses_123")).toBe(false);
  });

  it("distinguishes equal session ids on different devices", () => {
    const local = sessionKeyFor("local", "ses_same");
    const a = sessionKeyFor("dev_a", "ses_same");
    const b = sessionKeyFor("dev_b", "ses_same");
    expect(new Set([local, a, b]).size).toBe(3);
  });

  it("derives the active key from the active device", () => {
    expect(deviceKeyForContext({ kind: "local" })).toBe("local");
    expect(
      activeSessionKey({ activeDevice: { kind: "local" }, activeSessionId: "ses_1" }),
    ).toBe("ses_1");
    expect(activeSessionKey({ activeDevice: remote, activeSessionId: "ses_1" })).toBe(
      "dev_abc:ses_1",
    );
    expect(activeSessionKey({ activeDevice: remote, activeSessionId: null })).toBeNull();
  });

  it("namespaces persisted layout keys only for remote devices", () => {
    const layout = {
      root: {
        type: "split",
        id: "split_1",
        direction: "right",
        ratio: 0.5,
        first: { type: "leaf", sessionId: "ses_a" },
        second: { type: "leaf", sessionId: "ses_b" },
      },
      focusedSessionId: "ses_a",
    };
    expect(namespaceSessionKeys(layout, "local")).toEqual(layout);
    expect(namespaceSessionKeys(layout, "dev_abc")).toEqual({
      root: {
        type: "split",
        id: "split_1",
        direction: "right",
        ratio: 0.5,
        first: { type: "leaf", sessionId: "dev_abc:ses_a" },
        second: { type: "leaf", sessionId: "dev_abc:ses_b" },
      },
      focusedSessionId: "dev_abc:ses_a",
    });
    // Idempotent for already-namespaced keys.
    expect(
      namespaceSessionKeys({ sessionId: "dev_abc:ses_a" }, "dev_abc"),
    ).toEqual({ sessionId: "dev_abc:ses_a" });
  });
});
