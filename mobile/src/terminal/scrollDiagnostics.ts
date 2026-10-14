// Timing/counts only. Callers must supply only known labels and numeric metadata,
// never terminal text, user input, or session/host identifiers.
export const SCROLL_DIAGNOSTICS_ENABLED = import.meta.env?.VITE_SCROLL_DIAGNOSTICS === "1";

const phases = ["gesture", "input", "submissionReleased", "outputReceived", "queuedWrite", "parsed", "render", "resize", "wheelFlush", "wheelOutside", "syncBegin", "syncEnd", "terminalInput", "paintBlocked", "inputCorrelation", "inputAck", "inputFailed"] as const;
export type Phase = typeof phases[number];
type Metadata = Record<string, string | number | boolean>;
type RecordEntry = [number, number, number];
export type ScrollDiagnostics = {
  begin(metadata: Metadata): boolean;
  mark(phase: Phase, units?: number): void;
  frame(): void;
  finish(): void;
  dispose(): void;
  readonly running: boolean;
};

type Options = {
  clock(): number;
  schedule(callback: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  emit(event: string, detail: Record<string, unknown>): void;
  windowMs?: number;
  maxEvents?: number;
};

let traceSequence = 0;
const MAX_LINE = 550;
const MAX_FRAMES = 4096;
const round = (value: number) => Math.round(value * 10) / 10;
const boundedNumber = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)) : 0;

export function createScrollDiagnostics(options: Options): ScrollDiagnostics {
  const maxEvents = Math.min(4096, Math.max(0, Math.floor(options.maxEvents ?? 1024)));
  let started = false;
  let running = false;
  let timer: unknown;
  let timerPending = false;
  let origin = 0;
  let lastTime = 0;
  let lastFrame: number | undefined;
  let traceId = "";
  let metadata: Metadata = {};
  const records: RecordEntry[] = [];
  const frames: number[] = [];
  const counts = phases.map(() => 0);
  const units = phases.map(() => 0);
  let droppedEvents = 0;
  let droppedFrames = 0;

  // Clamp clock regressions and keep all exported times relative to begin().
  const elapsed = () => {
    lastTime = Math.max(lastTime, boundedNumber(options.clock() - origin));
    return lastTime;
  };
  const emit = (event: string, detail: Record<string, unknown>) => {
    try { options.emit(event, detail); } catch { /* Diagnostics must not break the stream. */ }
  };
  const fits = (event: string, detail: Record<string, unknown>) => event.length + 1 + JSON.stringify(detail).length <= MAX_LINE;
  const cancelTimer = () => {
    if (timerPending) { timerPending = false; options.cancel(timer); }
  };
  const clear = () => { records.length = 0; frames.length = 0; metadata = {}; };

  const mark = (phase: Phase, amount = 1) => {
    if (!running) return;
    const id = phases.indexOf(phase);
    if (id < 0) return;
    const value = boundedNumber(amount);
    counts[id]++;
    units[id] = Math.min(Number.MAX_SAFE_INTEGER, units[id] + value);
    const time = round(elapsed());
    if (records.length < maxEvents) records.push([time, id, value]);
    else droppedEvents++;
  };
  const finish = () => {
    if (!running) return;
    const durationMs = round(elapsed());
    running = false;
    cancelTimer();
    // Metadata is bounded independently of event storage. Truncate by encoded
    // length, not character count (control characters expand when JSON encoded).
    emit("scroll_diag_meta", { traceId, clock: "relative_ms" });
    for (const [name, value] of Object.entries(metadata)) {
      emit("scroll_diag_meta", { traceId, metadata: { [name]: value } });
    }
    frames.sort((a, b) => a - b);
    const percentile = (p: number) => frames.length ? round(frames[Math.ceil(frames.length * p) - 1]) : 0;
    emit("scroll_diag_summary", {
      traceId, durationMs, events: records.length, droppedEvents,
      frames: { count: frames.length, dropped: droppedFrames, p50: percentile(0.5), p95: percentile(0.95), max: frames.length ? round(frames[frames.length - 1]) : 0,
        over25: frames.filter(value => value > 25).length, over50: frames.filter(value => value > 50).length },
    });
    // Fixed phase IDs are also emitted as a dictionary for decoding chunks.
    phases.forEach((phase, id) => emit("scroll_diag_phase", { traceId, id, phase, count: counts[id], units: units[id] }));
    let chunk: RecordEntry[] = [];
    let index = 0;
    const flush = () => {
      if (chunk.length) emit("scroll_diag_chunk", { traceId, index: index++, records: chunk });
      chunk = [];
    };
    for (const record of records) {
      if (chunk.length === 16 || !fits("scroll_diag_chunk", { traceId, index, records: [...chunk, record] })) flush();
      chunk.push(record);
    }
    flush();
    clear();
  };

  return {
    get running() { return running; },
    begin(data) {
      if (started) return false;
      started = true;
      running = true;
      traceId = `${(++traceSequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      origin = options.clock();
      metadata = Object.create(null) as Metadata;
      for (const [key, value] of Object.entries(data).slice(0, 32)) {
        let name = key.slice(0, 48);
        while (JSON.stringify(name).length > 64) name = name.slice(0, -1);
        let safeValue = typeof value === "number" && !Number.isFinite(value) ? 0 : value;
        if (typeof safeValue === "string") {
          safeValue = safeValue.slice(0, 128);
          while (JSON.stringify(safeValue).length > 160) safeValue = safeValue.slice(0, -1);
        }
        metadata[name] = safeValue;
      }
      mark("gesture");
      timerPending = true;
      timer = options.schedule(finish, options.windowMs ?? 15_000);
      return true;
    },
    mark,
    frame() {
      if (!running) return;
      const time = elapsed();
      if (lastFrame !== undefined) {
        if (frames.length < MAX_FRAMES) frames.push(time - lastFrame);
        else droppedFrames++;
      }
      lastFrame = time;
    },
    finish,
    dispose() {
      started = true;
      running = false;
      cancelTimer();
      clear();
    },
  };
}
