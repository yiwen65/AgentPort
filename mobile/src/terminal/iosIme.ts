/** iOS owns DOM text edits; xterm owns non-edit keys and paste.
 * xterm 5.5 CompositionHelper has TWO deferred textarea readers (compositionend
 * and keyCode 229), in addition to Terminal._inputEvent. Capture at the parent
 * prevents all three from observing edits owned here. Do not install mid-IME.
 *
 * DOM deltas identify edits, never event.data alone or a time/string dedup
 * window. A witnessed append can use event.data to disambiguate SP/NBSP only.
 * Terminal input is not a document editor: destructive changes require a proven
 * owned suffix and selection evidence. DEL assumes normal terminal erase
 * semantics; complex graphemes are deliberately not rewritten.
 *
 * Some input methods insert text the user never typed (an auto-paired close
 * bracket or smart quote behind the caret). Those ranges are tracked as
 * `ghosts`: never sent, never erased, and never a reason to stop mapping the
 * edits the user keeps typing in front of them.
 */
// These scalars (including dictation punctuation) each need one terminal erase.
// Do not infer erase counts for combining sequences, emoji or other graphemes.
const erasableScalars = /^[\x20-\x7e\u00a0\p{Unified_Ideograph}\p{P}]*$/u;

// What an auto-pairing input method appends for one keystroke: the close of an
// open/close pair (or the closer alone when it arrives as its own edit). Text
// like this is padding the user never typed, which only gets erased from the
// terminal once their own input proves it by landing in front of it.
const pairedClosers: Record<string, string> = {
  "(": ")", "[": "]", "{": "}", "<": ">", "\u0022": "\u0022", "'": "'",
  "\uff08": "\uff09", "\u3010": "\u3011", "\u3014": "\u3015", "\u300c": "\u300d", "\u300e": "\u300f",
  "\u300a": "\u300b", "\u3008": "\u3009", "\u201c": "\u201d", "\u2018": "\u2019",
  "\u00ab": "\u00bb", "\u2039": "\u203a",
};
const paddingClosers = new Set(Object.values(pairedClosers));

