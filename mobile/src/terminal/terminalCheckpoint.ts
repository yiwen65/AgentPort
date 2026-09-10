import type { RunCursor } from "../features/sessions/types";

export interface TerminalScreen {
  content: string;
  cols: number;
  rows: number;
  /** An unfinished escape/UTF-8 sequence must precede the resumed byte stream. */
  pending: number[];
  state?: import("./terminalSnapshot").SnapshotState;
}
export interface TerminalCheckpoint extends TerminalScreen { cursor: RunCursor }

// Serialized screens only: no hidden xterm, subscription, or persistent log copy.
const MAX_ENTRIES = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const checkpoints = new Map<string, { value: Promise<TerminalCheckpoint | undefined>; bytes: number }>();
export const checkpointKey = (host: string, session: string) => JSON.stringify([host, session]);
export function forgetCheckpoint(key: string): void { checkpoints.delete(key); }
export function clearTerminalCheckpoints(): void { checkpoints.clear(); }
export function readCheckpoint(key: string): Promise<TerminalCheckpoint | undefined> {
  const entry = checkpoints.get(key);
  if (!entry) return Promise.resolve(undefined);
  checkpoints.delete(key); checkpoints.set(key, entry);
  return entry.value;
}
export function saveCheckpoint(key: string, value: Promise<TerminalCheckpoint | undefined>): void {
  const entry = { value: Promise.resolve(undefined) as Promise<TerminalCheckpoint | undefined>, bytes: 0 };
  entry.value = value.catch(() => undefined).then(screen => {
    if (checkpoints.get(key) !== entry) return undefined;
    if (!screen) { checkpoints.delete(key); return undefined; }
    entry.bytes = screen.content.length * 2 + screen.pending.length * 8 + JSON.stringify(screen.state ?? {}).length * 2;
    if (entry.bytes > MAX_BYTES) { checkpoints.delete(key); return undefined; }
    let bytes = [...checkpoints.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [oldKey, old] of checkpoints) {
      if (bytes <= MAX_BYTES) break;
      checkpoints.delete(oldKey); bytes -= old.bytes;
    }
    return checkpoints.get(key) === entry ? screen : undefined;
  });
  checkpoints.delete(key); checkpoints.set(key, entry);
  while (checkpoints.size > MAX_ENTRIES) checkpoints.delete(checkpoints.keys().next().value!);
}

/** Track only the parser prefix that SerializeAddon cannot represent. */
export class TerminalParserTail {
  private state: "ground" | "escape" | "csi" | "string" | "stringEscape" | "intermediate" = "ground";
  private utf8 = 0;
  private tail: number[] = [];
  private overflow = false;
  private unsafePrefix = false;
  private osc = false;
  reset(): void { this.state = "ground"; this.utf8 = 0; this.tail = []; this.overflow = false; this.unsafePrefix = false; }
  snapshot(): number[] | undefined { return this.overflow || this.unsafePrefix ? undefined : [...this.tail]; }
  advance(data: string | Uint8Array): void {
    for (const byte of typeof data === "string" ? new TextEncoder().encode(data) : data) {
      // Most terminal bytes cannot start a parser prefix. Avoid allocating two
      // arrays per ASCII byte in the Host's synchronous embedded engine.
      if (this.state === "ground" && this.utf8 === 0 && byte < 0x80 && byte !== 0x1b) continue;
      if (this.tail.length < 65536) this.tail.push(byte); else this.overflow = true;
      // Embedded C0 controls may already have moved the cursor. Never replay
      // such a prefix on top of a serialized screen that includes that effect.
      if (this.state !== "ground" && byte < 0x20 && byte !== 0x1b) this.unsafePrefix = true;
      if (this.state === "ground") {
        if (this.utf8 && byte >= 0x80 && byte <= 0xbf) this.utf8--;
        else {
          if (this.utf8) this.unsafePrefix = true;
          this.utf8 = byte >= 0xc2 && byte <= 0xdf ? 1 : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xf0 && byte <= 0xf4 ? 3 : 0;
          if (byte === 0x1b) this.state = "escape";
        }
      } else if (byte === 0x18 || byte === 0x1a) this.state = "ground";
      else if (this.state === "string") {
        if (byte === 0x1b) this.state = "stringEscape";
        else if (this.osc && byte === 7) this.state = "ground";
      } else if (this.state === "stringEscape") {
        if (byte !== 0x5c) this.unsafePrefix = true;
        this.state = byte === 0x5c ? "ground" : "string";
      }
      else if (byte === 0x1b) { this.state = "escape"; this.tail = [byte]; this.overflow = false; }
      else if (this.state === "escape") {
        if (byte === 0x5b) this.state = "csi";
        else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(byte)) { this.state = "string"; this.osc = byte === 0x5d; }
        else if (byte >= 0x20 && byte <= 0x2f) this.state = "intermediate";
        else if (byte >= 0x30) this.state = "ground";
      } else if (this.state === "csi" && byte >= 0x40 && byte <= 0x7e) this.state = "ground";
      else if (this.state === "intermediate" && byte >= 0x30 && byte <= 0x7e) this.state = "ground";
      // Reuse short prefixes instead of allocating per UTF-8/VT sequence on
      // QuickJS. Drop long strings: setting length to zero retains capacity in
      // that engine. snapshot() copies, so checkpoints never share this storage.
      if (this.state === "ground" && this.utf8 === 0) {
        if (this.tail.length > 256) this.tail = []; else this.tail.length = 0;
        this.overflow = false; this.unsafePrefix = false;
      }
    }
  }
}
