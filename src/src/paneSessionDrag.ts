import { getState } from "./store";

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

// WebKitGTK rasterizes the default drag snapshot at the device scale factor,
// so on HiDPI Linux the Session drag ghost balloons (~2x, mis-scaled). wry
// consumes the native drag on Linux anyway — targeting runs through
// sessionNativeDrag's forwarding — so the ghost carries no information.
// Replace it with a 1px transparent image on Linux only.
let transparentDragImage: HTMLElement | null = null;

export function suppressOversizedDragImage(dataTransfer: DataTransfer): void {
  if (getState().platform?.os !== "linux") return;
  if (!transparentDragImage) {
    const element = document.createElement("div");
    element.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(element);
    transparentDragImage = element;
  }
  dataTransfer.setDragImage(transparentDragImage, 0, 0);
}
