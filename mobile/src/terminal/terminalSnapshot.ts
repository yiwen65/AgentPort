/** Pinned to xterm 5.5.0. These state fields are not covered by SerializeAddon.
 * Keep the headless Host and browser restore tests in lockstep on upgrades. */
interface Attr { fg: number; bg: number; extended: { _ext: number; _urlId: number } }
interface BufferState {
  x: number; y: number; base: number; savedX: number; savedY: number;
  savedCurAttrData: Attr; savedCharset?: Record<string, string>;
  scrollTop: number; scrollBottom: number; tabs: Record<string, boolean>;
}
export interface SnapshotState {
  version: 1; normal: BufferState; alt: BufferState;
  modes: Record<string, boolean>; dec: Record<string, boolean>;
  charset: { glevel: number; _charsets: Array<Record<string, string> | null>; charset?: Record<string, string> };
  current: Attr; mouseProtocol: string; mouseEncoding: string;
}
interface InternalBuffer extends Omit<BufferState, "base"> { ybase: number }
interface Core {
  _bufferService: { buffers: { normal: InternalBuffer; alt: InternalBuffer } };
  coreService: { modes: SnapshotState["modes"]; decPrivateModes: SnapshotState["dec"] };
  coreMouseService: { activeProtocol: string; activeEncoding: string };
  _charsetService: SnapshotState["charset"];
  _inputHandler: { _curAttrData: Attr };
}
const core = (terminal: unknown) => (terminal as { _core: Core })._core;
const attr = (a: Attr): Attr => ({ fg: a.fg, bg: a.bg, extended: { _ext: a.extended._ext, _urlId: 0 } });

export function captureSnapshotState(terminal: unknown): SnapshotState {
  const c = core(terminal);
  const buffer = (b: InternalBuffer): BufferState => ({ x: b.x, y: b.y, base: b.ybase,
    savedX: b.savedX, savedY: b.savedY, savedCurAttrData: attr(b.savedCurAttrData),
    savedCharset: b.savedCharset, scrollTop: b.scrollTop, scrollBottom: b.scrollBottom, tabs: b.tabs });
  return JSON.parse(JSON.stringify({ version: 1, normal: buffer(c._bufferService.buffers.normal),
    alt: buffer(c._bufferService.buffers.alt), modes: c.coreService.modes, dec: c.coreService.decPrivateModes,
    charset: c._charsetService, current: attr(c._inputHandler._curAttrData),
    mouseProtocol: c.coreMouseService.activeProtocol, mouseEncoding: c.coreMouseService.activeEncoding }));
}

/** Reject malformed/version-mismatched snapshots before touching the live buffer. */
export function isTerminalSnapshot(value: unknown): value is import("./terminalCheckpoint").TerminalScreen & { state: SnapshotState } {
  if (!value || typeof value !== "object") return false;
  const s = value as import("./terminalCheckpoint").TerminalScreen;
  const integer = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
  if (!integer(s.cols, 1000) || !integer(s.rows, 1000) || s.cols < 2 || s.rows < 1
    || typeof s.content !== "string" || s.content.length > 2 * 1024 * 1024
    || !Array.isArray(s.pending) || s.pending.length > 65536 || !s.pending.every(b => integer(b, 255))) return false;
  const state = s.state;
  if (!state || state.version !== 1) return false;
  const attributes = (a: Attr) => a && Number.isInteger(a.fg) && Number.isInteger(a.bg) && a.extended && Number.isInteger(a.extended._ext);
  for (const b of [state.normal, state.alt]) {
    if (!b || !integer(b.x, s.cols) || !integer(b.y, s.rows - 1) || !integer(b.base, 100000)
      || !integer(b.savedX, 100000) || !integer(b.savedY, 100000) || !attributes(b.savedCurAttrData)
      || !integer(b.scrollTop, s.rows - 1) || !integer(b.scrollBottom, s.rows - 1)
      || b.scrollTop > b.scrollBottom || !b.tabs || typeof b.tabs !== "object") return false;
  }
  return !!(attributes(state.current) && state.modes && state.dec && state.charset
    && integer(state.charset.glevel, 3) && Array.isArray(state.charset._charsets)
    && ["NONE", "X10", "VT200", "DRAG", "ANY"].includes(state.mouseProtocol)
    && ["DEFAULT", "SGR", "SGR_PIXELS"].includes(state.mouseEncoding));
}

export function restoreSnapshotState(terminal: unknown, state: SnapshotState): void {
  if (state.version !== 1) throw new Error("Unsupported terminal snapshot version");
  const c = core(terminal);
  const applyAttr = (a: Attr, value: Attr) => { a.fg = value.fg; a.bg = value.bg; a.extended._ext = value.extended._ext; a.extended._urlId = 0; };
  const buffer = (b: InternalBuffer, value: BufferState) => {
    b.x = value.x; b.y = value.y; b.savedX = value.savedX;
    b.savedY = Math.max(0, value.savedY - value.base + b.ybase);
    applyAttr(b.savedCurAttrData, value.savedCurAttrData);
    b.savedCharset = value.savedCharset; b.scrollTop = value.scrollTop; b.scrollBottom = value.scrollBottom;
    b.tabs = Object.fromEntries(Object.entries(value.tabs));
  };
  buffer(c._bufferService.buffers.normal, state.normal); buffer(c._bufferService.buffers.alt, state.alt);
  // Assign known keys only, not arbitrary untrusted object properties.
  for (const key of Object.keys(c.coreService.modes)) if (key in state.modes) c.coreService.modes[key] = state.modes[key];
  for (const key of Object.keys(c.coreService.decPrivateModes)) if (key in state.dec) c.coreService.decPrivateModes[key] = state.dec[key];
  c._charsetService.glevel = state.charset.glevel;
  c._charsetService._charsets = state.charset._charsets;
  c._charsetService.charset = state.charset.charset;
  applyAttr(c._inputHandler._curAttrData, state.current);
  c.coreMouseService.activeProtocol = state.mouseProtocol;
  c.coreMouseService.activeEncoding = state.mouseEncoding;
}
