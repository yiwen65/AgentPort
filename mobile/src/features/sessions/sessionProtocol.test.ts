import { describe, expect, it } from "vitest";
import { decodeBase64Utf8, encodeBase64Utf8, outputBase64Of, sessionIdOf } from "./sessionProtocol";

describe("mobile Session protocol helpers", () => {
  it("round-trips Unicode input without exposing an intermediate UTF-16 encoding", () => {
    const input = "你好, Agent 👋\n";
    expect(decodeBase64Utf8(encodeBase64Utf8(input))).toBe(input);
  });

  it("keeps compatibility aliases at the raw terminal protocol boundary", () => {
    expect(sessionIdOf({ session_id: "ses-1" })).toBe("ses-1");
    expect(outputBase64Of({ data: "cmF3LWJ5dGVz" })).toBe("cmF3LWJ5dGVz");
  });
});
