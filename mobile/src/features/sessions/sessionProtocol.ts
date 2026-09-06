import type { SessionEventPayload } from "./types";

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Keep PTY bytes intact; xterm owns the incremental UTF-8 decoder across frames. */
export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function sessionIdOf(payload: SessionEventPayload): string | undefined {
  return payload.sessionId ?? payload.session_id;
}

export function outputBase64Of(payload: SessionEventPayload): string | undefined {
  return payload.dataBase64 ?? payload.data;
}

export function sessionBatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
