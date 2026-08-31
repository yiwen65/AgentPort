// xterm.js instance manager. Each attached session owns one persistent
// Terminal; switching sessions only toggles pane visibility (PRD ch.2/3.3).
// All PTY I/O flows through the backend: input is base64 via send_input,
// output arrives on the attach Channel.

import {
  Terminal,
  type ILinkProvider,
  type ILink,
  type IMarker,
} from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Channel } from "@tauri-apps/api/core";
import {
  api,
  b64ToBytes,
  bytesToB64,
  clipboardHasImage,
  copyText,
  errorText,
  readClipboardText,
} from "./api";
import { PiStartupNoticeFilter } from "./piStartupNotice";
import {
  announce,
  findSession,
  getState,
  openContextMenu,
  patchRuntime,
  patchSession,
  setState,
  toast,
  type EffectiveTheme,
  type MenuItem,
} from "./store";
import { stateLabel } from "./format";
import { i18n } from "./i18n";
import { openDocumentTarget, parseDocumentLinkTarget } from "./documents";
import { runtimeMessageEnvelope, runtimeMessageText } from "./runtimeMessages";
import { getTerminalPalette } from "./terminalThemes";
import type {
  ChannelMsg,
  HistoryEvent,
  LogCursorView,
  RuntimeMessageEnvelope,
  TerminalThemeId,
} from "./types";

// Keep a substantial local history window for interactive find/navigation.
// The persisted log remains the source of truth and can be much larger, but
// 4 MiB covers normal agent sessions (including the current 1.5 MiB repro)
// without replaying an entire configured retained-log window every time a pane opens.
const REPLAY_TAIL_BYTES = 4 * 1024 * 1024;
const PI_STARTUP_READY_OSC = 6973;
const PI_STARTUP_READY_PAYLOAD = "startup-ready";
const PI_STARTUP_READY_TIMEOUT_MS = 15_000;
// xterm 5.5 does not implement DEC mode 2026. Hold one application-authored
// synchronized redraw until its reset marker arrives so xterm cannot paint the
// clear/partial rows exposed by PTY and Channel chunk boundaries. xterm 6 uses
// the same one-second safety timeout, but upgrading would remove CanvasAddon.
const SYNCHRONIZED_OUTPUT_BEGIN = Uint8Array.of(
  0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68,
);
const SYNCHRONIZED_OUTPUT_END = Uint8Array.of(
  0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c,
);
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1_000;
const MAX_UNTERMINATED_SYNCHRONIZED_OUTPUT_BYTES = 1024 * 1024;
const MAX_UNTERMINATED_SYNCHRONIZED_OUTPUT_PARTS = 1024;
// A retained TUI tail can contain tens of thousands of complete DEC 2026
// redraws inside the Host's 64 KiB frames. Keep small redraws individually
// observable, but collapse a pathological single-frame burst into one xterm
// write so parser scheduling stays bounded by transport frames.
const MAX_SYNCHRONIZED_WRITES_PER_OUTPUT = 64;
const TERMINAL_SNAPSHOT_VERSION = 2;
const MAX_TERMINAL_SNAPSHOT_CHARS = 2 * 1024 * 1024;
// Snapshot serialization is synchronous on the renderer's main thread. Keep a
// useful local navigation window without serializing the full interactive
// scrollback; older Agent-native history remains available through pagination.
const TERMINAL_SNAPSHOT_SCROLLBACK_LINES = 1000;

/** Keep only the visible xterm instance. Session output is persisted by the
 * Host, so retaining hidden renderers spends memory without protecting data. */
export const MAX_PERSISTENT_TERMINALS = 1;

export type TerminalViewportCommand =
  | { type: "lines"; amount: number }
  | { type: "pages"; amount: number }
  | { type: "top" }
  | { type: "bottom"; focus?: boolean }
  | { type: "line"; line: number };

type TerminalViewportMode = "follow" | "reading" | "locating";

/** Single authority for user and renderer viewport mutations. */
class TerminalViewportController {
  private intentRevision = 0;
  private mode: TerminalViewportMode = "follow";

  constructor(private readonly term: Terminal) {}

  get revision(): number {
    return this.intentRevision;
  }

  get currentMode(): TerminalViewportMode {
    return this.mode;
  }

  noteUserIntent(mode: TerminalViewportMode = "reading"): number {
    this.intentRevision += 1;
    this.mode = mode;
    return this.intentRevision;
  }

  observeViewport() {
    const buffer = this.term.buffer.active;
    this.mode =
      buffer.type !== "normal" || buffer.viewportY >= buffer.baseY
        ? "follow"
        : "reading";
  }

  runUserCommand(command: TerminalViewportCommand) {
    const mode = command.type === "bottom" ? "follow" : "reading";
    this.noteUserIntent(mode);
    switch (command.type) {
      case "lines":
        this.term.scrollLines(command.amount);
        break;
      case "pages":
        this.term.scrollPages(command.amount);
        break;
      case "top":
        this.term.scrollToTop();
        break;
      case "bottom":
        this.term.scrollToBottom();
        if (command.focus) this.term.focus();
        break;
      case "line":
        this.term.scrollToLine(command.line);
        break;
    }
    this.observeViewport();
  }

  restoreReadingLine(line: number, expectedRevision: number) {
    if (this.intentRevision !== expectedRevision) return;
    this.term.scrollToLine(line);
    this.mode = "reading";
  }

  restorePrependedAnchor(line: number, expectedRevision: number) {
    if (this.intentRevision !== expectedRevision) return;
    const buffer = this.term.buffer.active;
    const target = Math.max(0, Math.min(line, buffer.baseY));
    this.term.scrollToLine(target);
    const viewport =
      this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport && buffer.baseY > 0) {
      const maxScrollTop = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight,
      );
      viewport.scrollTop = (target / buffer.baseY) * maxScrollTop;
    }
    this.mode = target >= buffer.baseY ? "follow" : "reading";
  }

  restoreTail(expectedRevision: number) {
    if (this.intentRevision !== expectedRevision) return;
    this.synchronizeTail();
  }

  restoreAfterFit(line: number) {
    this.term.scrollToLine(line);
    this.mode = "reading";
  }

  synchronizeTail() {
    this.term.scrollToBottom();
    // xterm can report buffer tail while this native viewport remains at 0.
    // Keep the private DOM workaround isolated inside the viewport authority.
    const viewport =
      this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.scrollTop = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight,
      );
    }
    this.mode = "follow";
  }

  beginLocate(): number {
    return this.noteUserIntent("locating");
  }

  revealLine(line: number, expectedRevision: number) {
    if (this.intentRevision !== expectedRevision) return;
    this.term.scrollToLine(line);
    this.mode = "locating";
  }
}

type TerminalDrainTask =
  | "tail-repair"
  | "replay-complete"
  | "startup-ready"
  | "render-observation"
  | "snapshot"
  | "release-snapshot"
  | "recovery-reveal"
  | "native-history-rebuild";

interface PendingTerminalDrain {
  id: number;
  task: TerminalDrainTask;
  handle: TermHandle;
  generation: number;
  targetSequence: number;
  callback: (targetSequence: number, promoted: boolean) => void;
  onDiscard?: () => void;
  coalesce: boolean;
  promoted: boolean;
  completed: boolean;
}

interface DeferredTerminalWrite {
  kind: "write";
  data: Uint8Array | string;
  callback?: () => void;
}

interface DeferredTerminalDrain {
  kind: "drain";
  pending: PendingTerminalDrain;
}

type DeferredTerminalAction = DeferredTerminalWrite | DeferredTerminalDrain;

type SynchronizedOutputCandidateItem =
  | { kind: "output"; data: Uint8Array }
  | DeferredTerminalAction;

interface SynchronizedOutputCandidate {
  kind: "candidate";
  bytes: Uint8Array;
  items: SynchronizedOutputCandidateItem[];
}

interface SynchronizedOutputFrame {
  kind: "frame";
  chunks: Uint8Array[];
  byteLength: number;
  endMatchLength: number;
  actions: DeferredTerminalAction[];
}

type DeferredSynchronizedOutput =
  | SynchronizedOutputCandidate
  | SynchronizedOutputFrame;

function findByteSequence(data: Uint8Array, sequence: Uint8Array): number {
  if (sequence.length === 0 || data.length < sequence.length) return -1;
  const lastStart = data.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (data[start] !== sequence[0]) continue;
    let index = 1;
    while (index < sequence.length && data[start + index] === sequence[index]) {
      index += 1;
    }
    if (index === sequence.length) return start;
  }
  return -1;
}

