export const SESSION_PANE_DND_MIME = "application/x-agentport-session";

export interface SessionPaneDragPayload {
  sessionId: string;
}

export function writeSessionPaneDragPayload(
  dataTransfer: DataTransfer,
  sessionId: string,
): void {
  dataTransfer.setData(
    SESSION_PANE_DND_MIME,
    JSON.stringify({ sessionId } satisfies SessionPaneDragPayload),
  );
  // Do not add text/plain: TerminalArea already treats plain text as a file or
  // terminal paste candidate. The dedicated type keeps Session moves distinct.
  dataTransfer.effectAllowed = "move";
}

export function hasSessionPaneDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(SESSION_PANE_DND_MIME);
}

export function readSessionPaneDragPayload(
  dataTransfer: DataTransfer,
): SessionPaneDragPayload | null {
  const raw = dataTransfer.getData(SESSION_PANE_DND_MIME);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { sessionId?: unknown }).sessionId === "string" &&
      (value as { sessionId: string }).sessionId.length > 0
    ) {
      return { sessionId: (value as { sessionId: string }).sessionId };
    }
  } catch {
    // Invalid or foreign drag payloads are ignored.
  }
  return null;
}
