const MAX_STARTUP_NOTICE_BYTES = 1024;

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function stripSgr(bytes: Uint8Array): Uint8Array | null {
  const plain: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x1b) {
      plain.push(bytes[index]);
      continue;
    }
    if (bytes[index + 1] !== 0x5b) return null;
    let end = index + 2;
    while (end < bytes.length && (bytes[end] < 0x40 || bytes[end] > 0x7e)) end += 1;
    if (end === bytes.length || bytes[end] !== 0x6d) return null;
    index = end;
  }
  return new Uint8Array(plain);
}

function isInitialSessionNotice(bytes: Uint8Array, nativeSessionId: string): boolean {
  const plain = stripSgr(bytes);
  if (!plain) return false;
  let end = plain.length;
  while (end > 0 && (plain[end - 1] === 0x0a || plain[end - 1] === 0x0d)) end -= 1;
  const text = new TextDecoder().decode(plain.slice(0, end));
  return text === `Warning: No project session found with id '${nativeSessionId}'; creating a new session with that id.`;
}

/**
 * Pi writes this benign first-private-session notice before its TUI starts.
 * Buffer only the first line so fragmented PTY/log frames are treated exactly
 * like one contiguous terminal write; all other bytes pass through unchanged.
 */
export class PiStartupNoticeFilter {
  private pending = new Uint8Array();
  private decided = false;

  constructor(private readonly nativeSessionId: string) {}

  feed(chunk: Uint8Array): Uint8Array {
    if (this.decided) return chunk;
    this.pending = concatBytes(this.pending, chunk);
    const lineEnd = this.pending.indexOf(0x0a);
    if (lineEnd === -1 && this.pending.length <= MAX_STARTUP_NOTICE_BYTES) return new Uint8Array();

    this.decided = true;
    if (lineEnd !== -1) {
      const line = this.pending.slice(0, lineEnd + 1);
      const remainder = this.pending.slice(lineEnd + 1);
      this.pending = new Uint8Array();
      return isInitialSessionNotice(line, this.nativeSessionId)
        ? remainder
        : concatBytes(line, remainder);
    }

    const pending = this.pending;
    this.pending = new Uint8Array();
    return pending;
  }

  finish(): Uint8Array {
    if (this.decided) return new Uint8Array();
    this.decided = true;
    const pending = this.pending;
    this.pending = new Uint8Array();
    return isInitialSessionNotice(pending, this.nativeSessionId)
      ? new Uint8Array()
      : pending;
  }
}
