/** iOS owns DOM text edits; xterm owns non-edit keys and paste.
 * xterm 5.5 CompositionHelper has TWO deferred textarea readers (compositionend
 * and keyCode 229), in addition to Terminal._inputEvent. Capture at the parent
 * prevents all three from observing edits owned here. Do not install mid-IME.
 *
 * DOM deltas identify edits, never event.data alone or a time/string dedup
 * window. A witnessed append can use event.data to disambiguate SP/NBSP only.
 * Terminal input is not a document editor: destructive changes require a proven
 * owned suffix and beforeinput selection. DEL assumes normal terminal erase
 * semantics; complex graphemes are deliberately not rewritten.
 */
// These scalars (including dictation punctuation) each need one terminal erase.
// Do not infer erase counts for combining sequences, emoji or other graphemes.
const erasableScalars = /^[\x20-\x7e\p{Unified_Ideograph}\p{P}]*$/u;

// WebKit represents a typed trailing space as NBSP, then changes it back to
// SP when the next character arrives. This is not an edit to terminal history.
const sameSpaceRepresentation = (a: string, b: string) =>
  a === b || a.replace(/\u00a0/g, " ") === b.replace(/\u00a0/g, " ");

type TraceEntry = { type: string; inputType?: string; dataLength: number; valueLength: number;
  equalsObserved: boolean; selection: [number, number]; composing: boolean; emittedLength: number; reason?: string };
const trace: TraceEntry[] = [];
let tracing = false;
export const iosImeDiagnostics = {
  enable() { trace.length = 0; tracing = true; },
  disable() { tracing = false; trace.length = 0; },
  snapshot() { return trace.map(entry => ({ ...entry, selection: [...entry.selection] })); },
};
// Explicitly opt-in, bounded, memory-only. No text, hashes, storage or network.
Object.assign(window, { __agentportIosImeDiagnostics: iosImeDiagnostics });

