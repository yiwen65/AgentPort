import type { TimelineEntry } from "./types";

export type TimelineEntryKind = "completed" | "waiting";

/** Only turn completions and approval requests belong in the simplified list. */
export function timelineEntryKind(entry: TimelineEntry): TimelineEntryKind | null {
  if (entry.evidence === "recovery:output-during-gui-closed") return null;
  if (entry.evidence === "hook:AgentPortNotification:failed") return null;
  if (entry.state === "needs_input") return "waiting";
  if (entry.state === "idle") return "completed";
  if (entry.state === "exited") {
    return entry.evidence === "process:exit:0" ? "completed" : null;
  }
  return null;
}

export function visibleTimelineEntries(
  entries: TimelineEntry[],
): Array<{ entry: TimelineEntry; kind: TimelineEntryKind }> {
  return entries.flatMap((entry) => {
    const kind = timelineEntryKind(entry);
    return kind ? [{ entry, kind }] : [];
  });
}