function trailingSequencePrefixLength(
  data: Uint8Array,
  sequence: Uint8Array,
): number {
  const maxLength = Math.min(data.length, sequence.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const start = data.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (data[start + index] !== sequence[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function concatByteChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === byteLength) {
    return chunks[0];
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Owns xterm write ordering and parser-boundary callbacks for one Session.
 * A named drain is coalesced while pending and is automatically fenced when
 * the handle or attach generation changes. DEC 2026 frames are also joined at
 * this boundary: xterm 5.5 must receive a complete synchronized redraw in one
 * write, and no parser drain may overtake bytes held for that redraw.
 */
class TerminalWriteCoordinator {
  private writeSequence = 0;
  private nextDrainId = 0;
  private readonly pendingDrains = new Map<
    TerminalDrainTask,
    PendingTerminalDrain
  >();
  private readonly allDrains = new Set<PendingTerminalDrain>();
  private deferredOutput: DeferredSynchronizedOutput | null = null;
  private deferredOutputTimer: number | null = null;
  private deferredOutputEpoch = 0;
  private outputBatch: Uint8Array[] | null = null;
  private outputBatchBytes = 0;
  private flushingOutputBatch = false;
  private processingOutput = false;

  constructor(
    private readonly term: Terminal,
    private readonly currentHandle: () => TermHandle | null,
    private readonly outputSink: (data: Uint8Array) => void,
    private readonly onMutation: () => void,
  ) {}

  write(data: Uint8Array | string, callback?: () => void): number {
    const sequence = ++this.writeSequence;
    if (typeof data === "string" ? data.length > 0 : data.byteLength > 0) {
      this.onMutation();
    }
    if (this.deferredOutput && !this.flushingOutputBatch) {
      this.deferAction({ kind: "write", data, callback });
    } else {
      this.term.write(data, callback);
    }
    return sequence;
  }

  /** Feed raw PTY bytes while preserving DEC 2026 markers byte-for-byte. */
  writeOutput(data: Uint8Array) {
    // Channel delivery is synchronous, so one call owns this batch. Output
    // separated by a deferred parser action is flushed before that action.
    this.outputBatch = [];
    this.outputBatchBytes = 0;
    this.processingOutput = true;
    try {
      this.processOutput(data);
    } finally {
      try {
        this.flushOutputBatch();
      } finally {
        this.outputBatch = null;
        this.outputBatchBytes = 0;
        this.processingOutput = false;
        if (this.deferredOutput) this.armDeferredOutputTimeout();
      }
    }
  }

  private processOutput(data: Uint8Array) {
    let remaining = data;
    while (remaining.length > 0) {
      const deferred = this.deferredOutput;
      if (deferred?.kind === "candidate") {
        const needed = SYNCHRONIZED_OUTPUT_BEGIN.length - deferred.bytes.length;
        const compared = Math.min(needed, remaining.length);
        let matches = true;
        for (let index = 0; index < compared; index += 1) {
          if (
            remaining[index] !==
            SYNCHRONIZED_OUTPUT_BEGIN[deferred.bytes.length + index]
          ) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          this.releaseCandidate();
          continue;
        }
        if (remaining.length < needed) {
          const fragment = remaining.slice();
          const bytes = new Uint8Array(deferred.bytes.length + fragment.length);
          bytes.set(deferred.bytes);
          bytes.set(fragment, deferred.bytes.length);
          deferred.bytes = bytes;
          deferred.items.push({ kind: "output", data: fragment });
          this.enforceDeferredOutputBounds();
          return;
        }

        const markerSuffix = remaining.subarray(0, needed);
        const chunks = deferred.items
          .filter(
            (item): item is Extract<
              SynchronizedOutputCandidateItem,
              { kind: "output" }
            > => item.kind === "output",
          )
          .map((item) => item.data);
        chunks.push(markerSuffix);
        const actions = deferred.items.filter(
          (item): item is DeferredTerminalAction => item.kind !== "output",
        );
        for (const action of actions) {
          if (action.kind === "drain") action.pending.promoted = true;
        }
        this.deferredOutput = {
          kind: "frame",
          chunks,
          byteLength: SYNCHRONIZED_OUTPUT_BEGIN.length,
          endMatchLength: 0,
          actions,
        };
        // A possible marker has its own bounded wait. Once DECSET is fully
        // recognized, give the application frame the complete safety window.
        this.clearDeferredOutputTimeout();
        this.armDeferredOutputTimeout();
        remaining = remaining.subarray(needed);
        continue;
      }

      if (deferred?.kind === "frame") {
        const suffix = this.appendSynchronizedOutput(remaining);
        if (suffix === null) return;
        remaining = suffix;
        continue;
      }

      const begin = findByteSequence(remaining, SYNCHRONIZED_OUTPUT_BEGIN);
      if (begin >= 0) {
        if (begin > 0) this.emitOutput(remaining.subarray(0, begin));
        this.deferredOutput = {
          kind: "frame",
          chunks: [
            remaining.subarray(
              begin,
              begin + SYNCHRONIZED_OUTPUT_BEGIN.length,
            ),
          ],
          byteLength: SYNCHRONIZED_OUTPUT_BEGIN.length,
          endMatchLength: 0,
          actions: [],
        };
        this.armDeferredOutputTimeout();
        remaining = remaining.subarray(
          begin + SYNCHRONIZED_OUTPUT_BEGIN.length,
        );
        continue;
      }

      const candidateLength = trailingSequencePrefixLength(
        remaining,
        SYNCHRONIZED_OUTPUT_BEGIN,
      );
      const immediateLength = remaining.length - candidateLength;
      if (immediateLength > 0) {
        this.emitOutput(remaining.subarray(0, immediateLength));
      }
      if (candidateLength > 0) {
        const candidate = remaining.slice(immediateLength);
        this.deferredOutput = {
          kind: "candidate",
          bytes: candidate,
          items: [{ kind: "output", data: candidate }],
        };
        this.armDeferredOutputTimeout();
      }
      return;
    }
  }

  private appendSynchronizedOutput(data: Uint8Array): Uint8Array | null {
    const frame = this.deferredOutput;
    if (frame?.kind !== "frame") return data;
    let matchLength = frame.endMatchLength;
    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index];
      if (byte === SYNCHRONIZED_OUTPUT_END[matchLength]) {
        matchLength += 1;
      } else {
        matchLength = byte === SYNCHRONIZED_OUTPUT_END[0] ? 1 : 0;
      }
      if (matchLength === SYNCHRONIZED_OUTPUT_END.length) {
        this.appendFrameChunk(frame, data.subarray(0, index + 1));
        const suffix = data.subarray(index + 1);
        this.releaseFrame();
        return suffix;
      }
    }
    frame.endMatchLength = matchLength;
    this.appendFrameChunk(frame, data);
    this.enforceDeferredOutputBounds();
    return null;
  }

  private appendFrameChunk(frame: SynchronizedOutputFrame, data: Uint8Array) {
    if (data.length === 0) return;
    frame.chunks.push(data);
    frame.byteLength += data.byteLength;
  }

  private deferAction(action: DeferredTerminalAction) {
    const deferred = this.deferredOutput;
    if (!deferred) {
      this.runDeferredAction(action);
      return;
    }
    if (deferred.kind === "candidate") {
      deferred.items.push(action);
    } else {
      if (action.kind === "drain") action.pending.promoted = true;
      deferred.actions.push(action);
    }
    this.enforceDeferredOutputBounds();
  }

  private emitOutput(data: Uint8Array) {
    if (data.length === 0) return;
    this.onMutation();
    if (this.outputBatch === null) {
      this.outputSink(data);
      return;
    }
    this.outputBatch.push(data);
    this.outputBatchBytes += data.byteLength;
  }

  private emitOutputChunks(chunks: Uint8Array[], byteLength: number) {
    const batch = this.outputBatch;
    if (batch && batch.length >= MAX_SYNCHRONIZED_WRITES_PER_OUTPUT) {
      // This frame necessarily crosses the collapse threshold. Keep its
      // existing views and copy them only once when the Host frame flushes,
      // instead of allocating and copying one buffer per TUI redraw first.
      for (const chunk of chunks) batch.push(chunk);
      this.outputBatchBytes += byteLength;
      return;
    }
    this.emitOutput(concatByteChunks(chunks, byteLength));
  }

  private flushOutputBatch() {
    const batch = this.outputBatch;
    if (!batch?.length) return;
    const previousFlush = this.flushingOutputBatch;
    this.flushingOutputBatch = true;
    try {
      if (batch.length > MAX_SYNCHRONIZED_WRITES_PER_OUTPUT) {
        this.outputSink(concatByteChunks(batch, this.outputBatchBytes));
      } else {
        for (const chunk of batch) this.outputSink(chunk);
      }
    } finally {
      this.flushingOutputBatch = previousFlush;
      batch.length = 0;
      this.outputBatchBytes = 0;
    }
  }

  private runDeferredAction(action: DeferredTerminalAction) {
    // A parser drain/local write queued between PTY chunks must not overtake
    // output that this call has only batched locally.
    this.flushOutputBatch();
    if (action.kind === "write") {
      this.term.write(action.data, action.callback);
    } else {
      this.scheduleDrain(action.pending);
    }
  }

  private releaseCandidate() {
    const candidate = this.deferredOutput;
    if (candidate?.kind !== "candidate") return;
    this.deferredOutput = null;
    this.clearDeferredOutputTimeout();
    for (const item of candidate.items) {
      if (item.kind === "output") this.emitOutput(item.data);
      else this.runDeferredAction(item);
    }
  }

  private releaseFrame() {
    const frame = this.deferredOutput;
    if (frame?.kind !== "frame") return;
    this.deferredOutput = null;
    this.clearDeferredOutputTimeout();
    this.emitOutputChunks(frame.chunks, frame.byteLength);
    for (const action of frame.actions) this.runDeferredAction(action);
  }

  private armDeferredOutputTimeout() {
    // A timer cannot fire until this synchronous Channel delivery returns.
    // Arm only for the candidate/frame that remains open at that boundary.
    if (this.processingOutput || this.deferredOutputTimer !== null) return;
    const handle = this.currentHandle();
    if (!handle) return;
    const generation = handle.generation;
    const epoch = ++this.deferredOutputEpoch;
    this.deferredOutputTimer = window.setTimeout(() => {
      if (epoch !== this.deferredOutputEpoch) return;
      this.deferredOutputTimer = null;
      const current = this.currentHandle();
      if (current !== handle || current.generation !== generation) {
        this.discardDeferredOutput();
        return;
      }
      if (this.deferredOutput?.kind === "candidate") this.releaseCandidate();
      else this.releaseFrame();
    }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
  }

  private clearDeferredOutputTimeout() {
    this.deferredOutputEpoch += 1;
    if (this.deferredOutputTimer === null) return;
    window.clearTimeout(this.deferredOutputTimer);
    this.deferredOutputTimer = null;
  }

  private enforceDeferredOutputBounds() {
    const deferred = this.deferredOutput;
    if (!deferred) return;
    const byteLength =
      deferred.kind === "candidate" ? deferred.bytes.length : deferred.byteLength;
    const partCount =
      deferred.kind === "candidate"
        ? deferred.items.length
        : deferred.chunks.length + deferred.actions.length;
    if (
      byteLength <= MAX_UNTERMINATED_SYNCHRONIZED_OUTPUT_BYTES &&
      partCount <= MAX_UNTERMINATED_SYNCHRONIZED_OUTPUT_PARTS
    ) {
      return;
    }
    if (deferred.kind === "candidate") this.releaseCandidate();
    else this.releaseFrame();
  }

  private discardDeferredOutput() {
    this.deferredOutput = null;
    this.clearDeferredOutputTimeout();
  }

  hasPendingDrain(task: TerminalDrainTask): boolean {
    return this.pendingDrains.has(task);
  }

  drain(
    task: TerminalDrainTask,
    callback: (targetSequence: number, promoted: boolean) => void,
    options: { coalesce?: boolean; onDiscard?: () => void } = {},
  ): boolean {
    const handle = this.currentHandle();
    if (!handle) return false;
    const coalesce = options.coalesce !== false;
    if (coalesce && this.pendingDrains.has(task)) return false;

    const pending: PendingTerminalDrain = {
      id: ++this.nextDrainId,
      task,
      handle,
      generation: handle.generation,
      targetSequence: this.writeSequence,
      callback,
      onDiscard: options.onDiscard,
      coalesce,
      promoted: false,
      completed: false,
    };
    if (coalesce) this.pendingDrains.set(task, pending);
    this.allDrains.add(pending);
    if (this.deferredOutput) {
      this.deferAction({ kind: "drain", pending });
    } else {
      this.scheduleDrain(pending);
    }
    return true;
  }

  private scheduleDrain(pending: PendingTerminalDrain) {
    if (pending.completed) return;
    this.term.write("", () => this.completeDrain(pending));
  }

  private completeDrain(pending: PendingTerminalDrain) {
    if (pending.completed) return;
    if (
      pending.coalesce &&
      this.pendingDrains.get(pending.task)?.id !== pending.id
    ) {
      this.discardDrain(pending);
      return;
    }
    const current = this.currentHandle();
    if (
      current !== pending.handle ||
      current.generation !== pending.generation
    ) {
      this.discardDrain(pending);
      return;
    }
    pending.completed = true;
    this.allDrains.delete(pending);
    if (pending.coalesce) this.pendingDrains.delete(pending.task);
    pending.callback(pending.targetSequence, pending.promoted);
  }

  private discardDrain(pending: PendingTerminalDrain) {
    if (pending.completed) return;
    pending.completed = true;
    this.allDrains.delete(pending);
    if (this.pendingDrains.get(pending.task)?.id === pending.id) {
      this.pendingDrains.delete(pending.task);
    }
    pending.onDiscard?.();
  }

  /** Materialize bytes already accepted from the Channel before a renderer
   * release. The durable cursor already covers these bytes, so discarding an
   * open synchronized-output frame would create a snapshot/cursor gap. */
  flushPendingOutput() {
    if (this.deferredOutput?.kind === "candidate") this.releaseCandidate();
    else this.releaseFrame();
  }

  reset() {
    this.discardDeferredOutput();
    for (const pending of [...this.allDrains]) this.discardDrain(pending);
    this.pendingDrains.clear();
  }
}

export interface TermHandle {
  sessionId: string;
  term: Terminal;
  writes: TerminalWriteCoordinator;
  viewport: TerminalViewportController;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  /** Mouse report encoding is not exposed by Terminal.modes and xterm's
   * SerializeAddon omits it, so preserve it explicitly with crash snapshots. */
  mouseEncoding: TerminalMouseEncoding;
  opened: boolean;
  attached: boolean;
  attaching: boolean;
  /** Bumped per attach — stale channels from previous attaches are ignored. */
  generation: number;
  /** Backend-issued capability; only this renderer may detach it. */
  attachmentId: number | null;
  /** A checkpoint or completed replay has drained through xterm and can be
   * shown immediately while a warm background attach catches up. */
  displayReady: boolean;
  /** Parser-ready content is waiting for xterm's next actual render event. */
  displayRenderPending: boolean;
  /** Monotonic screen-mutation fence for matching a cached snapshot to the
   * exact xterm state, including cursorless transient and local writes. */
  terminalSnapshotRevision: number;
  persistedTerminalSnapshotRevision: number;
  /** Log tail already rendered (ended sessions' read-only history). */
  historyLoaded: boolean;
  historyLoading: boolean;
  /** Agent-native history is a prefix of this same xterm buffer. `undefined`
   * means not requested yet; `null` means the oldest source line was reached. */
  nativeHistoryCursor: string | null | undefined;
  nativeHistoryEvents: HistoryEvent[];
  nativeHistorySkippedLines: number;
  nativeHistoryRequest: Promise<boolean> | null;
  nativeHistoryBoundaryMarker: IMarker | null;
  nativeHistoryTailSnapshot: string | null;
  /** Whether output/reflow changed the terminal tail since its last snapshot. */
  nativeHistoryTailDirty: boolean;
  /** Last contiguous byte rendered for the current Host output stream. */
  logCursor: LogCursorView | null;
  /** The retained-log boundary is useful once, but routine later rotations in
   * the same live run must not become terminal output themselves. */
  rotationNoticeShown: boolean;
  /** Cursor awaiting an xterm write-queue callback before it can be reported
   * as renderer-observed to the backend. */
  pendingRenderedLogCursor: LogCursorView | null;
  /** Output pressure observed between enqueue and xterm parser callbacks. */
  pendingOutputBytes: number;
  peakPendingOutputBytes: number;
  lastOutputParseLatencyMs: number;
  /** A recovery click loaded a bounded historical window, so the next live
   * frame may legitimately begin at the Host's newer high-water offset. */
  allowRecoveryGap: boolean;
  /** Marker inserted once the bounded replay crosses the selected event. */
  recoveryTarget: LogCursorView | null;
  container: HTMLDivElement | null;
  resizeObserver: ResizeObserver | null;
  active: boolean;
  geometryDirty: boolean;
  fitCount: number;
  lastFitReason: string | null;
  lastFitDurationMs: number;
  lastCols: number;
  lastRows: number;
  lastScrolledUp: boolean;
  /** First user input for one-shot generated Session title replacement. */
  firstInputBuffer: string;
  firstInputSubmitted: boolean;
  /** ANSI input parser state. Terminal replies (notably OSC color replies)
   * travel through xterm's onData alongside real keyboard input. */
  inputEscapeState:
    | "none"
    | "esc"
    | "csi"
    | "osc"
    | "oscEsc"
    | "string"
    | "stringEsc";
  startupReadyTimer: number | null;
  piStartupNoticeFilter: PiStartupNoticeFilter | null;
}

const handles = new Map<string, TermHandle>();
const unreadOutputPending = new Set<string>();

type TerminalMouseEncoding = "default" | "sgr" | "sgr-pixels";

function mouseEncodingSequence(encoding: TerminalMouseEncoding): string {
  switch (encoding) {
    case "sgr":
      return "\x1b[?1006h";
    case "sgr-pixels":
      return "\x1b[?1016h";
    default:
      return "";
  }
}

const SERIALIZED_MOUSE_TRACKING_SUFFIX =
  /\x1b\[\?(?:9|1000|1002|1003)h$/;

/** Restore the two independent parts of Pi's mouse protocol. SerializeAddon
 * writes an active tracking mode as its final mode sequence, so preserve that
 * choice; cold attaches and snapshots captured from the broken fallback need
 * the button-motion mode that Pi enables in every fullscreen environment. */
function fullscreenPiMouseProtocolSuffix(
  serializedContent: string,
  encoding: TerminalMouseEncoding,
): string {
  const tracking = SERIALIZED_MOUSE_TRACKING_SUFFIX.test(serializedContent)
    ? ""
    : "\x1b[?1002h";
  return tracking + mouseEncodingSequence(encoding);
}

/** Track the mouse encoding modes that SerializeAddon does not serialize.
 * Returning false lets xterm's built-in DECSET/DECRST/RIS handlers continue
 * to own the actual terminal state. */
function installMouseEncodingTracking(handle: TermHandle) {
  handle.term.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) => {
      for (const param of params) {
        if (param === 1006) handle.mouseEncoding = "sgr";
        else if (param === 1016) handle.mouseEncoding = "sgr-pixels";
      }
      return false;
    },
  );
  handle.term.parser.registerCsiHandler(
    { prefix: "?", final: "l" },
    (params) => {
      for (const param of params) {
        if (param === 1006 || param === 1016) {
          handle.mouseEncoding = "default";
        }
      }
      return false;
    },
  );
  handle.term.parser.registerEscHandler({ final: "c" }, () => {
    handle.mouseEncoding = "default";
    return false;
  });
}

function resetTerminal(handle: TermHandle) {
  handle.mouseEncoding = "default";
  handle.terminalSnapshotRevision += 1;
  handle.term.reset();
}

/** Clear stale replay content without dropping a live application's alternate
 * buffer and terminal modes. A bounded tail does not necessarily contain the
 * original DECSET sequence that entered fullscreen mode. */
function clearTerminalForTailReplay(handle: TermHandle) {
  handle.displayReady = false;
  handle.displayRenderPending = false;
  if (handle.term.buffer.active.type === "alternate") {
    handle.writes.write("\x1b[2J\x1b[H");
    return;
  }
  resetTerminal(handle);
}

/**
 * Routes a clicked terminal link. Local documents (file:// OSC 8 links and
 * plain absolute or session-relative paths) open in the in-app viewer; only
 * absolute http(s) URLs are handed to the OS, through the native validation
 * command. Every
 * other scheme stays inside the app and is simply rejected — terminal output
 * is untrusted, so schemes like `vscode:` or `smb:` never reach the OS.
 */
function openTerminalLink(url: string, sessionCwd?: string) {
  const documentTarget = parseDocumentLinkTarget(url, sessionCwd);
  if (documentTarget) {
    openDocumentTarget(documentTarget);
    return;
  }
  if (/^https?:\/\//i.test(url)) {
    void api.openExternalUrl(url).catch((error) => {
      toast(
        i18n.t("shell:ui.sidebar.openFailed", { detail: errorText(error) }),
        "error",
      );
    });
    return;
  }
  toast(i18n.t("shell:ui.sidebar.openFailed", { detail: url }), "error");
}

/**
 * Matches absolute and relative POSIX paths printed as plain text, e.g.
 * `/Users/w/project/docs/report.md:12` or `src/components/App.tsx`. Relative
 * paths are resolved against the Session cwd when activated. Paths may contain
 * spaces when the whole candidate is quoted; unquoted matches stop at whitespace. A trailing
 * `:line[:column]` suffix is included so the viewer can reveal the line.
 *
 * Sentence punctuation (`,` `;` `!` `?` and CJK punctuation like `，。：`) is
 * excluded so prose following a path — `已生成文档 /a/b.md，包含…` — never
 * becomes part of the link. These characters are vanishingly rare in real
 * file names, while prose punctuation right after a path is the common case.
 */
const LOCAL_PATH_CANDIDATE =
  /(?:^|[\s"'`([{<])((?:(?:\.{1,2}\/)|\/|(?:[^\s"'`()[\]{}<>\\,;:!?，。；：、！？【】《》「」『』/]+\/))(?:[^\s"'`()[\]{}<>\\,;!?，。；：、！？【】《》「」『』]|\\ )+(?::\d+(?::\d+)?)?)/g;
/** Scheme immediately before a `/…` match means the text is a URL, not a
 * local path (the WebLinksAddon already owns those links). Covers both
 * `https://|path` and `https:|//path` match alignments. */
const URL_SCHEME_BEFORE_PATH = /[a-zA-Z][a-zA-Z0-9+.-]*:\/?\/?$/;

function localFileLinkProvider(term: Terminal, sessionId: string): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active
        .getLine(bufferLineNumber - 1)
        ?.translateToString(true);
      if (!line || !line.includes("/")) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const match of line.matchAll(LOCAL_PATH_CANDIDATE)) {
        const text = match[1];
        const startIndex = match.index + match[0].indexOf(text);
        if (URL_SCHEME_BEFORE_PATH.test(line.slice(0, startIndex))) continue;
        // Protocol-relative URLs (`//host/path`) are not local paths.
        if (text.startsWith("//")) continue;
        // Require at least one interior slash so `/` alone never links.
        if (text.indexOf("/", 1) === -1) continue;
        const range = {
          start: { x: startIndex + 1, y: bufferLineNumber },
          end: { x: startIndex + text.length, y: bufferLineNumber },
        };
        links.push({
          range,
          text,
          activate: (_event, linkText) => {
            const cwd = findSession(getState().projects, sessionId)?.cwd;
            openTerminalLink(linkText, cwd);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

function resetRenderObservation(handle: TermHandle) {
  handle.pendingRenderedLogCursor = null;
  handle.writes.reset();
}

/**
 * Captures the first non-empty command line without interfering with PTY I/O.
 * xterm provides input in chunks, so this handles typing, paste and backspace
 * until Enter. ANSI escape sequences from cursor/navigation keys are ignored.
 */
function captureFirstSubmittedInput(
  handle: TermHandle,
  data: string,
): string | null {
  if (handle.firstInputSubmitted) return null;

  for (const char of data) {
    if (handle.inputEscapeState === "esc") {
      if (char === "[") {
        handle.inputEscapeState = "csi";
      } else if (char === "]") {
        // OSC replies are generated by the terminal emulator, not the user.
        // Ignore their payload until BEL or the ST sequence terminates it.
        handle.inputEscapeState = "osc";
      } else if (char === "P" || char === "^" || char === "_") {
        // Also ignore DCS/PM/APC string payloads, which can be emitted as
        // terminal capability replies and have the same ST terminator.
        handle.inputEscapeState = "string";
      } else {
        handle.inputEscapeState = "none";
      }
      continue;
    }
    if (handle.inputEscapeState === "csi") {
      if (char >= "@" && char <= "~") handle.inputEscapeState = "none";
      continue;
    }
    if (
      handle.inputEscapeState === "osc" ||
      handle.inputEscapeState === "string"
    ) {
      if (char === "\x07") {
        handle.inputEscapeState = "none";
      } else if (char === "\x1b") {
        handle.inputEscapeState =
          handle.inputEscapeState === "osc" ? "oscEsc" : "stringEsc";
      }
      continue;
    }
    if (
      handle.inputEscapeState === "oscEsc" ||
      handle.inputEscapeState === "stringEsc"
    ) {
      if (char === "\\") {
        handle.inputEscapeState = "none";
      } else if (char === "\x07") {
        handle.inputEscapeState = "none";
      } else {
        // A non-ST character is still part of the string payload. Keep
        // ignoring it rather than leaking terminal metadata into the title.
        handle.inputEscapeState =
          handle.inputEscapeState === "oscEsc" ? "osc" : "string";
      }
      continue;
    }
    if (char === "\x1b") {
      handle.inputEscapeState = "esc";
      continue;
    }
    if (char === "\r" || char === "\n") {
      const input = handle.firstInputBuffer.trim();
      if (input) {
        handle.firstInputSubmitted = true;
        return input;
      }
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      handle.firstInputBuffer = Array.from(handle.firstInputBuffer)
        .slice(0, -1)
        .join("");
      continue;
    }
    if (char.codePointAt(0)! >= 0x20 && handle.firstInputBuffer.length < 240) {
      handle.firstInputBuffer += char;
    }
  }
  return null;
}

const FALLBACK_FONT =
  "'JetBrains Mono Variable', 'SF Mono', SFMono-Regular, Menlo, 'PingFang SC', 'Hiragino Sans GB', 'Apple Color Emoji', monospace";
const DEFAULT_TERMINAL_FONT_SIZE = 13;

/** Effective xterm font size bounds for settings × font-zoom combinations. */
const MIN_TERMINAL_FONT_SIZE = 8;
const MAX_TERMINAL_FONT_SIZE = 40;

/** Terminal font size after applying the transient Ctrl/⌘ +/- zoom scale. */
export function scaledTerminalFontSize(base: number, scale: number): number {
  return Math.round(
    Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, base * scale)),
  );
}
const bundledTerminalFontReady =
  typeof document !== "undefined" && document.fonts
    ? Promise.all([
        document.fonts.load(
          `400 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
        document.fonts.load(
          `600 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
        document.fonts.load(
          `italic 400 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
        document.fonts.load(
          `italic 600 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
      ])
    : Promise.resolve([]);

export function cssFontFamily(setting: string): string {
  if (!setting || setting === "system-monospace") return FALLBACK_FONT;
  return `'${setting.replace(/'/g, "")}', ${FALLBACK_FONT}`;
}

function syncHandleTheme(
  handle: TermHandle,
  theme = getState().themeEffective,
  terminalTheme: TerminalThemeId = getState().settings?.terminalTheme ?? "one",
) {
  handle.term.options.theme = getTerminalPalette(terminalTheme, theme).xterm;
  // Color glyphs and truecolor contrast adjustments are cached by xterm.
  // Rebuild the Canvas atlas whenever a pane becomes visible or its theme
  // changes so a handle can never retain the prepaint/default dark palette.
  handle.term.clearTextureAtlas();
}

export function getHandle(sessionId: string): TermHandle | undefined {
  return handles.get(sessionId);
}

export function getOrCreateHandle(sessionId: string): TermHandle {
  const existing = handles.get(sessionId);
  if (existing) return existing;
  const s = getState();
  const settings = s.settings;
  const session = s.projects
    .flatMap((project) => project.sessions)
    .find((item) => item.id === sessionId);
  if (Terminal.strings) {
    Terminal.strings.promptLabel = i18n.t("shell:terminal.promptLabel");
    Terminal.strings.tooMuchOutput = i18n.t("shell:terminal.tooMuchOutput");
  }
  const term = new Terminal({
    fontFamily: cssFontFamily(
      settings?.terminalFontFamily ?? "system-monospace",
    ),
    fontSize: scaledTerminalFontSize(
      settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
      getState().termFontScale,
    ),
    fontWeight: "400",
    fontWeightBold: "600",
    // Match JetBrains Mono's natural ~1.3em metrics: CJK fallback glyphs
    // (PingFang SC) keep their full height instead of being squeezed into a
    // 1.1 row, which is what made Chinese paragraphs read cramped and heavy.
    // Box-drawing borders stay continuous because the glyphs are drawn for
    // this leading.
    lineHeight: 1.3,
    letterSpacing: 0,
    // Agent TUIs often emit hard-coded dark-theme truecolor escapes (for
    // example RGB 255/255/255). When the app switches to Light, xterm must
    // adapt those cells instead of drawing white-on-white. Selection already
    // did this implicitly, which is why selecting text appeared to fix it.
    // 4.5 (WCAG AA for body text) still repairs those cells, but leaves dim
    // secondary output visibly below body brightness so the body/hint
    // hierarchy survives. The previous 7 flattened that hierarchy.
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: false,
    cursorBlink: true,
    // Bound xterm's cell buffer independently of the persisted log. Full
    // history remains available through persisted-log search and export.
    scrollback: 10_000,
    screenReaderMode: settings?.screenReaderMode ?? false,
    allowProposedApi: true,
    // xterm parses OSC 8 links itself. Non-http protocols must be allowed
    // here so `file://` hyperlinks reach the in-app document viewer; routing
    // in openTerminalLink is the security boundary — only validated http(s)
    // URLs ever leave the app for the OS.
    linkHandler: {
      activate: (_event, url) => openTerminalLink(url),
      allowNonHttpProtocols: true,
    },
    macOptionIsMeta: true,
    allowTransparency: false,
    theme: getTerminalPalette(settings?.terminalTheme ?? "one", s.themeEffective).xterm,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  // Detect plain http(s) URLs. OSC 8 links use the handler above, so both
  // forms share the same native URL validation and browser-opening path.
  term.loadAddon(new WebLinksAddon((_event, url) => openTerminalLink(url)));
  // Detect plain-text absolute and relative paths so agent-printed document
  // paths (which are not always wrapped in OSC 8 sequences) are clickable.
  term.registerLinkProvider(localFileLinkProvider(term, sessionId));
  let handle!: TermHandle;
  const writes = new TerminalWriteCoordinator(
    term,
    () => (handles.get(sessionId) === handle ? handle : null),
    (data) => writePreservingViewport(handle, data),
    () => {
      handle.terminalSnapshotRevision += 1;
    },
  );
  const viewport = new TerminalViewportController(term);
  handle = {
    sessionId,
    term,
    writes,
    viewport,
    fit,
    search,
    serialize,
    mouseEncoding: "default",
    opened: false,
    attached: false,
    attaching: false,
    generation: 0,
    attachmentId: null,
    displayReady: false,
    displayRenderPending: false,
    terminalSnapshotRevision: 0,
    persistedTerminalSnapshotRevision: -1,
    historyLoaded: false,
    historyLoading: false,
    nativeHistoryCursor: undefined,
    nativeHistoryEvents: [],
    nativeHistorySkippedLines: 0,
    nativeHistoryRequest: null,
    nativeHistoryBoundaryMarker: null,
    nativeHistoryTailSnapshot: null,
    nativeHistoryTailDirty: true,
    logCursor: null,
    rotationNoticeShown: false,
    pendingRenderedLogCursor: null,
    pendingOutputBytes: 0,
    peakPendingOutputBytes: 0,
    lastOutputParseLatencyMs: 0,
    allowRecoveryGap: false,
    recoveryTarget: null,
    container: null,
    resizeObserver: null,
    active: getState().activeSessionId === sessionId,
    geometryDirty: false,
    fitCount: 0,
    lastFitReason: null,
    lastFitDurationMs: 0,
    lastCols: 0,
    lastRows: 0,
    lastScrolledUp: false,
    firstInputBuffer: "",
    firstInputSubmitted: false,
    inputEscapeState: "none",
    startupReadyTimer: null,
    piStartupNoticeFilter:
      session?.adapter === "pi" &&
      session.transport === "pty" &&
      session.agentSessionId
        ? new PiStartupNoticeFilter(session.agentSessionId)
        : null,
  };
  installMouseEncodingTracking(handle);
  term.parser.registerOscHandler(PI_STARTUP_READY_OSC, (data) => {
    if (data !== PI_STARTUP_READY_PAYLOAD) return false;
    if (getState().runtime[sessionId]?.startupPending) {
      queuePiStartupReady(handle);
    }
    return true;
  });
  term.onTitleChange((title) => {
    patchRuntime(sessionId, { terminalTitle: title.trim() || null });
  });
  term.onBell(() => {
    const target = handle.container;
    if (!target) return;
    target.classList.remove("terminal-bell");
    // Restart the animation even when several BELs arrive close together.
    void target.offsetWidth;
    target.classList.add("terminal-bell");
    window.setTimeout(() => target.classList.remove("terminal-bell"), 240);
  });
  term.onRender(() => {
    if (!handle.displayRenderPending || handles.get(sessionId) !== handle) return;
    handle.displayRenderPending = false;
    handle.displayReady = true;
    const revision =
      (getState().runtime[sessionId]?.terminalPreviewRevision ?? 0) + 1;
    patchRuntime(sessionId, { terminalPreviewRevision: revision });
  });
  term.onData((data) => {
    // Input is only writable once attached — writers register at attach time.
    if (!handle.attached) return;
    const firstInput = captureFirstSubmittedInput(handle, data);
    void queueTerminalInput(sessionId, data)
      .then(() => {
        if (!firstInput) return;
        void api
          .autoRenameSessionFromFirstInput(sessionId, firstInput)
          .catch(() => {
            // Keep the input buffered so a later Enter can retry the harmless
            // metadata update if the database command temporarily fails.
            handle.firstInputSubmitted = false;
          });
      })
      .catch((e) => {
        if (firstInput) handle.firstInputSubmitted = false;
        patchRuntime(sessionId, { error: errorText(e), errorMessage: null });
      });
  });
  term.onScroll(() => {
    handle.viewport.observeViewport();
    updateScrolledUp(handle);
  });
  handles.set(sessionId, handle);
  if (getState().runtime[sessionId]?.startupPending) {
    armPiStartupReadyTimeout(handle);
  }
  const sessionLive =
    session?.lifecycle === "creating" || session?.lifecycle === "running";
  const fullscreenPi =
    sessionLive && session?.adapter === "pi" && session.transport === "pty";
  let snapshot = sessionLive ? readTerminalSnapshot(sessionId) : null;
  if (fullscreenPi && snapshot && !snapshot.content.includes("\x1b[?1049h")) {
    // A prior renderer may have snapshotted Pi after losing its alternate
    // buffer. Reusing that normal-buffer image makes every later reconnect
    // preserve the corruption, so discard it and rebuild from the Host tail.
    clearTerminalSnapshot(sessionId);
    snapshot = null;
  }
  if (snapshot) {
    handle.logCursor = snapshot.cursor;
    if (snapshot.cols > 0 && snapshot.rows > 0) {
      term.resize(snapshot.cols, snapshot.rows);
    }
    // SerializeAddon restores mouse tracking but omits its report encoding.
    // Reapply the captured encoding before resuming after the snapshot cursor.
    // Legacy/migrated Pi snapshots recorded `default`, but fullscreen Pi asks
    // for SGR once at process start; repair those snapshots at restore time.
    const restoredMouseEncoding =
      fullscreenPi && snapshot.mouseEncoding === "default"
        ? "sgr"
        : snapshot.mouseEncoding;
    handle.writes.write(
      snapshot.content +
        (fullscreenPi
          ? fullscreenPiMouseProtocolSuffix(
              snapshot.content,
              restoredMouseEncoding,
            )
          : mouseEncodingSequence(restoredMouseEncoding)),
      () => {
        if (handles.get(sessionId) !== handle) return;
        handle.displayRenderPending = true;
        handle.term.refresh(0, Math.max(0, handle.term.rows - 1));
      },
    );
    handle.persistedTerminalSnapshotRevision =
      handle.terminalSnapshotRevision;
    handle.historyLoaded = true;
  } else if (fullscreenPi) {
    // A bounded live tail normally omits Pi's process-start DECSET sequences.
    // Restore the alternate buffer, mouse tracking, and SGR report encoding.
    const alternateScreen = "\x1b[?1049h";
    handle.writes.write(
      alternateScreen + fullscreenPiMouseProtocolSuffix(alternateScreen, "sgr"),
    );
  }
  return handle;
}

/**
 * Follow new output only while the user is already at the bottom. When the
 * user is reading scrollback, a write must never move their viewport — but
 * renderer quirks or a buffer reflow can still snap it to the bottom (or the
 * top) mid-write. Capture the reading row before the write and restore it
 * once the bytes have drained through xterm's parser.
 *
 * The restore only fires on extreme snaps. A tail-following write that lands
 * at row 0 is reconciled back to the tail; a scrollback reader is restored
 * only after a snap to the top or bottom. Any mid-scrollback position can be
 * the user's own wheel/drag gesture, so every callback is fenced by a
 * user-authored viewport revision. This avoids ratcheting downward gestures
 * back up while still repairing renderer jumps during unattended output.
 */
function writePreservingViewport(
  handle: TermHandle,
  data: Uint8Array | string,
) {
  const before = handle.term.buffer.active;
  const bufferTypeBeforeWrite = before.type;
  const atBottom =
    bufferTypeBeforeWrite !== "normal" || before.viewportY >= before.baseY;
  const readingRow = before.viewportY;
  const generation = handle.generation;
  const viewportIntentRevision = handle.viewport.revision;
  const byteLength =
    typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  const queuedAt = performance.now();
  if (handle.nativeHistoryBoundaryMarker !== null) {
    handle.nativeHistoryTailDirty = true;
  }
  handle.pendingOutputBytes += byteLength;
  handle.peakPendingOutputBytes = Math.max(
    handle.peakPendingOutputBytes,
    handle.pendingOutputBytes,
  );
  handle.writes.write(data, () => {
    handle.pendingOutputBytes = Math.max(0, handle.pendingOutputBytes - byteLength);
    handle.lastOutputParseLatencyMs = Math.max(0, performance.now() - queuedAt);
    if (
      handles.get(handle.sessionId) !== handle ||
      handle.generation !== generation ||
      handle.viewport.revision !== viewportIntentRevision
    )
      return;
    const after = handle.term.buffer.active;
    if (after.type !== "normal") return;
    if (atBottom) {
      if (
        bufferTypeBeforeWrite === "normal" &&
        after.baseY > 0 &&
        after.viewportY === 0
      ) {
        queueTailViewportRepair(handle, viewportIntentRevision);
      }
      return;
    }
    const target = Math.min(readingRow, after.baseY);
    const snappedToBottom =
      after.baseY > target && after.viewportY >= after.baseY;
    const snappedToTop = after.viewportY === 0 && target > 0;
    if (snappedToBottom || snappedToTop) {
      handle.viewport.restoreReadingLine(target, viewportIntentRevision);
    }
  });
}

function queueTailViewportRepair(
  handle: TermHandle,
  viewportIntentRevision: number,
) {
  // A retained-history replay can queue many writes before xterm drains any
  // callback. Repairing row 0 from each callback visibly races through every
  // intermediate tail. The coordinator inserts one generation-fenced parser
  // boundary behind the complete queued burst.
  handle.writes.drain("tail-repair", () => {
    if (handle.viewport.revision !== viewportIntentRevision) return;
    const after = handle.term.buffer.active;
    if (after.type === "normal" && after.baseY > 0 && after.viewportY === 0) {
      handle.viewport.restoreTail(viewportIntentRevision);
    }
  });
}

function queueReplayParsed(handle: TermHandle) {
  // replay_done is a transport marker. This named drain is inserted at that
  // exact channel boundary, behind all replay bytes but ahead of later live
  // output, so runtime.replayDone means parser-drained rather than delivered.
  handle.writes.drain("replay-complete", () => {
    handle.displayRenderPending = true;
    patchRuntime(handle.sessionId, { replayDone: true });
    // Parsing and Canvas painting are separately scheduled in xterm 5.5. Keep
    // cold/restart coverage (and the silent warm veil) until onRender proves
    // that the parser-ready checkpoint reached the renderer.
    handle.term.refresh(0, Math.max(0, handle.term.rows - 1));
    updateScrolledUp(handle);
  });
}

function clearPiStartupReadyTimer(handle: TermHandle) {
  if (handle.startupReadyTimer === null) return;
  window.clearTimeout(handle.startupReadyTimer);
  handle.startupReadyTimer = null;
}

function queuePiStartupReady(handle: TermHandle) {
  clearPiStartupReadyTimer(handle);
  handle.writes.drain("startup-ready", () => {
    patchRuntime(handle.sessionId, { startupPending: false });
    updateScrolledUp(handle);
  });
}

function armPiStartupReadyTimeout(handle: TermHandle) {
  clearPiStartupReadyTimer(handle);
  const generation = handle.generation;
  handle.startupReadyTimer = window.setTimeout(() => {
    handle.startupReadyTimer = null;
    if (
      handles.get(handle.sessionId) !== handle ||
      handle.generation !== generation
    )
      return;
    // Compatibility escape hatch for an older Pi that does not emit the
    // semantic marker. The paired custom Pi takes the marker path instead.
    queuePiStartupReady(handle);
  }, PI_STARTUP_READY_TIMEOUT_MS);
}

function writeTerminalOutput(handle: TermHandle, bytes: Uint8Array) {
  const visible = handle.piStartupNoticeFilter?.feed(bytes) ?? bytes;
  if (visible.length) handle.writes.writeOutput(visible);
}

function finishTerminalStartupFilter(handle: TermHandle) {
  const visible = handle.piStartupNoticeFilter?.finish();
  if (visible?.length) handle.writes.writeOutput(visible);
}

/**
 * Queue the recovery marker now and return a finalizer that reveals it after
 * all surrounding context writes have drained through xterm. IMarker tracks
 * the row while later output appends or trims scrollback.
 */
function queueRecoveryLocationMarker(handle: TermHandle): () => void {
  const generation = handle.generation;
  const viewportIntentRevision = handle.viewport.beginLocate();
  let marker: IMarker | undefined;
  handle.writes.write(
    `\r\n\x1b[2m── ${i18n.t("session:terminal.recoveryLocation")} ──\x1b[0m\r\n`,
    () => {
      if (
        handles.get(handle.sessionId) !== handle ||
        handle.generation !== generation
      )
        return;
      marker = handle.term.registerMarker(-1);
    },
  );
  return () => {
    handle.writes.drain(
      "recovery-reveal",
      () => {
        const line = marker?.line ?? -1;
        if (line >= 0 && handle.term.buffer.active.type === "normal") {
          handle.viewport.revealLine(line, viewportIntentRevision);
        }
        marker?.dispose();
      },
      { onDiscard: () => marker?.dispose() },
    );
  };
}

const MAX_INPUT_FRAME_BYTES = 256 * 1024;
const terminalInputQueues = new Map<string, Promise<void>>();
const snapshotTimers = new Map<string, number>();
const terminalSnapshotCache = new Map<
  string,
  { raw: string; snapshot: TerminalSnapshot }
>();

function cacheTerminalSnapshot(
  sessionId: string,
  raw: string,
  snapshot: TerminalSnapshot,
) {
  terminalSnapshotCache.delete(sessionId);
  terminalSnapshotCache.set(sessionId, { raw, snapshot });
  while (terminalSnapshotCache.size > MAX_PERSISTENT_TERMINALS) {
    const oldest = terminalSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    terminalSnapshotCache.delete(oldest);
  }
}

interface TerminalSnapshot {
  version: typeof TERMINAL_SNAPSHOT_VERSION;
  cursor: LogCursorView;
  cols: number;
  rows: number;
  content: string;
  mouseEncoding: TerminalMouseEncoding;
}

function snapshotKey(sessionId: string) {
  return `agentport:terminal-snapshot:v${TERMINAL_SNAPSHOT_VERSION}:${sessionId}`;
}

function legacySnapshotKey(sessionId: string) {
  return `agentport:terminal-snapshot:v1:${sessionId}`;
}

function readTerminalSnapshot(sessionId: string): TerminalSnapshot | null {
  try {
    const currentKey = snapshotKey(sessionId);
    const legacyKey = legacySnapshotKey(sessionId);
    const currentRaw = localStorage.getItem(currentKey);
    const raw = currentRaw ?? localStorage.getItem(legacyKey);
    if (!raw || raw.length > MAX_TERMINAL_SNAPSHOT_CHARS + 4096) return null;
    const cached = terminalSnapshotCache.get(sessionId);
    if (cached?.raw === raw) return cached.snapshot;
    const parsed = JSON.parse(raw) as Omit<
      Partial<TerminalSnapshot>,
      "version" | "mouseEncoding"
    > & {
      version?: number;
      mouseEncoding?: TerminalMouseEncoding;
    };
    const legacy = currentRaw === null && parsed.version === 1;
    if (
      (!legacy && parsed.version !== TERMINAL_SNAPSHOT_VERSION) ||
      typeof parsed.content !== "string" ||
      parsed.content.length > MAX_TERMINAL_SNAPSHOT_CHARS ||
      typeof parsed.cols !== "number" ||
      typeof parsed.rows !== "number" ||
      (!legacy &&
        parsed.mouseEncoding !== "default" &&
        parsed.mouseEncoding !== "sgr" &&
        parsed.mouseEncoding !== "sgr-pixels") ||
      !parsed.cursor ||
      typeof parsed.cursor.runId !== "string" ||
      typeof parsed.cursor.runOrdinal !== "number" ||
      typeof parsed.cursor.generation !== "number" ||
      typeof parsed.cursor.offset !== "number"
    ) {
      return null;
    }
    const snapshot: TerminalSnapshot = {
      version: TERMINAL_SNAPSHOT_VERSION,
      cursor: parsed.cursor,
      cols: parsed.cols,
      rows: parsed.rows,
      content: parsed.content,
      mouseEncoding: legacy ? "default" : parsed.mouseEncoding!,
    };
    if (legacy) {
      const encoded = JSON.stringify(snapshot);
      localStorage.setItem(currentKey, encoded);
      localStorage.removeItem(legacyKey);
      cacheTerminalSnapshot(sessionId, encoded, snapshot);
    } else {
      cacheTerminalSnapshot(sessionId, raw, snapshot);
    }
    return snapshot;
  } catch {
    return null;
  }
}

function clearTerminalSnapshot(sessionId: string) {
  terminalSnapshotCache.delete(sessionId);
  try {
    localStorage.removeItem(snapshotKey(sessionId));
  } catch {
    // A disabled Web storage backend only degrades crash-time restoration.
  }
}

export function isTerminalPreviewRendered(sessionId: string): boolean {
  return handles.get(sessionId)?.displayReady === true;
}

export function hasWarmTerminalPreview(sessionId: string): boolean {
  if (isTerminalPreviewRendered(sessionId)) return true;
  const session = findSession(getState().projects, sessionId);
  if (
    session?.transport !== "pty" ||
    (session.lifecycle !== "creating" && session.lifecycle !== "running")
  ) {
    return false;
  }
  const snapshot = readTerminalSnapshot(sessionId);
  if (!snapshot) return false;
  return !(
    session.adapter === "pi" &&
    !snapshot.content.includes("\x1b[?1049h")
  );
}

function storeTerminalSnapshot(
  handle: TermHandle,
  cursor: LogCursorView,
  snapshotRevision: number,
): boolean {
  try {
    const content = handle.serialize.serialize({
      scrollback: TERMINAL_SNAPSHOT_SCROLLBACK_LINES,
    });
    if (content.length > MAX_TERMINAL_SNAPSHOT_CHARS) {
      clearTerminalSnapshot(handle.sessionId);
      return false;
    }
    const snapshot: TerminalSnapshot = {
      version: TERMINAL_SNAPSHOT_VERSION,
      cursor,
      cols: handle.term.cols,
      rows: handle.term.rows,
      content,
      mouseEncoding: handle.mouseEncoding,
    };
    const encoded = JSON.stringify(snapshot);
    localStorage.setItem(snapshotKey(handle.sessionId), encoded);
    cacheTerminalSnapshot(handle.sessionId, encoded, snapshot);
    if (handle.terminalSnapshotRevision === snapshotRevision) {
      handle.persistedTerminalSnapshotRevision = snapshotRevision;
    }
    return true;
  } catch {
    // Quota/private-mode failures must never interrupt terminal output.
    return false;
  }
}

function persistTerminalSnapshotBeforeRelease(
  handle: TermHandle,
): Promise<boolean> {
  const timer = snapshotTimers.get(handle.sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    snapshotTimers.delete(handle.sessionId);
  }
  if (!handle.logCursor || !handle.displayReady) return Promise.resolve(false);
  const cursor = { ...handle.logCursor };
  const snapshotRevision = handle.terminalSnapshotRevision;
  const cached = readTerminalSnapshot(handle.sessionId);
  if (
    cached &&
    handle.persistedTerminalSnapshotRevision === snapshotRevision &&
    cached.cursor.runId === cursor.runId &&
    cached.cursor.runOrdinal === cursor.runOrdinal &&
    cached.cursor.generation === cursor.generation &&
    cached.cursor.offset === cursor.offset
  ) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const queued = handle.writes.drain(
      "release-snapshot",
      (_targetSequence, promoted) => {
        resolve(
          !promoted &&
            storeTerminalSnapshot(handle, cursor, snapshotRevision),
        );
      },
      { coalesce: false, onDiscard: () => resolve(false) },
    );
    if (!queued) resolve(false);
  });
}

function scheduleTerminalSnapshot(handle: TermHandle) {
  const existing = snapshotTimers.get(handle.sessionId);
  if (existing !== undefined) window.clearTimeout(existing);
  snapshotTimers.set(
    handle.sessionId,
    window.setTimeout(() => {
      snapshotTimers.delete(handle.sessionId);
      if (handles.get(handle.sessionId) !== handle || !handle.logCursor) return;
      const cursor = { ...handle.logCursor };
      const snapshotRevision = handle.terminalSnapshotRevision;
      // Serialize only after every write covered by `cursor` has passed
      // xterm's parser. Later writes remain queued behind this coordinator
      // boundary, so screen state and replay cursor form one consistent checkpoint.
      handle.writes.drain(
        "snapshot",
        (_targetSequence, promoted) => {
          // A drain requested mid-DEC-2026 frame is deliberately moved behind
          // the complete frame. Its old cursor no longer describes that newer
          // screen, so debounce a fresh checkpoint instead of pairing them.
          if (promoted) {
            scheduleTerminalSnapshot(handle);
            return;
          }
          storeTerminalSnapshot(handle, cursor, snapshotRevision);
        },
        { coalesce: false },
      );
    }, 1000),
  );
}

/** Preserve byte ordering while splitting a large paste into bounded IPC
 * frames. The backend applies the same limit before forwarding to the Host. */
async function sendTerminalInput(
  sessionId: string,
  data: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(data);
  for (let start = 0; start < bytes.length; start += MAX_INPUT_FRAME_BYTES) {
    await api.sendInput(
      sessionId,
      bytesToB64(bytes.subarray(start, start + MAX_INPUT_FRAME_BYTES)),
    );
  }
}

/** Serialize every xterm input event per session. A large paste spans several
 * awaited IPC calls; without this queue a later keypress can overtake one of
 * those chunks and corrupt the byte stream observed by the PTY. */
function queueTerminalInput(sessionId: string, data: string): Promise<void> {
  const previous = terminalInputQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => sendTerminalInput(sessionId, data));
  terminalInputQueues.set(sessionId, next);
  const cleanup = () => {
    if (terminalInputQueues.get(sessionId) === next) {
      terminalInputQueues.delete(sessionId);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

function updateScrolledUp(handle: TermHandle) {
  const buf = handle.term.buffer.active;
  const up = buf.viewportY < buf.baseY;
  if (up !== handle.lastScrolledUp) {
    handle.lastScrolledUp = up;
    patchRuntime(handle.sessionId, { scrolledUp: up });
  }
}

/** Mount (once) into a pane container div; starts the attach if needed. */
// WKWebView suppresses native key auto-repeat under macOS press-and-hold
// semantics (observed even with ApplePressAndHoldEnabled=false), so holding a
// key never repeats in the terminal. Synthesize repeat ourselves: when no
// native repeat arrives (KeyboardEvent.repeat), feed term.input() — the same
// path as real typing (onData → send_input → first-input title capture).
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 40;

function repeatableInput(e: KeyboardEvent): string | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key.length === 1) return e.key; // printable; Shift/CapsLock already applied
  if (e.key === "Backspace") return "\x7f"; // same sequence xterm emits
  return null;
}

const IME_KEYDOWN_WINDOW_MS = 1000;

function installInputCompatibility(
  term: Terminal,
  container: HTMLElement,
): () => void {
  if (!term.textarea) return () => {};
  let delayTimer: number | undefined;
  let intervalTimer: number | undefined;
  let activeCode: string | null = null;
  let forwardedGeneration = 0;
  let disposed = false;
  let pendingKeyDown: { generation: number; timeStamp: number } | null = null;
  const fallbackTimers = new Set<number>();
  const forwarded = term.onData(() => {
    forwardedGeneration += 1;
  });

  const stopRepeat = () => {
    if (delayTimer !== undefined) {
      window.clearTimeout(delayTimer);
      delayTimer = undefined;
    }
    if (intervalTimer !== undefined) {
      window.clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
    activeCode = null;
  };

  const deferFallback = (data: string, generation: number) => {
    // First let the current DOM event finish. xterm may handle it synchronously
    // or queue its own 0ms textarea-diff task for IME keyCode 229. Register our
    // task afterwards and only fill the gap if neither path emitted onData.
    queueMicrotask(() => {
      if (disposed || forwardedGeneration !== generation) return;
      const timer = window.setTimeout(() => {
        fallbackTimers.delete(timer);
        if (!disposed && forwardedGeneration === generation) term.input(data);
      }, 0);
      fallbackTimers.add(timer);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target === term.textarea &&
      event.key === "Tab" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // Keep reverse-tab inside the terminal. Do not stop propagation: xterm
      // must still translate it to ESC [ Z for the active Agent.
      event.preventDefault();
    }
    const generationAtKeyDown = forwardedGeneration;
    pendingKeyDown = {
      generation: generationAtKeyDown,
      timeStamp: event.timeStamp,
    };
    const data = repeatableInput(event);
    if (event.repeat) {
      stopRepeat();
      if (data !== null) {
        // Let xterm keep its key/onData/textarea and accessibility behavior;
        // only synthesize the repeat if that complete path produces no data.
        deferFallback(data, generationAtKeyDown);
      }
      return;
    }
    stopRepeat();
    if (data === null) return;
    activeCode = event.code;
    delayTimer = window.setTimeout(() => {
      delayTimer = undefined;
      intervalTimer = window.setInterval(
        () => term.input(data),
        REPEAT_INTERVAL_MS,
      );
    }, REPEAT_DELAY_MS);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (activeCode === null || e.code === activeCode) stopRepeat();
  };

  const onInput = (event: Event) => {
    if (!(event instanceof InputEvent)) return;
    if (!event.data || event.inputType !== "insertText" || event.isComposing)
      return;
    // Remote/mobile keyboards can commit text without a matching keyup. Treat
    // that commit as the end of the logical keystroke so our local hold
    // fallback cannot repeat the final character indefinitely. Do this before
    // the de-duplication return below, because xterm may already have forwarded
    // the keydown that corresponds to this input event.
    stopRepeat();
    const data = event.data;
    const generationAtInput = forwardedGeneration;
    const keyDown = pendingKeyDown;
    pendingKeyDown = null;
    const followsKeyDown =
      keyDown !== null &&
      event.timeStamp >= keyDown.timeStamp &&
      event.timeStamp - keyDown.timeStamp <= IME_KEYDOWN_WINDOW_MS;
    if (followsKeyDown && generationAtInput !== keyDown.generation) return;
    // Some third-party macOS IMEs commit English text only through a composed
    // input event. xterm ignores it after seeing keydown even when that
    // keydown produced no onData, so fill only the verified missing input.
    deferFallback(data, generationAtInput);
  };

  // Observe from an ancestor in the capture phase: xterm's own textarea
  // handlers stop propagation, so listeners on the textarea itself never
  // fire. Shift+Tab only cancels WebView focus traversal; no event is stopped.
  container.addEventListener("keydown", onKeyDown, true);
  container.addEventListener("keyup", onKeyUp, true);
  container.addEventListener("blur", stopRepeat, true);
  container.addEventListener("input", onInput, true);
  return () => {
    disposed = true;
    stopRepeat();
    for (const timer of fallbackTimers) window.clearTimeout(timer);
    fallbackTimers.clear();
    forwarded.dispose();
    container.removeEventListener("keydown", onKeyDown, true);
    container.removeEventListener("keyup", onKeyUp, true);
    container.removeEventListener("blur", stopRepeat, true);
    container.removeEventListener("input", onInput, true);
  };
}

function installClipboardCompatibility(
  term: Terminal,
  container: HTMLElement,
): () => void {
  let disposed = false;
  const onCopy = (event: ClipboardEvent) => {
    const selection = term.getSelection();
    if (!selection) return;

    // xterm's built-in copy handler writes through ClipboardEvent.setData().
    // WKWebView can mis-encode non-ASCII text on that path (for example Chinese
    // becomes repeated MacRoman mojibake). Use the same async clipboard path as
    // the app's other copy actions and stop xterm's later bubble-phase handler.
    void copyText(selection);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const forwardImagePaste = () => {
    // Ctrl+V is the image-paste shortcut understood by interactive Agent TUIs;
    // they retain ownership of reading, encoding and attaching the clipboard.
    term.input("\x16");
    term.focus();
  };
  const onPaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage =
      Array.from(clipboard.items).some((item) =>
        item.type.startsWith("image/"),
      ) ||
      Array.from(clipboard.files).some((file) =>
        file.type.startsWith("image/"),
      );
    if (hasImage) {
      // xterm only reads text/plain from ClipboardEvent, so an image paste
      // would otherwise send an empty string.
      forwardImagePaste();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const hasText =
      Array.from(clipboard.types).some((type) =>
        type.toLowerCase().startsWith("text/plain"),
      ) || clipboard.getData("text/plain").length > 0;
    if (hasText) return;

    // WKWebView can expose a pure image paste with empty items/files/types.
    // Probe the native pasteboard only for that opaque event so normal text
    // paste remains on xterm's synchronous path.
    void clipboardHasImage().then((nativeHasImage) => {
      if (nativeHasImage && !disposed) forwardImagePaste();
    });
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const selection = term.getSelection();
    const items: MenuItem[] = [
      {
        label: i18n.t("shell:terminal.copy"),
        disabled: !selection,
        action: selection ? () => void copyText(selection) : undefined,
      },
      {
        label: i18n.t("shell:terminal.paste"),
        action: () => {
          void readClipboardText()
            .then((text) => {
              if (text) term.paste(text);
              term.focus();
            })
            .catch((error) => toast(errorText(error), "error"));
        },
      },
      { label: "", separator: true },
      {
        label: i18n.t("shell:terminal.selectAll"),
        action: () => term.selectAll(),
      },
      {
        label: i18n.t("shell:terminal.search"),
        action: () => setState({ termSearchOpen: true }),
      },
    ];
    openContextMenu(event.clientX, event.clientY, items);
  };
  container.addEventListener("copy", onCopy, true);
  container.addEventListener("paste", onPaste, true);
  container.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    disposed = true;
    container.removeEventListener("copy", onCopy, true);
    container.removeEventListener("paste", onPaste, true);
    container.removeEventListener("contextmenu", onContextMenu, true);
  };
}

function installViewportIntentTracking(
  handle: TermHandle,
  container: HTMLDivElement,
): () => void {
  const onWheel = () => {
    handle.viewport.noteUserIntent();
  };
  container.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => container.removeEventListener("wheel", onWheel, true);
}

const inputCompatibilityDisposers = new Map<string, () => void>();
const clipboardCompatibilityDisposers = new Map<string, () => void>();
const viewportIntentDisposers = new Map<string, () => void>();

function bindTerminalContainer(handle: TermHandle, container: HTMLDivElement) {
  handle.container = container;
  inputCompatibilityDisposers.get(handle.sessionId)?.();
  inputCompatibilityDisposers.set(
    handle.sessionId,
    installInputCompatibility(handle.term, container),
  );
  clipboardCompatibilityDisposers.get(handle.sessionId)?.();
  clipboardCompatibilityDisposers.set(
    handle.sessionId,
    installClipboardCompatibility(handle.term, container),
  );
  viewportIntentDisposers.get(handle.sessionId)?.();
  viewportIntentDisposers.set(
    handle.sessionId,
    installViewportIntentTracking(handle, container),
  );
  handle.resizeObserver?.disconnect();
  handle.resizeObserver = new ResizeObserver(() => {
    if (!handle.active) {
      handle.geometryDirty = true;
      return;
    }
    scheduleFitHandle(handle);
  });
  handle.resizeObserver.observe(container);
}

function openTerminalWithCompatibleFontMeasurement(
  term: Terminal,
  container: HTMLDivElement,
) {
  const offscreenCanvas = Object.getOwnPropertyDescriptor(
    globalThis,
    "OffscreenCanvas",
  );
  const canTemporarilyHideOffscreenCanvas =
    offscreenCanvas &&
    "value" in offscreenCanvas &&
    (offscreenCanvas.configurable || offscreenCanvas.writable);
  if (
    getState().platform?.os !== "linux" ||
    !canTemporarilyHideOffscreenCanvas
  ) {
    term.open(container);
    return;
  }

  // xterm 5.5 prefers OffscreenCanvas TextMetrics when it opens. WebKitGTK
  // can return scaled metrics here, producing oversized cells around normally
  // sized glyphs. Hiding only this constructor makes xterm use its built-in
  // DOM measurement fallback; CanvasAddon is loaded after the original global
  // descriptor has been restored.
  try {
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      ...offscreenCanvas,
      value: undefined,
    });
    term.open(container);
  } finally {
    Object.defineProperty(globalThis, "OffscreenCanvas", offscreenCanvas);
  }
}

export function mountTerminal(sessionId: string, container: HTMLDivElement) {
  const handle = getOrCreateHandle(sessionId);
  if (!handle.opened) {
    handle.opened = true;
    openTerminalWithCompatibleFontMeasurement(handle.term, container);
    bindTerminalContainer(handle, container);
    try {
      // Full-screen agent TUIs rely on Canvas to preserve their ANSI palette
      // and box glyphs in WKWebView. The DOM renderer is only a fallback when
      // Canvas cannot initialize at all.
      handle.term.loadAddon(new CanvasAddon());
      setState({ rendererMode: "canvas", rendererFallbackReason: null });
    } catch (error) {
      setState({
        rendererMode: "dom",
        rendererFallbackReason: errorText(error),
      });
    }
    syncHandleTheme(handle);
    fitHandle(handle, false, false, "mount");
    // A self-hosted webfont can finish loading after xterm's first canvas
    // measurement. Force one same-family option change so xterm remeasures
    // cells and repaints any fallback glyphs.
    void bundledTerminalFontReady.then(() => {
      if (handles.get(sessionId) !== handle || !handle.opened) return;
      const family = handle.term.options.fontFamily;
      handle.term.options.fontFamily = `${family}, monospace`;
      handle.term.options.fontFamily = family;
      handle.term.clearTextureAtlas();
      fitHandle(handle, true, true, "font-ready");
    });
  } else if (handle.container !== container) {
    // Structured Session views replace the terminal stack in the React tree.
    // An existing xterm keeps its element in the detached former host unless
    // we move it and rebind observers; the new host otherwise paints blank.
    const terminalElement = handle.term.element;
    if (terminalElement && terminalElement.parentElement !== container) {
      container.appendChild(terminalElement);
    }
    bindTerminalContainer(handle, container);
    requestAnimationFrame(() => {
      if (handles.get(sessionId) === handle && handle.container === container) {
        fitHandle(handle, true, true, "container-rebind");
      }
    });
  }
  // A PTY Session always owns this same xterm. Ended/interrupted Sessions do
  // not have a Host to attach; seed their buffer from the agent-native log.
  const ses = getState()
    .projects.flatMap((p) => p.sessions)
    .find((x) => x.id === sessionId);
  const ended =
    ses &&
    (ses.lifecycle === "exited" ||
      ses.lifecycle === "stopped" ||
      ses.lifecycle === "interrupted");
  if (ended) void loadOlderNativeHistory(sessionId);
  else void attachHandle(sessionId);
}

const NATIVE_HISTORY_PAGE_SIZE = 200;

function resetNativeHistory(handle: TermHandle) {
  handle.nativeHistoryBoundaryMarker?.dispose();
  handle.nativeHistoryCursor = undefined;
  handle.nativeHistoryEvents = [];
  handle.nativeHistorySkippedLines = 0;
  handle.nativeHistoryRequest = null;
  handle.nativeHistoryBoundaryMarker = null;
  handle.nativeHistoryTailSnapshot = null;
  handle.nativeHistoryTailDirty = true;
}

/** Native log text is untrusted terminal input. Preserve readable whitespace,
 * but turn every control byte into inert text before adding our own ANSI. */
function sanitizeNativeHistoryText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b/g, "␛")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "�");
}

function nativeHistoryPrefix(
  events: HistoryEvent[],
  skippedLines: number,
): string {
  const blocks = events.map((event) => {
    const label = sanitizeNativeHistoryText(event.role ?? event.kind).toUpperCase();
    const timestamp = event.timestamp
      ? ` · ${sanitizeNativeHistoryText(event.timestamp)}`
      : "";
    const text = sanitizeNativeHistoryText(event.text).replace(/\n/g, "\r\n");
    return `\x1b[2m[${label}${timestamp}]\x1b[0m\r\n${text}\r\n`;
  });
  const skipped = skippedLines > 0
    ? `\x1b[33m${sanitizeNativeHistoryText(i18n.t("session:ui.history.skipped", { count: skippedLines }))}\x1b[0m\r\n`
    : "";
  return (
    `\x1b[2m── ${sanitizeNativeHistoryText(i18n.t("session:ui.history.title"))} ──\x1b[0m\r\n` +
    skipped +
    blocks.join("\r\n")
  );
}

function estimateWrappedRows(text: string, cols: number): number {
  const width = Math.max(1, cols);
  return text.split(/\r?\n/).reduce(
    (rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / width)),
    0,
  );
}

function serializeTailAfterNativePrefix(handle: TermHandle): string {
  if (
    handle.nativeHistoryTailSnapshot !== null &&
    !handle.nativeHistoryTailDirty
  ) {
    return handle.nativeHistoryTailSnapshot;
  }
  const markerLine = handle.nativeHistoryBoundaryMarker?.line ?? -1;
  const buffer = handle.term.buffer.active;
  if (markerLine >= 0 && buffer.type === "normal") {
    const start = markerLine + 1;
    const end = buffer.length - 1;
    return start <= end
      ? handle.serialize.serialize({ range: { start, end } })
      : "";
  }
  return handle.nativeHistoryTailSnapshot ?? handle.serialize.serialize();
}

function rebuildWithNativeHistory(handle: TermHandle): Promise<void> {
  return new Promise((resolve) => {
    const queued = handle.writes.drain(
      "native-history-rebuild",
      () => {
        const before = handle.term.buffer.active;
        if (before.type !== "normal") {
          resolve();
          return;
        }
        const beforeBaseY = before.baseY;
        const beforeViewportY = before.viewportY;
        const wasAtBottom = beforeViewportY >= beforeBaseY;
        const previousBoundaryLine =
          handle.nativeHistoryBoundaryMarker?.line ?? -1;
        const rowsAboveBoundary = previousBoundaryLine >= 0
          ? previousBoundaryLine - beforeViewportY
          : null;
        const viewportRevision = handle.viewport.revision;
        const mouseEncoding = handle.mouseEncoding;
        const session = getState()
          .projects.flatMap((project) => project.sessions)
          .find((item) => item.id === handle.sessionId);
        const hasTerminalTail =
          handle.nativeHistoryBoundaryMarker !== null ||
          session?.lifecycle === "creating" ||
          session?.lifecycle === "running" ||
          before.baseY > 0 ||
          before.cursorY > 0 ||
          handle.logCursor !== null;
        const tailSnapshot = hasTerminalTail
          ? serializeTailAfterNativePrefix(handle)
          : "";
        handle.nativeHistoryTailSnapshot = tailSnapshot;
        handle.nativeHistoryTailDirty = false;
        handle.nativeHistoryBoundaryMarker?.dispose();
        handle.nativeHistoryBoundaryMarker = null;

        const prefix = nativeHistoryPrefix(
          handle.nativeHistoryEvents,
          handle.nativeHistorySkippedLines,
        );
        const boundary = hasTerminalTail
          ? `\r\n\x1b[2m── ${sanitizeNativeHistoryText(i18n.t("session:ui.history.returnToLive"))} ──\x1b[0m\r\n`
          : "";
        const requiredScrollback =
          before.baseY +
          handle.term.rows +
          estimateWrappedRows(prefix, handle.term.cols) +
          32;
        const currentScrollback = Number(handle.term.options.scrollback ?? 0);
        if (requiredScrollback > currentScrollback) {
          // Grow only as the user asks for older pages. This avoids paying the
          // memory cost for untouched history while preventing xterm from
          // trimming the newly prepended page immediately.
          handle.term.options.scrollback = requiredScrollback;
        }

        resetTerminal(handle);
        handle.writes.write(prefix + boundary, () => {
          if (handles.get(handle.sessionId) !== handle) return;
          handle.nativeHistoryBoundaryMarker =
            handle.term.registerMarker(-1) ?? null;
        });
        if (tailSnapshot || mouseEncoding !== "default") {
          handle.writes.write(
            tailSnapshot + mouseEncodingSequence(mouseEncoding),
          );
        }
        handle.writes.drain(
          "native-history-rebuild",
          () => {
            const after = handle.term.buffer.active;
            if (after.type === "normal") {
              if (wasAtBottom) {
                handle.viewport.restoreTail(viewportRevision);
              } else {
                const nextBoundaryLine =
                  handle.nativeHistoryBoundaryMarker?.line ?? -1;
                const anchoredLine = nextBoundaryLine >= 0
                  ? rowsAboveBoundary === null
                    ? nextBoundaryLine + 1 + beforeViewportY
                    : nextBoundaryLine - rowsAboveBoundary
                  : beforeViewportY + Math.max(0, after.baseY - beforeBaseY);
                handle.viewport.restorePrependedAnchor(
                  anchoredLine,
                  viewportRevision,
                );
              }
            }
            updateScrolledUp(handle);
            resolve();
          },
          { coalesce: false, onDiscard: resolve },
        );
      },
      { coalesce: false, onDiscard: resolve },
    );
    if (!queued) resolve();
  });
}

/** Load one older agent-native page directly into this xterm's scrollback.
 * Concurrent boundary gestures share one request; a generation fence keeps a
 * late page from rebuilding a restarted or evicted Session. */
export function loadOlderNativeHistory(sessionId: string): Promise<boolean> {
  const handle = getOrCreateHandle(sessionId);
  if (handle.nativeHistoryRequest) return handle.nativeHistoryRequest;
  if (handle.nativeHistoryCursor === null) return Promise.resolve(false);
  const generation = handle.generation;
  const cursor = handle.nativeHistoryCursor ?? null;
  let request!: Promise<boolean>;
  request = (async () => {
    try {
      const page = await api.getNativeHistory(
        sessionId,
        cursor,
        NATIVE_HISTORY_PAGE_SIZE,
      );
      if (
        handles.get(sessionId) !== handle ||
        handle.generation !== generation
      ) {
        return false;
      }
      handle.nativeHistoryCursor = page.nextCursor;
      handle.nativeHistorySkippedLines += page.skippedLines;
      if (page.sourceStatus.status !== "available") return false;
      if (page.events.length === 0) return page.nextCursor !== null;
      handle.nativeHistoryEvents = [
        ...page.events,
        ...handle.nativeHistoryEvents,
      ];
      await rebuildWithNativeHistory(handle);
      return true;
    } catch (error) {
      if (
        handles.get(sessionId) === handle &&
        handle.generation === generation
      ) {
        toast(errorText(error), "error");
      }
      return false;
    } finally {
      if (handle.nativeHistoryRequest === request) {
        handle.nativeHistoryRequest = null;
      }
    }
  })();
  handle.nativeHistoryRequest = request;
  return request;
}

const resizeTimers = new Map<string, number>();
const fitTimers = new Map<string, number>();

function scheduleFitHandle(handle: TermHandle) {
  // ResizeObserver fires per animation frame while the sidebar or the
  // window is being resized. fit() reflows the whole scrollback
  // synchronously, so running it per frame (xN panes) starves the main
  // thread — and with a transparent window the skipped paints show the
  // app behind as a ghost. Coalesce to one refit once the geometry stops
  // moving; the opaque workspace and term-host surfaces cover the brief
  // cell-geometry mismatch.
  const prev = fitTimers.get(handle.sessionId);
  if (prev !== undefined) window.clearTimeout(prev);
  fitTimers.set(
    handle.sessionId,
    window.setTimeout(() => {
      fitTimers.delete(handle.sessionId);
      if (handles.get(handle.sessionId) !== handle) return;
      fitHandle(handle, false, false, "resize-observer");
    }, 90),
  );
}

export function fitHandle(
  handle: TermHandle,
  forceRedraw = false,
  forceResize = false,
  reason = "direct",
): boolean {
  if (!handle.active) {
    handle.geometryDirty = true;
    return false;
  }
  const el = handle.container;
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) {
    handle.geometryDirty = true;
    return false;
  }
  const fitStartedAt = performance.now();
  const bufferBeforeFit = handle.term.buffer.active;
  const bufferTypeBeforeFit = bufferBeforeFit.type;
  const viewportBeforeFit = bufferBeforeFit.viewportY;
  const wasReadingScrollback =
    bufferTypeBeforeFit === "normal" &&
    viewportBeforeFit > 0 &&
    viewportBeforeFit < bufferBeforeFit.baseY;
  try {
    handle.fit.fit();
  } catch {
    return false;
  }
  handle.fitCount += 1;
  handle.lastFitReason = reason;
  handle.lastFitDurationMs = Math.max(0, performance.now() - fitStartedAt);
  handle.geometryDirty = false;
  const bufferAfterFit = handle.term.buffer.active;
  if (
    wasReadingScrollback &&
    bufferAfterFit.type === bufferTypeBeforeFit &&
    bufferAfterFit.baseY > 0 &&
    bufferAfterFit.viewportY === 0
  ) {
    // A column reflow can occasionally drop xterm's viewport to the oldest
    // row. That is never the user's intent during a passive pane/window fit.
    handle.viewport.restoreAfterFit(
      Math.min(viewportBeforeFit, bufferAfterFit.baseY),
    );
  }
  const { cols, rows } = handle.term;
  if (forceRedraw && rows > 0) {
    // A pane is hidden with display:none while another Session is active.
    // WebGL/xterm can retain a blank back buffer after that transition even
    // when the PTY and terminal buffer are still healthy. Repaint after the
    // pane is laid out again; do not clear the glyph atlas here because a
    // full-screen TUI may be processing a PTY resize at the same time.
    handle.term.refresh(0, rows - 1);
  }
  const sizeChanged = cols !== handle.lastCols || rows !== handle.lastRows;
  if (sizeChanged) {
    if (handle.nativeHistoryBoundaryMarker !== null) {
      handle.nativeHistoryTailDirty = true;
    }
    handle.lastCols = cols;
    handle.lastRows = rows;
  }
  if ((sizeChanged || forceResize) && cols > 0 && rows > 0 && handle.attached) {
    // Debounce resize IPC during window drags. The first resize after attach
    // is forced even when fit() already recorded the same dimensions before
    // the PTY channel became writable; full-screen TUIs need this redraw.
    const prev = resizeTimers.get(handle.sessionId);
    if (prev !== undefined) window.clearTimeout(prev);
    const resizeGeneration = handle.generation;
    resizeTimers.set(
      handle.sessionId,
      window.setTimeout(() => {
        resizeTimers.delete(handle.sessionId);
        if (
          handles.get(handle.sessionId) !== handle ||
          handle.generation !== resizeGeneration
        )
          return;
        const rect = handle.container?.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        const pixelWidth = Math.min(
          65535,
          Math.max(0, Math.round((rect?.width ?? 0) * scale)),
        );
        const pixelHeight = Math.min(
          65535,
          Math.max(0, Math.round((rect?.height ?? 0) * scale)),
        );
        api
          .resizePty(handle.sessionId, cols, rows, pixelWidth, pixelHeight)
          .catch(() => undefined);
      }, 100),
    );
  }
  return true;
}

/**
 * Reconcile an xterm instance after its pane becomes visible.  We force the
 * matching PTY resize here as well: a terminal can have acquired its visual
 * dimensions while it was inactive, before its attach channel became ready.
 */
export function setTerminalActive(sessionId: string, active: boolean) {
  const handle = handles.get(sessionId);
  if (handle) handle.active = active;
}

export function fitSession(sessionId: string, forceResize = false) {
  const handle = handles.get(sessionId);
  if (!handle) {
    return;
  }
  const bufferBeforeFit = handle.term.buffer.active;
  const wasFollowingTail =
    bufferBeforeFit.type === "normal" &&
    bufferBeforeFit.viewportY >= bufferBeforeFit.baseY;
  syncHandleTheme(handle);
  const fitted = fitHandle(handle, true, forceResize, "activate");
  const bufferAfterFit = handle.term.buffer.active;
  if (
    fitted &&
    wasFollowingTail &&
    bufferAfterFit.type === "normal" &&
    bufferAfterFit.baseY > 0
  ) {
    // fit() can leave xterm's buffer at the tail while its native viewport is
    // still at scrollTop=0. The first wheel event then maps that stale DOM
    // position back into the buffer and jumps to the oldest output. Reconcile
    // both layers synchronously before Session activation returns; unlike a
    // deferred repair, this cannot overwrite the user's subsequent scroll.
    handle.viewport.synchronizeTail();
  }
  if (handle.logCursor) {
    queueRenderedLogObservation(handle, handle.logCursor);
  }
}

/**
 * Inserts text into a session's terminal as if the user pasted it, e.g. a
 * dragged file reference from the project tree. Returns false when the
 * session has no live terminal to receive input.
 */
export function insertTextIntoTerminal(
  sessionId: string,
  text: string,
): boolean {
  const handle = handles.get(sessionId);
  if (!handle || !handle.attached) return false;
  try {
    // paste() does not require focus; focus afterwards so the caret is ready.
    handle.term.paste(text);
    handle.term.focus();
    return true;
  } catch {
    // A paste failure must surface to the caller instead of dying silently
    // inside the drop handler.
    return false;
  }
}

export function focusSession(sessionId: string) {
  handles.get(sessionId)?.term.focus();
}

export function noteTerminalScrollIntent(
  sessionId: string,
  mode: TerminalViewportMode = "reading",
) {
  handles.get(sessionId)?.viewport.noteUserIntent(mode);
}

export function scrollTerminalViewport(
  sessionId: string,
  command: TerminalViewportCommand,
) {
  handles.get(sessionId)?.viewport.runUserCommand(command);
}

export function scrollToBottom(sessionId: string) {
  scrollTerminalViewport(sessionId, { type: "bottom", focus: true });
}

/** Allow the next hidden-pane output to establish a fresh unread marker. */
export function clearUnreadOutputTracking(sessionId: string) {
  unreadOutputPending.delete(sessionId);
}

/** Attach (or re-attach) the backend channel and replay the log tail. */
export async function attachHandle(
  sessionId: string,
  recoveryTarget: LogCursorView | null = null,
  preserveErrorDuringAttach = false,
): Promise<void> {
  const handle = getOrCreateHandle(sessionId);
  if (handle.attached || handle.attaching) return;
  handle.attaching = true;
  const generation = ++handle.generation;
  resetRenderObservation(handle);
  const resumeFrom = recoveryTarget ? null : handle.logCursor;
  patchRuntime(sessionId, {
    attaching: true,
    replayDone: false,
    detached: false,
    ...(preserveErrorDuringAttach ? {} : { error: null, errorMessage: null }),
  });
  const channel = new Channel<ChannelMsg>();
  channel.onmessage = (msg) => {
    if (handles.get(sessionId) !== handle || generation !== handle.generation)
      return;
    onChannelMsg(handle, msg);
  };
  try {
    const info = await api.attachSession(
      sessionId,
      REPLAY_TAIL_BYTES,
      channel,
      resumeFrom,
      recoveryTarget,
    );
    if (handles.get(sessionId) !== handle || generation !== handle.generation) {
      // The backend may have completed after this renderer was evicted or
      // reattached. Its capability can remove only that late attachment.
      void api
        .detachSession(sessionId, info.attachmentId)
        .catch(() => undefined);
      return;
    }
    // A Host can exit between its handshake and the invoke reply. The channel
    // event is authoritative for this attach generation and must not be
    // overwritten by a late success response.
    const runtime = getState().runtime[sessionId];
    if (runtime?.exit || runtime?.detached || !info.childAlive) {
      handle.attached = false;
      void api
        .detachSession(sessionId, info.attachmentId)
        .catch(() => undefined);
      patchRuntime(sessionId, {
        attaching: false,
        attached: false,
        detached: !info.childAlive,
      });
      return;
    }
    handle.attachmentId = info.attachmentId;
    handle.attached = true;
    if (handle.logCursor) queueRenderedLogObservation(handle, handle.logCursor);
    // Content now arrives via replay/live stream — never tail-load on top.
    handle.historyLoaded = true;
    patchRuntime(sessionId, {
      attached: true,
      attaching: false,
      detached: false,
      hostPid: info.hostPid,
      logBytes: info.logBytes,
      error: null,
      errorMessage: null,
      exit: null,
    });
    if (info.status) {
      patchRuntime(sessionId, { status: info.status });
      patchSession(sessionId, { status: info.status });
    }
    if (info.agentSessionId) {
      patchSession(sessionId, { agentSessionId: info.agentSessionId });
    }
    // PTY size may have changed while detached. Force the first resize even
    // if the browser measured the same dimensions before attach completed.
    fitHandle(handle, true, true, "attach");
  } catch (e) {
    if (handles.get(sessionId) !== handle || generation !== handle.generation)
      return;
    const errorMessage = runtimeMessageEnvelope(e);
    patchRuntime(sessionId, {
      attaching: false,
      attached: false,
      detached: true,
      error: errorMessage ? runtimeMessageText(errorMessage) : errorText(e),
      errorMessage,
    });
  } finally {
    if (handles.get(sessionId) === handle && generation === handle.generation) {
      handle.attaching = false;
    }
  }
}

function sameRun(a: LogCursorView, b: LogCursorView): boolean {
  return a.runId === b.runId && a.runOrdinal === b.runOrdinal;
}

function isLaterRun(incoming: LogCursorView, current: LogCursorView): boolean {
  return (
    incoming.runOrdinal > current.runOrdinal ||
    (incoming.runOrdinal === current.runOrdinal &&
      incoming.runId !== current.runId)
  );
}

function renderedCursorIsNotOlder(
  candidate: LogCursorView,
  current: LogCursorView,
): boolean {
  return (
    candidate.runOrdinal > current.runOrdinal ||
    (candidate.runOrdinal === current.runOrdinal &&
      candidate.runId === current.runId &&
      (candidate.generation > current.generation ||
        (candidate.generation === current.generation &&
          candidate.offset >= current.offset)))
  );
}

/** Report only a cursor whose preceding writes have drained through xterm's
 * parser queue. If output arrives behind the queued sentinel, it schedules a
 * second sentinel instead of being acknowledged by the earlier callback. */
function queueRenderedLogObservation(
  handle: TermHandle,
  cursor: LogCursorView,
) {
  if (
    handle.pendingRenderedLogCursor === null ||
    renderedCursorIsNotOlder(cursor, handle.pendingRenderedLogCursor)
  ) {
    handle.pendingRenderedLogCursor = { ...cursor };
  }
  if (handle.writes.hasPendingDrain("render-observation")) return;

  const observed = handle.pendingRenderedLogCursor;
  if (!observed) return;
  handle.pendingRenderedLogCursor = null;
  // The coordinator boundary runs only after terminal writes queued before
  // this observation have parsed. Output queued behind it remains pending and
  // receives a second observation boundary.
  handle.writes.drain("render-observation", () => {
    const attachmentId = handle.attachmentId;
    if (
      attachmentId !== null &&
      getState().activeSessionId === handle.sessionId
    ) {
      void api
        .markSessionLogRendered(handle.sessionId, attachmentId, observed)
        .catch(() => undefined);
    }
    if (handle.pendingRenderedLogCursor) {
      queueRenderedLogObservation(handle, handle.pendingRenderedLogCursor);
    }
    scheduleTerminalSnapshot(handle);
  });
}

/** Render only the missing contiguous suffix of a Host output frame. */
function applyOutputFrame(
  handle: TermHandle,
  msg: Extract<ChannelMsg, { t: "output" }>,
) {
  const sessionId = handle.sessionId;
  const incoming = msg.cursor;
  const original = b64ToBytes(msg.data);
  let bytes = original;
  const current = handle.logCursor;

  if (current) {
    if (!sameRun(incoming, current)) {
      if (!isLaterRun(incoming, current)) return;
      // A legitimate external restart must not append its cursor space to the
      // old terminal. The next frames belong to a distinct Host run.
      resetRenderObservation(handle);
      resetNativeHistory(handle);
      resetTerminal(handle);
      handle.displayReady = false;
      handle.displayRenderPending = false;
      clearTerminalSnapshot(sessionId);
      handle.logCursor = null;
      handle.rotationNoticeShown = false;
    } else if (incoming.generation < current.generation) {
      return;
    } else if (incoming.generation === current.generation) {
      const end = incoming.offset + original.length;
      if (end <= current.offset) return; // complete replay duplicate
      if (incoming.offset > current.offset && handle.allowRecoveryGap) {
        handle.writes.write(
          `\r\n\x1b[2m── ${i18n.t("session:terminal.returnedToLatest")} ──\x1b[0m\r\n`,
        );
        handle.logCursor = { ...incoming, offset: incoming.offset };
        handle.allowRecoveryGap = false;
      } else if (incoming.offset > current.offset) {
        // This should be impossible for v2's catch-up handshake. Recover
        // explicitly instead of joining unrelated terminal bytes together.
        const attachmentId = handle.attachmentId;
        handle.generation += 1;
        resetRenderObservation(handle);
        handle.attached = false;
        handle.attaching = false;
        handle.attachmentId = null;
        resetNativeHistory(handle);
        clearTerminalForTailReplay(handle);
        clearTerminalSnapshot(sessionId);
        handle.logCursor = null;
        const errorMessage: RuntimeMessageEnvelope = {
          code: "terminal_output_gap",
        };
        patchRuntime(sessionId, {
          attached: false,
          detached: true,
          error: runtimeMessageText(errorMessage),
          errorMessage,
        });
        if (attachmentId !== null) {
          void api
            .detachSession(sessionId, attachmentId)
            .catch(() => undefined);
        }
        void attachHandle(sessionId, null, true);
        return;
      }
      if (incoming.offset < current.offset) {
        bytes = original.slice(current.offset - incoming.offset);
      }
    } else if (!handle.rotationNoticeShown) {
      handle.writes.write(
        `\r\n\x1b[2m── ${i18n.t("session:terminal.outputRotated")} ──\x1b[0m\r\n`,
      );
      handle.rotationNoticeShown = true;
    }
  }

  if (bytes.length === 0) return;
  const target = handle.recoveryTarget;
  if (
    target &&
    sameRun(target, incoming) &&
    target.generation === incoming.generation &&
    target.offset >= incoming.offset &&
    target.offset <= incoming.offset + original.length
  ) {
    const markerAt = Math.max(
      0,
      Math.min(bytes.length, target.offset - incoming.offset),
    );
    if (markerAt > 0) writeTerminalOutput(handle, bytes.slice(0, markerAt));
    const revealMarker = queueRecoveryLocationMarker(handle);
    if (markerAt < bytes.length)
      writeTerminalOutput(handle, bytes.slice(markerAt));
    revealMarker();
    handle.recoveryTarget = null;
  } else {
    writeTerminalOutput(handle, bytes);
  }
  handle.logCursor = {
    ...incoming,
    offset: incoming.offset + original.length,
  };
  queueRenderedLogObservation(handle, handle.logCursor);
  updateScrolledUp(handle);
  if (
    getState().activeSessionId !== sessionId &&
    !unreadOutputPending.has(sessionId)
  ) {
    unreadOutputPending.add(sessionId);
    void api
      .markSessionOutputUnread(sessionId, msg.offset, incoming)
      .catch(() => {
        unreadOutputPending.delete(sessionId);
      });
  }
}

function onChannelMsg(handle: TermHandle, msg: ChannelMsg) {
  const sessionId = handle.sessionId;
  switch (msg.t) {
    case "output": {
      applyOutputFrame(handle, msg);
      break;
    }
    case "transient_output": {
      writeTerminalOutput(handle, b64ToBytes(msg.data));
      updateScrolledUp(handle);
      break;
    }
    case "process_status": {
      patchRuntime(sessionId, { suspended: msg.suspended });
      break;
    }
    case "replay_done": {
      if (msg.cursor) {
        handle.logCursor = msg.cursor;
        queueRenderedLogObservation(handle, msg.cursor);
      }
      handle.allowRecoveryGap = msg.partialContext === true;
      // This marks only the replay/live transport boundary. A newly launched
      // Pi can print its first-session notice just after an empty replay, so
      // keep the first-line filter active until output actually arrives. The
      // loading state advances only when this exact parser boundary drains.
      queueReplayParsed(handle);
      break;
    }
    case "resync_required": {
      // The Host has explicitly told us that our cursor no longer maps to
      // retained bytes. Clear before its following tail replay so unrelated
      // generations can never be stitched together in xterm.
      resetRenderObservation(handle);
      resetNativeHistory(handle);
      clearTerminalForTailReplay(handle);
      handle.logCursor = null;
      handle.historyLoaded = false;
      clearTerminalSnapshot(sessionId);
      const historyMessage: RuntimeMessageEnvelope = {
        code: "terminal_resynced",
        params: { reason: msg.reason },
      };
      patchRuntime(sessionId, {
        replayDone: false,
        historyNote: runtimeMessageText(historyMessage),
        historyMessage,
      });
      break;
    }
    case "state": {
      patchRuntime(sessionId, { status: msg.event });
      patchSession(sessionId, { status: msg.event });
      if (getState().settings?.screenReaderMode) {
        const ses = getState()
          .projects.flatMap((p) => p.sessions)
          .find((x) => x.id === sessionId);
        announce(
          i18n.t("session:terminal.stateAnnouncement", {
            title: ses?.title ?? sessionId,
            state: stateLabel(msg.event.state),
          }),
        );
      }
      break;
    }
    case "agent_session": {
      patchSession(sessionId, {
        agentSessionId: msg.id,
        resumePrecision: "exact",
      });
      break;
    }
    case "heartbeat": {
      patchRuntime(sessionId, { logBytes: msg.logBytes });
      break;
    }
    case "exit": {
      finishTerminalStartupFilter(handle);
      handle.attached = false;
      handle.attachmentId = null;
      patchRuntime(sessionId, {
        attached: false,
        exit: {
          code: msg.code,
          signal: msg.signal,
          groupCleaned: msg.groupCleaned,
        },
      });
      patchSession(sessionId, {
        lifecycle: msg.reason === "user_stop" ? "stopped" : "exited",
      });
      break;
    }
    case "error": {
      const detail = runtimeMessageText(msg);
      patchRuntime(sessionId, { error: detail, errorMessage: msg });
      toast(i18n.t("session:terminal.sessionError", { detail }), "error");
      break;
    }
    case "detached": {
      const detail =
        msg.code || msg.message || msg.technicalDetail
          ? runtimeMessageText(msg)
          : null;
      handle.attached = false;
      handle.attachmentId = null;
      patchRuntime(sessionId, {
        attached: false,
        detached: true,
        error: detail,
        errorMessage: detail ? msg : null,
      });
      break;
    }
  }
}

/** Write a local separator line (used around restarts). */
export function writeMarker(sessionId: string, text: string) {
  const handle = handles.get(sessionId);
  if (handle) handle.writes.write(`\r\n\x1b[2m── ${text} ──\x1b[0m\r\n`);
}

export function resetForRestart(sessionId: string) {
  clearTerminalSnapshot(sessionId);
  const session = getState()
    .projects.flatMap((project) => project.sessions)
    .find((item) => item.id === sessionId);
  const startupPending = session?.adapter === "pi";
  const handle = handles.get(sessionId);
  if (handle) {
    handle.attached = false;
    handle.attaching = false;
    handle.generation += 1; // drop messages from the pre-restart channel
    resetRenderObservation(handle);
    // Clear the buffer: the re-attach replays the same log tail and would
    // otherwise duplicate it under the old content / loaded history.
    resetNativeHistory(handle);
    resetTerminal(handle);
    handle.displayReady = false;
    handle.displayRenderPending = false;
    handle.logCursor = null;
    handle.rotationNoticeShown = false;
    handle.allowRecoveryGap = false;
    handle.recoveryTarget = null;
    handle.historyLoaded = false;
    handle.historyLoading = false;
    if (startupPending) armPiStartupReadyTimeout(handle);
    else clearPiStartupReadyTimer(handle);
  }
  patchRuntime(sessionId, {
    attached: false,
    detached: false,
    exit: null,
    error: null,
    errorMessage: null,
    replayDone: false,
    startupPending,
    historyNote: null,
    historyMessage: null,
  });
  writeMarker(sessionId, i18n.t("session:terminal.restartMarker"));
}

/**
 * Open the precise output context selected from a recovery timeline entry.
 * Live Hosts validate and replay a bounded target window; ended Sessions use
 * the same DB generation fence through a read-only backend command.
 */
export async function jumpToRecoveryOutput(
  sessionId: string,
  cursor: LogCursorView,
): Promise<void> {
  const session = getState()
    .projects.flatMap((project) => project.sessions)
    .find((item) => item.id === sessionId);
  if (!session) throw new Error(i18n.t("session:terminal.sessionMissing"));
  const handle = getOrCreateHandle(sessionId);
  const previousAttachment = handle.attachmentId;
  handle.generation += 1;
  resetRenderObservation(handle);
  handle.attachmentId = null;
  handle.attached = false;
  handle.attaching = false;
  resetNativeHistory(handle);
  resetTerminal(handle);
  handle.displayReady = false;
  handle.displayRenderPending = false;
  clearTerminalSnapshot(sessionId);
  handle.logCursor = null;
  handle.allowRecoveryGap = false;
  handle.recoveryTarget = cursor;
  handle.historyLoaded = false;
  handle.historyLoading = false;
  if (previousAttachment !== null) {
    void api
      .detachSession(sessionId, previousAttachment)
      .catch(() => undefined);
  }
  const ended =
    session.lifecycle === "exited" ||
    session.lifecycle === "stopped" ||
    session.lifecycle === "interrupted";
  if (ended) {
    const generation = handle.generation;
    try {
      const context = await api.readRecoveryLogContext(sessionId, cursor);
      if (handles.get(sessionId) !== handle || handle.generation !== generation)
        return;
      const bytes = b64ToBytes(context.data);
      const markerAt = Math.max(
        0,
        Math.min(bytes.length, cursor.offset - context.offset),
      );
      if (markerAt > 0) writeTerminalOutput(handle, bytes.slice(0, markerAt));
      const revealMarker = queueRecoveryLocationMarker(handle);
      if (markerAt < bytes.length)
        writeTerminalOutput(handle, bytes.slice(markerAt));
      handle.recoveryTarget = null;
      finishTerminalStartupFilter(handle);
      revealMarker();
      handle.historyLoaded = true;
      handle.logCursor = { ...cursor, offset: context.offset + bytes.length };
      queueReplayParsed(handle);
      const historyMessage: RuntimeMessageEnvelope = {
        code: "terminal_located_recovery",
        params: { total: context.total },
      };
      patchRuntime(sessionId, {
        replayDone: true,
        historyNote: runtimeMessageText(historyMessage),
        historyMessage,
      });
    } catch (error) {
      if (
        handles.get(sessionId) === handle &&
        handle.generation === generation
      ) {
        const historyMessage = runtimeMessageEnvelope(error) ?? {
          code: "terminal_locate_recovery_failed",
          technicalDetail: errorText(error),
        };
        patchRuntime(sessionId, {
          replayDone: true,
          historyNote: runtimeMessageText(historyMessage),
          historyMessage,
        });
      }
      throw error;
    }
  } else {
    await attachHandle(sessionId, cursor);
  }
}

/** Apply font/a11y settings to all live terminals. */
export function applyTerminalSettings() {
  const s = getState();
  if (!s.settings) return;
  const family = cssFontFamily(s.settings.terminalFontFamily);
  for (const h of handles.values()) {
    h.term.options.fontFamily = family;
    h.term.options.fontSize = scaledTerminalFontSize(
      s.settings.terminalFontSize,
      s.termFontScale,
    );
    h.term.options.screenReaderMode = s.settings.screenReaderMode;
    fitHandle(h, false, false, "settings");
  }
}

/** Apply localizable xterm strings to existing and future terminal instances. */
export function applyTerminalLanguage() {
  const strings = {
    promptLabel: i18n.t("shell:terminal.promptLabel"),
    tooMuchOutput: i18n.t("shell:terminal.tooMuchOutput"),
  };
  if (Terminal.strings) {
    Terminal.strings.promptLabel = strings.promptLabel;
    Terminal.strings.tooMuchOutput = strings.tooMuchOutput;
  }
  for (const handle of handles.values()) {
    handle.term.textarea?.setAttribute("aria-label", strings.promptLabel);
  }
  const runtime = getState().runtime;
  const localizedRuntime = Object.fromEntries(
    Object.entries(runtime).map(([sessionId, value]) => [
      sessionId,
      {
        ...value,
        historyNote: value.historyMessage
          ? runtimeMessageText(value.historyMessage)
          : value.historyNote,
        error: value.errorMessage
          ? runtimeMessageText(value.errorMessage)
          : value.error,
      },
    ]),
  );
  setState({ runtime: localizedRuntime });
}

export function applyXtermTheme(
  theme: EffectiveTheme,
  terminalTheme: TerminalThemeId = getState().settings?.terminalTheme ?? "one",
) {
  for (const h of handles.values()) {
    syncHandleTheme(h, theme, terminalTheme);
    // xterm updates the option immediately, but an already painted canvas can
    // retain its old fill until the next PTY write. Repaint now so the terminal
    // never leaves a darker rectangle below the unified workspace header.
    h.term.refresh(0, Math.max(0, h.term.rows - 1));
  }
}

export function disposeHandle(sessionId: string) {
  const handle = handles.get(sessionId);
  if (!handle) return;
  handle.generation += 1;
  resetRenderObservation(handle);
  resetNativeHistory(handle);
  handle.attachmentId = null;
  inputCompatibilityDisposers.get(sessionId)?.();
  inputCompatibilityDisposers.delete(sessionId);
  clipboardCompatibilityDisposers.get(sessionId)?.();
  clipboardCompatibilityDisposers.delete(sessionId);
  viewportIntentDisposers.get(sessionId)?.();
  viewportIntentDisposers.delete(sessionId);
  const resizeTimer = resizeTimers.get(sessionId);
  if (resizeTimer !== undefined) {
    window.clearTimeout(resizeTimer);
    resizeTimers.delete(sessionId);
  }
  const snapshotTimer = snapshotTimers.get(sessionId);
  if (snapshotTimer !== undefined) {
    window.clearTimeout(snapshotTimer);
    snapshotTimers.delete(sessionId);
  }
  handle.resizeObserver?.disconnect();
  clearPiStartupReadyTimer(handle);
  try {
    handle.term.dispose();
  } catch {
    // already disposed
  }
  handles.delete(sessionId);
  unreadOutputPending.delete(sessionId);
}

/**
 * Release an inactive terminal's renderer and PTY attachment. The Session and
 * its persisted output are untouched; selecting it later creates a fresh
 * xterm instance and replays the configured history window.
 */
export async function releaseTerminal(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  if (!handle) return;
  // The durable cursor advances when Channel bytes enter the coordinator. Flush
  // any open DEC-2026 candidate/frame before fencing that Channel so the saved
  // checkpoint cannot claim bytes that were discarded before xterm parsed them.
  handle.writes.flushPendingOutput();
  // Reject messages already queued on the old Channel before disposing xterm.
  const releaseGeneration = ++handle.generation;
  resetRenderObservation(handle);
  const attachmentId = handle.attachmentId;
  handle.attachmentId = null;
  handle.attached = false;
  handle.attaching = false;
  // Materialize the current parser-drained checkpoint before disposing the
  // sole xterm instance. The next Session switch can paint this snapshot
  // immediately while its Host attachment catches up in the background.
  await persistTerminalSnapshotBeforeRelease(handle);
  if (attachmentId !== null) {
    try {
      await api.detachSession(sessionId, attachmentId);
    } catch {
      // The host may already have exited; local renderer cleanup is still safe.
    }
  }
  // A rapid reselect can have attached the same handle while detach was in
  // flight. Dispose only the object/generation this release actually owned.
  if (
    handles.get(sessionId) === handle &&
    handle.generation === releaseGeneration
  ) {
    disposeHandle(sessionId);
    patchRuntime(sessionId, {
      attached: false,
      attaching: false,
      detached: true,
    });
  }
}

/** Drop terminals whose session vanished from the project tree. */
export function pruneHandles() {
  const s = getState();
  const alive = new Set(s.projects.flatMap((p) => p.sessions.map((x) => x.id)));
  for (const id of [...handles.keys()]) {
    if (!alive.has(id)) disposeHandle(id);
  }
  setState({ attachedIds: s.attachedIds.filter((id) => alive.has(id)) });
}