export function installIosImeRouting(container: HTMLElement, textarea: HTMLTextAreaElement,
  send: (text: string) => void) {
  let composing = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed = textarea.value;
  let ownedStart = observed.length;
  let hardware = false;
  let before: { value: string; start: number; end: number } | undefined;
  let compositionBefore: typeof before;
  const record = (event: Event | undefined, emittedLength = 0, reason?: string) => {
    if (!tracing) return;
    const edit = event as InputEvent | undefined;
    trace.push({ type: event?.type ?? "commit", inputType: edit?.inputType,
      dataLength: typeof edit?.data === "string" ? edit.data.length : 0,
      valueLength: textarea.value.length, equalsObserved: textarea.value === observed,
      selection: [textarea.selectionStart, textarea.selectionEnd], composing, emittedLength, reason });
    if (trace.length > 256) trace.shift();
  };
  const snapshot = () => ({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd });
  const invalidate = () => {
    clearTimeout(timer); pending = false; composing = false;
    observed = textarea.value; ownedStart = observed.length; before = compositionBefore = undefined;
  };
  const reconcile = (event?: Event, previous = before) => {
    const value = textarea.value;
    // A witnessed browser/xterm reset is a new document epoch, not repetition.
    if (previous && previous.value !== observed) {
      observed = previous.value; ownedStart = observed.length;
    }
    const base = observed;
    const atEnd = textarea.selectionStart === value.length && textarea.selectionEnd === value.length;
    let output = "";
    let reason = "unchanged";
    if (value !== base) {
      const witnessedEndInsertion = atEnd && previous?.value === base
        && previous.start === base.length && previous.end === base.length;
      const normalizedPrefix = witnessedEndInsertion && value.length > base.length
        && sameSpaceRepresentation(value.slice(0, base.length), base);
      if (atEnd && (value.startsWith(base) || normalizedPrefix)) {
        output = value.slice(base.length);
        reason = value.startsWith(base) ? "append" : "space-normalized-append";
        const edit = event as InputEvent | undefined;
        // Only choose the input's space representation when its entire data
        // matches the witnessed DOM insertion (apart from SP/NBSP). Preserve
        // intentional NBSP; never echo a full-word or unchanged notification.
        if (witnessedEndInsertion && edit?.inputType === "insertText" && typeof edit.data === "string"
          && output !== edit.data && sameSpaceRepresentation(output, edit.data)) {
          output = edit.data; reason = "space-normalized-append";
        }
      } else if (atEnd && previous?.value === base && previous.start >= ownedStart
        && previous.end === base.length && (value.startsWith(base.slice(0, previous.start))
          || ((event as InputEvent | undefined)?.inputType === "deleteContentBackward"
            && previous.start === previous.end && base.startsWith(value) && value.length >= ownedStart))) {
        // Compare Unicode scalars, not UTF-16 units (never split a surrogate).
        const old = Array.from(base.slice(ownedStart));
        const next = Array.from(value.slice(ownedStart));
        let common = 0;
        while (common < old.length && common < next.length && old[common] === next[common]) common++;
        const removed = old.slice(common).join("");
        // Count logical erases, never UTF-16 units or terminal cell width.
        if (erasableScalars.test(removed)
          && !/^[\p{M}\u200d\ufe0f]/u.test(next.slice(common).join(""))) {
          output = "\x7f".repeat(old.length - common) + next.slice(common).join(""); reason = "suffix-replacement";
        } else reason = "unsupported-grapheme";
      } else reason = "unproven-edit";
      observed = value;
      if (!output) ownedStart = value.length;
    }
    before = undefined;
    record(event, output.length, reason);
    if (output) send(output);
  };
  const finish = () => {
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    reconcile(undefined, compositionBefore);
    compositionBefore = undefined;
  };
  const composition = (event: Event) => {
    if (event.target !== textarea) return;
    event.stopImmediatePropagation();
    if (event.type === "compositionstart") {
      finish(); hardware = false; compositionBefore = snapshot(); composing = true;
    } else if (event.type === "compositionend") {
      composing = false; pending = true;
      // compositionend may precede the native DOM mutation, even by a task.
      // Never commit the preedit merely because a zero-delay timer fired.
      const origin = compositionBefore ?? snapshot();
      compositionBefore = origin;
      const expected = origin.value.slice(0, origin.start) + (event as CompositionEvent).data
        + origin.value.slice(origin.end);
      clearTimeout(timer);
      timer = setTimeout(() => { if (textarea.value === expected) finish(); }, 0);
    }
    record(event);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== textarea) return;
    record(event);
    if (event.keyCode === 229 || event.isComposing) {
      hardware = false; event.stopImmediatePropagation();
    } else if (![16, 17, 18, 20].includes(event.keyCode)) {
      finish();
      if (event.keyCode === 8 && !composing && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        && textarea.value === observed && ownedStart < observed.length
        && textarea.selectionStart === observed.length && textarea.selectionEnd === observed.length
        && erasableScalars.test(observed.slice(ownedStart))) {
        // Real iPhone Doubao retraction: ONE Backspace wraps MANY native
        // deleteContentBackward edits. xterm would send one DEL, cancel the
        // first DOM deletion and invalidate the suffix for all remaining edits.
        // Keep the browser default action; reconcile EACH witnessed DOM edit.
        hardware = false; event.stopImmediatePropagation();
        record(event, 0, "dom-backspace");
        return;
      }
      invalidate(); hardware = true;
    }
  };
  const keypress = (event: Event) => {
    if (event.target !== textarea) return;
    if (composing || (event as KeyboardEvent).keyCode === 229) event.stopImmediatePropagation();
    else { finish(); invalidate(); hardware = true; }
  };
  const keyup = (event: Event) => {
    if (event.target !== textarea) return;
    if ((event as KeyboardEvent).keyCode === 229) event.stopImmediatePropagation();
    if (hardware) { invalidate(); hardware = false; }
  };
  const beforeinput = (event: Event) => {
    if (event.target !== textarea) return;
    before = snapshot(); record(event);
  };
  const input = (event: Event) => {
    if (event.target !== textarea) return;
    event.stopImmediatePropagation(); // Never let Terminal._inputEvent send data.
    record(event, 0, "received");
    if (hardware) { invalidate(); record(event, 0, "hardware-owned"); return; }
    if (composing || (event as InputEvent).isComposing) { record(event); before = undefined; return; }
    if (pending) {
      clearTimeout(timer); pending = false;
      reconcile(event, compositionBefore); compositionBefore = undefined;
    } else reconcile(event);
  };
  const boundary = (event: Event) => {
    if (event.target !== textarea) return;
    finish(); invalidate(); hardware = false; record(event, 0, "boundary");
  };
  const listeners: [string, EventListener][] = [
    ["compositionstart", composition], ["compositionupdate", composition], ["compositionend", composition],
    ["keydown", keydown as EventListener], ["keypress", keypress], ["keyup", keyup],
    ["beforeinput", beforeinput], ["input", input], ["paste", boundary], ["blur", boundary],
  ];
  for (const [type, listener] of listeners) container.addEventListener(type, listener, true);
  // xterm clears its textarea in these target handlers, after our capture fence.
  textarea.addEventListener("blur", invalidate);
  textarea.addEventListener("paste", invalidate);
  const dispose = () => {
    clearTimeout(timer);
    textarea.removeEventListener("blur", invalidate);
    textarea.removeEventListener("paste", invalidate);
    for (const [type, listener] of listeners) container.removeEventListener(type, listener, true);
  };
  return Object.assign(dispose, { invalidate });
}

export function isIosKeyboard() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
