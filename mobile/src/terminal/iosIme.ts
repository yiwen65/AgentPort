/** Keep xterm 5.5's CompositionHelper as the single composition reader.
 * Its deferred textarea read and Terminal._inputEvent otherwise both commit a
 * trailing insertText. Track the DOM edit, not recently emitted strings: equal
 * text appended by a new utterance must still be sent.
 */
export function installIosImeRouting(container: HTMLElement, textarea: HTMLTextAreaElement,
  send: (text: string) => void) {
  let composing = false;
  let committing = false;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  // Only this suffix is known to have been sent by the current voice/IME edit.
  let committed: { value: string; start: number } | undefined;
  let compositionStart = 0;
  let before: { value: string; start: number; end: number } | undefined;
  const reset = () => { committed = undefined; before = undefined; };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== textarea) return;
    if (event.keyCode === 229) event.stopPropagation();
    else reset(); // Never rewrite terminal input after hardware cursor/navigation keys.
  };
  const start = () => {
    reset();
    composing = true;
    compositionStart = textarea.value.length;
  };
  const end = () => {
    composing = false;
    committing = true;
    clearTimeout(commitTimer);
    // Installed after open(): CompositionHelper's read runs before this snapshot.
    const start = compositionStart;
    commitTimer = setTimeout(() => {
      committing = false;
      if (!composing) committed = { value: textarea.value, start };
    }, 0);
  };
  const beforeinput = () => {
    before = { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
  };
  const input = (event: Event) => {
    if (event.target !== textarea) return;
    const edit = event as InputEvent;
    const previous = before;
    before = undefined;
    const textEdit = ["insertText", "insertReplacementText", "insertFromDictation", "insertFromComposition"].includes(edit.inputType);
    if (!textEdit) return;
    if (composing || committing || edit.isComposing) {
      event.stopPropagation();
      return;
    }
    // A late notification of the already-read DOM commit is not a second edit.
    // A new composition clears this checkpoint, and appending identical words
    // changes the value, so neither is text-deduplicated.
    if (committed && textarea.value === committed.value) {
      event.stopPropagation();
      return;
    }
    const replacesCommittedTail = edit.inputType === "insertText" && committed
      && previous?.value === committed.value && previous.start < previous.end;
    if (edit.inputType === "insertReplacementText" || edit.inputType === "insertFromDictation"
      || replacesCommittedTail) {
      event.stopPropagation(); // xterm 5.5 ignores these input types altogether.
      const value = textarea.value;
      if (committed && previous?.value === committed.value
        && previous.start >= committed.start && previous.end === committed.value.length
        && value.startsWith(previous.value.slice(0, previous.start))
        && textarea.selectionStart === value.length && textarea.selectionEnd === value.length) {
        // Only replace a proven, still-current terminal input suffix. Do not
        // infer replacements from data (which can contain the entire phrase).
        let common = committed.start;
        while (common < value.length && common < committed.value.length
          && value[common] === committed.value[common]) common++;
        // Avoid splitting a surrogate pair at the common-prefix boundary.
        if (common > 0 && /[\uD800-\uDBFF]/.test(value[common - 1])) common--;
        send("\x7f".repeat(Array.from(committed.value.slice(common)).length) + value.slice(common));
        committed = { value, start: committed.start };
      } else if (previous && previous.start === previous.end
        && previous.start === previous.value.length && value.startsWith(previous.value)) {
        const added = value.slice(previous.value.length);
        if (added) send(added);
        committed = { value, start: previous.value.length };
      }
      // No safe edit range: leave unsupported replacement alone rather than
      // erase arbitrary terminal contents or append an entire revised phrase.
      return;
    }
    reset(); // Ordinary insertText remains xterm's hardware/input path.
  };
  container.addEventListener("keydown", keydown, true);
  container.addEventListener("input", input, true);
  textarea.addEventListener("beforeinput", beforeinput);
  textarea.addEventListener("compositionstart", start);
  textarea.addEventListener("compositionend", end);
  textarea.addEventListener("paste", reset);
  textarea.addEventListener("blur", reset);
  return () => {
    clearTimeout(commitTimer);
    container.removeEventListener("keydown", keydown, true);
    container.removeEventListener("input", input, true);
    textarea.removeEventListener("beforeinput", beforeinput);
    textarea.removeEventListener("compositionstart", start);
    textarea.removeEventListener("compositionend", end);
    textarea.removeEventListener("paste", reset);
    textarea.removeEventListener("blur", reset);
  };
}

export function isIosKeyboard() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
