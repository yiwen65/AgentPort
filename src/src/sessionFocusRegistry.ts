// Leaf registry that breaks the actions <-> deviceSwitch import cycle for
// numeric shortcuts. No imports, so partial action mocks cannot break it.

type FocusHandler = (key: string) => void | boolean | Promise<unknown>;

let handler: FocusHandler | null = null;

export function registerFocusSessionKeyHandler(
  next: FocusHandler | null,
): void {
  handler = next;
}

export function focusSessionKeyViaRegistry(key: string): void {
  void handler?.(key);
}

/** Await a device switch before continuing an action that depends on the
 * target device being active (for example, a cross-device pane split). */
export async function focusSessionKeyViaRegistryAsync(
  key: string,
): Promise<boolean> {
  if (!handler) return false;
  try {
    return (await handler(key)) !== false;
  } catch {
    return false;
  }
}
