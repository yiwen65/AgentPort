// Leaf registry that breaks the actions <-> deviceSwitch import cycle for
// numeric shortcuts. No imports, so partial action mocks cannot break it.

let handler: ((key: string) => void) | null = null;

export function registerFocusSessionKeyHandler(
  next: ((key: string) => void) | null,
): void {
  handler = next;
}

export function focusSessionKeyViaRegistry(key: string): void {
  handler?.(key);
}
