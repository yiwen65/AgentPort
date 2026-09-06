/** Route iOS IME edits through xterm's existing input/composition handlers only.
 * WebKit can deliver keyCode 229 and insertText in different tasks. xterm 5.5
 * reads the textarea too early, then drops insertText due to _keyDownSeen.
 * Do not let that synthetic key start a second (timer-based) text reader.
 */
export function installIosImeRouting(container: HTMLElement, textarea: HTMLTextAreaElement) {
  let composing = false;
  let committing = false;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const keydown = (event: KeyboardEvent) => {
    if (event.target === textarea && event.keyCode === 229) event.stopPropagation();
  };
  const start = () => { composing = true; };
  const end = () => {
    composing = false;
    committing = true;
    clearTimeout(commitTimer);
    // Register after xterm.open(): xterm's compositionend handler queues its
    // final textarea read first. That read includes punctuation in this task.
    commitTimer = setTimeout(() => { committing = false; }, 0);
  };
  const input = (event: Event) => {
    const edit = event as InputEvent;
    if (event.target === textarea && edit.inputType === "insertText"
      && (composing || committing || edit.isComposing)) event.stopPropagation();
  };
  container.addEventListener("keydown", keydown, true);
  container.addEventListener("input", input, true);
  textarea.addEventListener("compositionstart", start);
  textarea.addEventListener("compositionend", end);
  return () => {
    clearTimeout(commitTimer);
    container.removeEventListener("keydown", keydown, true);
    container.removeEventListener("input", input, true);
    textarea.removeEventListener("compositionstart", start);
    textarea.removeEventListener("compositionend", end);
  };
}

export function isIosKeyboard() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
