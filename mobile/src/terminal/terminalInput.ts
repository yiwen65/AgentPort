import type { Terminal } from "@xterm/xterm";

/** xterm 5.5's screenReaderMode skips input-only insertText (iOS soft keys).
 * Keep accessibility enabled, and feed only committed text xterm did not emit.
 * Composition/229 handling stays with xterm, including its deferred commits.
 */
export function installTerminalInput(terminal: Terminal, container: HTMLElement, send: (data: string) => void) {
  const textarea = terminal.textarea;
  let composing = false;
  let pendingCommit = false;
  let keyboardDispatch = false;
  let keyboardEmitted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subscription = terminal.onData(data => {
    if (keyboardDispatch) keyboardEmitted = true;
    send(data);
  });
  if (!textarea) return () => subscription.dispose();
  const key = () => {
    keyboardDispatch = true;
    queueMicrotask(() => { keyboardDispatch = false; });
  };
  const down = () => { keyboardEmitted = false; key(); };
  const up = () => { keyboardEmitted = false; };
  const deferCommit = () => {
    pendingCommit = true;
    clearTimeout(timer);
    // Registered after xterm's handlers, so its deferred textarea read runs first.
    timer = setTimeout(() => { pendingCommit = false; }, 0);
  };
  const imeKey = (event: KeyboardEvent) => { if (event.keyCode === 229) deferCommit(); };
  const start = () => { composing = true; };
  const end = () => { composing = false; deferCommit(); };
  const input = (event: Event) => {
    const value = event as InputEvent;
    if (terminal.options.screenReaderMode && !event.defaultPrevented && !keyboardEmitted
      && !composing && !pendingCommit && !value.isComposing
      && value.inputType === "insertText" && value.data) {
      terminal.input(value.data, true);
    }
    keyboardEmitted = false;
  };
  // Parent capture runs before xterm's textarea capture key handlers.
  container.addEventListener("keydown", down, true);
  container.addEventListener("keypress", key, true);
  container.addEventListener("keyup", up, true);
  textarea.addEventListener("keydown", imeKey);
  textarea.addEventListener("compositionstart", start);
  textarea.addEventListener("compositionend", end);
  textarea.addEventListener("input", input);
  return () => {
    clearTimeout(timer);
    subscription.dispose();
    container.removeEventListener("keydown", down, true);
    container.removeEventListener("keypress", key, true);
    container.removeEventListener("keyup", up, true);
    textarea.removeEventListener("keydown", imeKey);
    textarea.removeEventListener("compositionstart", start);
    textarea.removeEventListener("compositionend", end);
    textarea.removeEventListener("input", input);
  };
}
