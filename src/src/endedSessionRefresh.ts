import { refreshProjects } from "./actions";

// Run subscriptions end with their Host. Reconcile only while an ended PTY
// pane is visible; share one bounded read across panes, never restart a Session.
const watchers = new Set<symbol>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
function schedule() {
  if (!watchers.size || timer !== undefined || inFlight) return;
  timer = setTimeout(async () => {
    timer = undefined;
    inFlight = true;
    try { await refreshProjects(); } catch { /* Retry reads, not mutations. */ }
    finally { inFlight = false; schedule(); }
  }, 2000);
}
export function watchEndedSessions(): () => void {
  const token = Symbol();
  watchers.add(token);
  schedule();
  return () => {
    watchers.delete(token);
    if (!watchers.size && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
