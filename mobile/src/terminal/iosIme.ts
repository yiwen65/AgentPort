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
  let observed = textarea.value;
  let hardware = false;
  let before: { value: string; start: number; end: number } | undefined;
  const reset = () => { committed = undefined; before = undefined; };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== textarea) return;
    if (event.keyCode === 229) event.stopPropagation();
    else { hardware = true; reset(); } // Never rewrite after hardware/navigation keys.
  };
  const start = () => {
    reset();
    hardware = false;
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
  const keypress = () => { hardware = true; reset(); };
  const keyup = () => { hardware = false; observed = textarea.value; };
  const invalidate = () => { reset(); observed = textarea.value; };
  const beforeinput = () => {
    before = { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
  };
  const input = (event: Event) => {
    if (event.target !== textarea) return;
    const edit = event as InputEvent;
    const previous = before;
    const oldValue = observed;
    observed = textarea.value;
    before = undefined;
    const textEdit = ["insertText", "insertReplacementText", "insertFromDictation", "insertFromComposition"].includes(edit.inputType);
    if (!textEdit) { reset(); return; }
    if (hardware) { reset(); return; }
    if (composing || committing || edit.isComposing) {
      event.stopPropagation();
      return;
    }
    // A late notification of the already-read DOM commit is not a second edit.
    // A new composition clears this checkpoint, and appending identical words
    // changes the value, so neither is text-deduplicated.
    if (committed && textarea.value === committed.value
      && (!previous || previous.value === committed.value)) {
      event.stopPropagation();
      return;
    }
    // Own ordinary soft-keyboard DOM edits too: xterm sends event.data, which
    // may describe the entire cumulative phrase rather than the changed suffix.
    if (textEdit) {
      // One owner: xterm sends insertText.data verbatim and ignores the other
      // input types, neither of which models a revised textarea value.
      event.stopPropagation();
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
        // DEL counts are application-dependent for graphemes/wide characters.
        // Only erase printable ASCII, and never split a combining sequence.
        const removed = committed.value.slice(common);
        if (!/^[\x20-\x7e]*$/.test(removed)
          || /^\p{M}/u.test(value.slice(common))) { reset(); return; }
        send("\x7f".repeat(removed.length) + value.slice(common));
        committed = { value, start: committed.start };
      } else {
        // Without beforeinput, only a literal DOM prefix extension is evidence
        // of an append. Never infer a destructive correction from event.data.
        const base = previous?.value ?? committed?.value ?? oldValue;
        const atEnd = textarea.selectionStart === value.length && textarea.selectionEnd === value.length;
        if (atEnd && value.startsWith(base) && value.length > base.length
          && (!previous || (previous.start === previous.end && previous.end === base.length))) {
          send(value.slice(base.length));
          committed = { value, start: committed?.value === base ? committed.start : base.length };
        } else reset();
      }
      // No safe edit range: leave unsupported replacement alone rather than
      // erase arbitrary terminal contents or append an entire revised phrase.
      return;
    }
  };
  container.addEventListener("keydown", keydown, true);
  container.addEventListener("input", input, true);
  textarea.addEventListener("beforeinput", beforeinput);
  textarea.addEventListener("compositionstart", start);
  textarea.addEventListener("compositionend", end);
  container.addEventListener("keypress", keypress, true);
  container.addEventListener("keyup", keyup, true);
  textarea.addEventListener("paste", invalidate);
  textarea.addEventListener("blur", invalidate);
  return () => {
    clearTimeout(commitTimer);
    container.removeEventListener("keydown", keydown, true);
    container.removeEventListener("input", input, true);
    textarea.removeEventListener("beforeinput", beforeinput);
    textarea.removeEventListener("compositionstart", start);
    textarea.removeEventListener("compositionend", end);
    container.removeEventListener("keypress", keypress, true);
    container.removeEventListener("keyup", keyup, true);
    textarea.removeEventListener("paste", invalidate);
    textarea.removeEventListener("blur", invalidate);
  };
}

export function isIosKeyboard() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
