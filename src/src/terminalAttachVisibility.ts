export interface TerminalAttachVisibilityState {
  attaching: boolean;
  attached: boolean;
  replayDone: boolean;
  startupPending: boolean;
}

export function shouldShowTerminalAttachOverlay(
  runtime: TerminalAttachVisibilityState,
  hasWarmPreview: boolean,
): boolean {
  const attachInProgress = runtime.attaching || runtime.attached;
  if (!attachInProgress) return false;
  if (runtime.startupPending) return true;
  return !runtime.replayDone && !hasWarmPreview;
}
