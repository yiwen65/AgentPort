import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { decodeBase64Bytes, encodeBase64Utf8, outputBase64Of, sessionIdOf } from "./sessionProtocol";

describe("mobile Session protocol helpers", () => {
  it("round-trips Unicode input without exposing an intermediate UTF-16 encoding", () => {
    const input = "你好, Agent 👋\n";
    expect(new TextDecoder().decode(decodeBase64Bytes(encodeBase64Utf8(input)))).toBe(input);
  });

  it("passes split UTF-8 output bytes to xterm without replacement characters", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    try {
      const text = "你好，Agent 👋";
      // Deliberately split every multibyte scalar across transport frames.
      for (const byte of new TextEncoder().encode(text)) {
        await new Promise<void>(resolve => terminal.write(decodeBase64Bytes(btoa(String.fromCharCode(byte))), resolve));
      }
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(text);
    } finally { terminal.dispose(); }
  });

  it("keeps compatibility aliases at the raw terminal protocol boundary", () => {
    expect(sessionIdOf({ session_id: "ses-1" })).toBe("ses-1");
    expect(outputBase64Of({ data: "cmF3LWJ5dGVz" })).toBe("cmF3LWJ5dGVz");
  });
});
