import type { SessionEventPayload } from "./types";

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
