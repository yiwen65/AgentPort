type PiTerminalShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export function piTerminalShortcutSequence(
  event: PiTerminalShortcutEvent,
): string | null {
  if (event.ctrlKey || event.shiftKey || event.metaKey === event.altKey) {
    return null;
  }

  const modifier = event.metaKey ? 9 : 3;
  if (event.code === "KeyG") return `\x1b[103;${modifier}u`;
  if (event.key === "ArrowUp") return `\x1b[1;${modifier}A`;
  if (event.key === "ArrowDown") return `\x1b[1;${modifier}B`;
  return null;
}
