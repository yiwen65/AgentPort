export type PaneShortcutAction = "split-right" | "split-down" | "toggle-maximize";

export function paneShortcutAction(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  mac: boolean,
): PaneShortcutAction | null {
  const key = event.key.toLowerCase();
  if (mac) {
    if (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      key === "d"
    ) {
      return event.shiftKey ? "split-down" : "split-right";
    }
    if (
      event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key === "Enter"
    ) {
      return "toggle-maximize";
    }
    return null;
  }

  if (
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    if (key === "e") return "split-right";
    if (key === "o") return "split-down";
    if (key === "x") return "toggle-maximize";
  }
  return null;
}
