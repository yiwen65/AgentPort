import type { TerminalGeometry } from "./types";

export interface TerminalGeometryPromptState {
  visible: boolean;
  revision: number | null;
}

/** Only a mobile-owned, positive geometry produces the desktop recovery prompt. */
export function terminalGeometryPromptState(
  geometry: TerminalGeometry | null | undefined,
  dismissedRevision: number | null,
): TerminalGeometryPromptState {
  const validMobileGeometry =
    geometry?.sourceKind === "mobile" &&
    geometry.cols > 0 &&
    geometry.rows > 0 &&
    Number.isSafeInteger(geometry.revision) &&
    geometry.revision >= 0;
  return {
    visible: Boolean(validMobileGeometry && dismissedRevision !== geometry?.revision),
    revision: validMobileGeometry ? geometry!.revision : null,
  };
}

export function shouldPublishAutomaticDesktopResize(
  geometry: TerminalGeometry | null | undefined,
): boolean {
  return geometry?.sourceKind !== "mobile";
}

function dismissalKey(sessionId: string, runId: string): string {
  return `agentport:phone-geometry-dismissed:v1:${sessionId}:${runId}`;
}

export function readDismissedGeometryRevision(
  sessionId: string,
  geometry: TerminalGeometry | null | undefined,
): number | null {
  if (!geometry) return null;
  try {
    const value = sessionStorage.getItem(dismissalKey(sessionId, geometry.runId));
    if (value === null) return null;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  } catch {
    return null;
  }
}

export function dismissGeometryRevision(
  sessionId: string,
  geometry: TerminalGeometry,
): number {
  try {
    sessionStorage.setItem(
      dismissalKey(sessionId, geometry.runId),
      String(geometry.revision),
    );
  } catch {
    // Private/locked-down webviews can reject storage. Component state still
    // dismisses the current revision for the mounted pane.
  }
  return geometry.revision;
}