/** True for a whole edit that is one keystroke's padding, not typed text. */
function isPaddingRun(run: string) {
  const scalars = Array.from(run);
  if (scalars.length === 1) return paddingClosers.has(scalars[0]);
  return scalars.length === 2 && pairedClosers[scalars[0]] === scalars[1];
}

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
  // Text an input method inserted on its own (auto-paired closer, smart quote).
  // It was never sent, so it is never erased from the terminal and never makes
  // an edit in front of it unprovable. Offsets are into `observed`.
  let ghosts: Array<[number, number]> = [];
  // Padding tail of the last keyed insertion (text the method added for that
  // keystroke). It is only erased from the terminal once the user's own input
  // proves it by landing right in front of it.
  let lastPadding: { start: number; end: number } | undefined;
  let hardware = false;
  let unidentifiedKey = false;
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
    clearTimeout(timer); pending = false; composing = false; unidentifiedKey = false;
    observed = textarea.value; ownedStart = observed.length; ghosts = []; lastPadding = undefined;
    before = compositionBefore = undefined;
  };
  const addGhost = (from: number, length: number) => { if (length > 0) ghosts = [...ghosts, [from, from + length]]; };
  // The last keystroke's padding, when the caret stands right in front of it.
  const paddingBeforeCaret = (caret: number) => lastPadding && caret === lastPadding.start
    ? observed.slice(lastPadding.start, lastPadding.end) : "";
  const inGhost = (index: number) => ghosts.some(([start, end]) => index >= start && index < end);
  // An edit can be mapped onto the terminal only while no sent character sits
  // after the edited region: the terminal is append-only, and everything after
  // that region is either still pending (untyped) or already displayed.
  const hasSentAfter = (value: string, index: number) => {
    for (let cursor = index; cursor < value.length; cursor++) if (!inGhost(cursor)) return true;
    return false;
  };
  // Split the region an edit replaced into the scalars that were sent and the
  // ones the input method inserted, so a DEL is only counted for sent text.
  const sentScalarsIn = (value: string, from: number, length: number) => {
    let sent = "";
    let index = from;
    for (const scalar of Array.from(value.slice(from, from + length))) {
      if (!inGhost(index)) sent += scalar;
      index += scalar.length;
    }
    return sent;
  };
  const moveGhostsForInsertion = (at: number, inserted: number, typed: number) => {
    const next: Array<[number, number]> = [];
    for (const [start, end] of ghosts) {
      if (end <= at) next.push([start, end]);
      else if (start >= at) next.push([start + inserted, end + inserted]);
      else { next.push([start, at]); next.push([at + inserted, end + inserted]); }
    }
    if (typed < inserted) next.push([at + typed, at + inserted]);
    ghosts = next;
  };
  const moveGhostsForDeletion = (from: number, to: number) => {
    const removed = to - from;
    const next: Array<[number, number]> = [];
    for (const [start, end] of ghosts) {
      if (Math.min(end, from) > start) next.push([start, Math.min(end, from)]);
      const tail = Math.max(start, to);
      if (tail < end) next.push([tail - removed, end - removed]);
    }
    ghosts = next;
  };
  // A witnessed insertion of one run at one caret position: either the browser
  // told us where it happened, or (base, value) splits that way exactly once.
  // Repeated text can make the split ambiguous; ambiguity is declined, not
  // guessed. This is the same evidence standard as a witnessed tail append.
  const insertionAt = (base: string, value: string, previous?: { value: string; start: number; end: number }) => {
    const length = value.length - base.length;
    if (length <= 0) return undefined;
    const at = previous?.value === base && previous.start === previous.end ? previous.start : -1;
    const fits = (position: number) => position >= 0 && position <= base.length
      && value.slice(0, position) === base.slice(0, position)
      && value.slice(position + length) === base.slice(position);
    if (at >= 0) return fits(at) ? { at, length } : undefined;
    let found: { at: number; length: number } | undefined;
    for (let position = 0; position <= base.length; position++) {
      if (value.slice(0, position) !== base.slice(0, position)) break;
      if (!fits(position)) continue;
      if (found) return undefined;
      found = { at: position, length };
    }
    return found;
  };
  const reconcile = (event?: Event, previous = before) => {
    const value = textarea.value;
    // A witnessed browser/xterm reset is a new document epoch, not repetition.
    if (previous && previous.value !== observed) {
      observed = previous.value; ownedStart = observed.length; ghosts = [];
    }
    const base = observed;
    const caret = textarea.selectionStart;
    const collapsed = textarea.selectionStart === textarea.selectionEnd;
    const atEnd = collapsed && caret === value.length;
    const edit = event as InputEvent | undefined;
    let output = "";
    let reason = "unchanged";
    let handled = true;
    // The padding marker is consumed by the edit it is checked against.
    const pendingPadding = lastPadding;
    lastPadding = undefined;
    if (value !== base) {
      const witnessedEndInsertion = atEnd && previous?.value === base
        && previous.start === base.length && previous.end === base.length;
      const normalizedPrefix = witnessedEndInsertion && value.length > base.length
        && sameSpaceRepresentation(value.slice(0, base.length), base);
      // One edit at one position. The terminal is append-only, so it can only
      // follow while no sent character sits behind the edited region; text the
      // method inserted by itself sits there as `ghosts` and is never sent.
      const atPoint = collapsed && caret >= ownedStart;
      if (atEnd && (value.startsWith(base) || normalizedPrefix)) {
        output = value.slice(base.length);
        reason = value.startsWith(base) ? "append" : "space-normalized-append";
        // Only choose the input's space representation when its entire data
        // matches the witnessed DOM insertion (apart from SP/NBSP). Preserve
        // intentional NBSP; never echo a full-word or unchanged notification.
        if (witnessedEndInsertion && edit?.inputType === "insertText" && typeof edit.data === "string"
          && output !== edit.data && sameSpaceRepresentation(output, edit.data)) {
          output = edit.data; reason = "space-normalized-append";
        }
        // A keyed insertion that is exactly an auto-paired closer (or the closer
        // alone) carries the method's own padding in its tail. It is sent, but
        // that tail is retracted as soon as the user's input lands in front of
        // it. In a pair the open bracket is the typed half, never the padding.
        if (witnessedEndInsertion && edit?.inputType === "insertText" && isPaddingRun(output)) {
          const head = Array.from(output).length === 2 ? Array.from(output)[0].length : 0;
          lastPadding = { start: base.length + head, end: base.length + output.length };
          reason = "append-maybe-padding";
        }
      } else if (ghosts.length === 0 && atEnd && previous?.value === base
        && previous.start === base.length && previous.end === base.length
        && edit?.inputType === "deleteContentBackward"
        && value.length < base.length && value.length >= ownedStart
        && sameSpaceRepresentation(base.slice(0, value.length), value)) {
        // WebKit also converts retained SP -> NBSP while retracting dictation.
        // Only a witnessed end deletion proves this is representation, not a
        // replacement of earlier text. Erase the removed suffix alone; leave
        // the terminal's retained spaces unchanged and keep tail ownership.
        const removed = base.slice(value.length);
        if (erasableScalars.test(removed)) {
          output = "\x7f".repeat(Array.from(removed).length);
          reason = base.startsWith(value) ? "suffix-replacement" : "space-normalized-delete";
        } else { handled = false; reason = "unsupported-grapheme"; }
      } else if (ghosts.length === 0 && atEnd && previous?.value === base && previous.start >= ownedStart
        && previous.end === base.length && (value.startsWith(base.slice(0, previous.start))
          || (edit?.inputType === "deleteContentBackward"
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
        } else { handled = false; reason = "unsupported-grapheme"; }
      } else {
        const insertion = atPoint ? insertionAt(base, value, previous) : undefined;
        // The tail of the last keyed insertion is proven untyped when the user
        // starts typing right in front of it. Erase what was already sent and
        // keep that tail unsent, so the caret stays usable and the closer stays
        // out of the terminal.
        const untyped = insertion && pendingPadding && insertion.at === pendingPadding.start
          ? base.slice(pendingPadding.start, pendingPadding.end) : "";
        if (insertion && (untyped === "" || erasableScalars.test(untyped))
          && insertion.at <= caret && caret <= insertion.at + insertion.length
          && !hasSentAfter(base, insertion.at + untyped.length)) {
          // Send only the part the caret moved past; the rest was inserted by the
          // method and stays unsent.
          const typed = caret - insertion.at;
          output = "\x7f".repeat(Array.from(untyped).length) + value.slice(insertion.at, caret);
          moveGhostsForInsertion(insertion.at, insertion.length, typed);
          if (untyped) addGhost(insertion.at + insertion.length, untyped.length);
          reason = untyped ? "untyped-tail-retracted"
            : typed === 0 ? "untyped-insert" : typed === insertion.length ? "typed-insert" : "typed-before-untyped";
        } else if (atPoint && previous?.value === base && previous.start === previous.end
          && previous.start > caret && value.length < base.length
          && previous.start - caret === base.length - value.length
          && !hasSentAfter(base, previous.start)
          && value.slice(0, caret) === base.slice(0, caret)
          && value.slice(caret) === base.slice(previous.start)
          && typeof edit?.inputType === "string" && edit.inputType.startsWith("delete")) {
          // Backward deletion in front of untyped text: erase only the scalars
          // that were sent. Removing text the method inserted emits nothing.
          const removed = base.slice(caret, previous.start);
          const sent = sentScalarsIn(base, caret, removed.length);
          if (sent === "" || erasableScalars.test(sent)) {
            output = "\x7f".repeat(Array.from(sent).length);
            reason = sent === "" ? "untyped-delete" : "sent-delete";
            moveGhostsForDeletion(caret, previous.start);
          } else { handled = false; reason = "unsupported-grapheme"; }
        } else { handled = false; reason = "unproven-edit"; }
      }
      observed = value;
      // A declined edit keeps no ownership: never erase from a region we could
      // not map. A handled edit keeps the suffix, including its untyped text.
      if (!handled) { ownedStart = value.length; ghosts = []; }
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
    // Typeless emits keydown(0), a single printable keypress, then the full
    // DOM insertion. Neither key event owns text: allowing keypress through
    // sends only the first character and marks the full input hardware-owned.
    // Fence this key cycle without cancelling the browser's native edit.
    unidentifiedKey = event.keyCode === 0 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (unidentifiedKey || event.keyCode === 229 || event.isComposing) {
      hardware = false; event.stopImmediatePropagation();
    } else if (![16, 17, 18, 20].includes(event.keyCode)) {
      finish();
      // A key that leaves through xterm goes last: first retract the padding of
      // the last keystroke when the caret still stands in front of it, so the
      // closer never reaches the terminal and Backspace sees a proven sent tail.
      const padding = paddingBeforeCaret(textarea.selectionStart);
      if (padding && erasableScalars.test(padding)) {
        send("\x7f".repeat(Array.from(padding).length));
        addGhost(textarea.selectionStart, padding.length);
        lastPadding = undefined;
        record(event, 0, "untyped-tail-retracted");
      }
      if (event.keyCode === 8 && !composing && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        && textarea.value === observed && textarea.selectionStart === textarea.selectionEnd
        && textarea.selectionStart > ownedStart
        && !hasSentAfter(observed, textarea.selectionStart)
        && erasableScalars.test(sentScalarsIn(observed, ownedStart, observed.length - ownedStart))) {
        // Real iPhone Doubao retraction: ONE Backspace wraps MANY native
        // deleteContentBackward edits. xterm would send one DEL, cancel the
        // first DOM deletion and invalidate the suffix for all remaining edits.
        // The same applies in front of untyped text: only sent scalars may be
        // erased, and the caret may sit before text the input method inserted.
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
    if (unidentifiedKey || composing || (event as KeyboardEvent).keyCode === 229) event.stopImmediatePropagation();
    else { finish(); invalidate(); hardware = true; }
  };
  const keyup = (event: Event) => {
    if (event.target !== textarea) return;
    if ((event as KeyboardEvent).keyCode === 229) event.stopImmediatePropagation();
    unidentifiedKey = false;
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
