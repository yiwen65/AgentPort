// Drag & drop of project-tree entries into a session terminal. The tree
// marks rows draggable with a small JSON payload; dropping onto a terminal
// pane inserts a reference the agent understands (`@/abs/path`), or a plain
// shell-quoted path for shell sessions.

import { insertTextIntoTerminal } from "./terminals";
import { i18n } from "./i18n";
import { toast } from "./store";

export const TREE_DND_MIME = "application/x-agentport-tree-entry";

export interface TreeDragPayload {
  path: string;
  isDir: boolean;
}

export function writeDragPayload(dt: DataTransfer, payload: TreeDragPayload): void {
  dt.setData(TREE_DND_MIME, JSON.stringify(payload));
  // Plain-text fallback so drags also work into external apps.
  dt.setData("text/plain", payload.path);
  // Present the entry as a real file as well: native terminals (Ghostty,
  // iTerm2, Terminal.app) accept *file* drops but may ignore plain text.
  try {
    const name = payload.path.split("/").pop() ?? payload.path;
    dt.setData(
      "DownloadURL",
      `application/octet-stream:${name}:file://${encodeURI(payload.path)}`,
    );
  } catch {
    // Older WebKit may reject DownloadURL; the text/plain fallback remains.
  }
  dt.effectAllowed = "copy";
}

export function readDragPayload(dt: DataTransfer): TreeDragPayload | null {
  const raw = dt.getData(TREE_DND_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TreeDragPayload>;
      if (typeof parsed.path === "string" && parsed.path.startsWith("/")) {
        return { path: parsed.path, isDir: parsed.isDir === true };
      }
    } catch {
      // fall through to the text/plain fallback
    }
  }
  for (const file of Array.from(dt.files ?? [])) {
    const path = (file as File & { path?: string }).path;
    if (typeof path === "string" && path.startsWith("/")) {
      return { path, isDir: file.type === "" };
    }
  }
  const uriList = dt.getData("text/uri-list");
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "file:") {
        const path = decodeURIComponent(url.pathname);
        if (path.startsWith("/")) return { path, isDir: false };
      }
    } catch {
      // Continue to the validated plain-text fallback below.
    }
  }
  // Fallback: a dragged text snippet that is itself an absolute path (e.g.
  // selected text from the terminal or another app).
  const text = dt.getData("text/plain").trim();
  if (text.startsWith("/") && !text.includes("\n")) {
    return { path: text, isDir: false };
  }
  return null;
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Formats the text inserted into the terminal. Agent adapters (Claude Code,
 * Codex, Kimi, Qoder, …) treat `@path` as a file reference; plain shells get
 * a whitespace-safe quoted path. A trailing space keeps the caret ready for
 * the rest of the prompt.
 */
export function formatTerminalReference(path: string, isDir: boolean, adapter: string): string {
  void isDir;
  if (adapter === "shell") {
    return /[\s']/.test(path) ? `${shellQuote(path)} ` : `${path} `;
  }
  const reference = `@${path}`;
  return /\s/.test(path) ? `${shellQuote(reference)} ` : `${reference} `;
}

/**
 * During dragover the payload content is protected — only `types` is
 * readable, and in some WebKit builds it is a DOMStringList without
 * `.includes` (only `.contains`). Normalize defensively: a throw here would
 * silently veto every drop. Accept tree payloads and any plain-text drag;
 * the drop handler still validates that the text is really an absolute path.
 */
export function dragTypes(dt: DataTransfer): string[] {
  return Array.from(dt.types ?? []);
}

export function hasTreeDragPayload(dt: DataTransfer): boolean {
  const types = dragTypes(dt);
  return types.includes(TREE_DND_MIME)
    || types.includes("text/plain")
    || types.includes("text/uri-list")
    || types.includes("Files");
}

/**
 * File/URI/tree drops must be owned by AgentPort even if WebKit withholds the
 * path until `drop` (or withholds it entirely). Otherwise the browser default
 * navigates the WebView to the image/PDF and replaces the app chrome.
 */
export function mustHandleTerminalDrop(dt: DataTransfer): boolean {
  const types = dragTypes(dt);
  return types.includes(TREE_DND_MIME)
    || types.includes("text/uri-list")
    || types.includes("Files");
}

/** Inserts a dropped tree entry into the terminal as an agent reference. */
export function dropTreeEntryIntoTerminal(
  sessionId: string,
  adapter: string,
  payload: TreeDragPayload,
): boolean {
  const text = formatTerminalReference(payload.path, payload.isDir, adapter);
  if (!insertTextIntoTerminal(sessionId, text)) {
    toast(i18n.t("shell:ui.document.dropFailed"), "error");
    return false;
  }
  return true;
}

/** One-based line range covering [start, end) character offsets. */
export function computeLineRange(
  content: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  const startLine = content.slice(0, start).split("\n").length;
  let endLine = content.slice(0, end).split("\n").length;
  // A selection that ends right after a newline visually ends on the
  // previous line.
  if (end > start && content[end - 1] === "\n") endLine -= 1;
  return { startLine, endLine };
}

/**
 * Builds the reference text for a document selection: an `@path:Lx[-Ly]`
 * locator in Claude Code's documented `#start-end` line-range form, followed
 * by the selected text, so the agent sees both the source and the exact
 * content. Shell sessions get the single-line locator only — a multi-line
 * paste would execute commands there.
 */
export function formatSelectionReference(opts: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  // Reference-only: the agent opens the file itself, so quoting never pastes
  // the selected text. `@path:10-12` for a range, `@path:10` for one line,
  // bare `@path` when the selection has no line info (preview).
  const location = opts.startLine
    ? `:${opts.startLine}${
        opts.endLine && opts.endLine !== opts.startLine ? `-${opts.endLine}` : ""
      }`
    : "";
  return `@${opts.path}${location} `;
}
