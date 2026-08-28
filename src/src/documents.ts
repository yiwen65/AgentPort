// Document links in terminal output (OSC 8 `file://` hyperlinks and plain
// absolute or session-relative paths) open in the in-app viewer instead of an
// external app, like clicking a file link in VSCode's terminal.

import { confirmDialog, findSession, getState, setState } from "./store";
import { i18n } from "./i18n";

export interface DocumentLinkTarget {
  path: string;
  /** One-based line from a trailing `:line[:column]` suffix. */
  line: number | null;
}

/**
 * Parses a link target into an absolute path plus an optional line number.
 * Accepts `file://` URIs, plain POSIX absolute paths, and relative paths when
 * an absolute session cwd is supplied. Returns null for web URLs, unresolved
 * relative paths, and non-local file hosts.
 */
export function parseDocumentLinkTarget(
  raw: string,
  sessionCwd?: string,
): DocumentLinkTarget | null {
  let text = raw.trim();
  if (!text) return null;

  if (/^file:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    // Only local files; a remote host would not resolve in this app.
    if (url.hostname && url.hostname !== "localhost") return null;
    try {
      text = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
    // Some other scheme (http:, vscode:, …) — not a local document.
    return null;
  }

  const relative = !text.startsWith("/");

  // Strip a trailing `:line` or `:line:column` suffix. Only digit groups are
  // treated as positions, so paths containing real colons survive.
  let line: number | null = null;
  const position = /:(\d+)(?::(\d+))?$/.exec(text);
  if (position) {
    const parsed = Number.parseInt(position[1], 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      line = parsed;
      text = text.slice(0, position.index);
    }
  }
  if (relative) {
    if (!sessionCwd?.startsWith("/")) return null;
    const segments = `${sessionCwd}/${text}`.split("/");
    const normalized: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") normalized.pop();
      else normalized.push(segment);
    }
    text = `/${normalized.join("/")}`;
  }

  if (text.length < 2) return null;
  return { path: text, line };
}

/** True when a terminal link target should open in the in-app viewer. */
export function isDocumentLinkTarget(raw: string): boolean {
  return parseDocumentLinkTarget(raw) !== null;
}

/** Lets the document panel report unsaved edits so a link click that would
 * replace the current document can ask before discarding them. */
let dirtyChecker: (() => boolean) | null = null;

export function registerDocumentDirtyChecker(checker: (() => boolean) | null): void {
  dirtyChecker = checker;
}

/** Opens a parsed target in the document viewer split. */
export function openDocumentTarget(target: DocumentLinkTarget): void {
  const open = () => setState({ openDocument: { path: target.path, line: target.line } });
  if (dirtyChecker?.() && getState().openDocument?.path !== target.path) {
    void confirmDialog({
      title: i18n.t("shell:ui.document.unsavedTitle"),
      body: i18n.t("shell:ui.document.unsavedBody"),
      confirmLabel: i18n.t("shell:ui.document.unsavedDiscard"),
      danger: true,
    }).then((ok) => {
      if (ok) open();
    });
    return;
  }
  open();
}

export function closeDocument(): void {
  setState({ openDocument: null, docPanelExpanded: false });
}

/** Toggles the VSCode-like file tree. When opening, the tree roots at the
 * active session's working directory so it always shows the project the
 * terminal is operating on. */
export function toggleExplorer(): void {
  const state = getState();
  if (state.explorerOpen) {
    setState({ explorerOpen: false });
    return;
  }
  const session = findSession(state.projects, state.activeSessionId);
  setState({
    explorerOpen: true,
    explorerRoot: session?.cwd ?? state.explorerRoot,
  });
}

export function closeExplorer(): void {
  setState({ explorerOpen: false });
}

/**
 * Fallback path candidates when the literal link target does not exist.
 * Agents print paths inside prose (`…/报告.md, 包含…`), so even with a
 * conservative link regex an OSC 8 target or an unusual match can carry
 * trailing sentence punctuation. Each candidate re-strips an exposed
 * `:line` suffix so `/a/b.md:3,` can still resolve to `/a/b.md`.
 */
export function documentPathFallbacks(path: string): string[] {
  const seen = new Set<string>([path]);
  const out: string[] = [];
  const TERMINATOR = /[，。；、！？【】《》「」『』]/u;
  const push = (candidate: string) => {
    const position = /:(\d+)(?::(\d+))?$/.exec(candidate);
    const base = position ? candidate.slice(0, position.index) : candidate;
    // A candidate still containing sentence punctuation is junk by
    // construction — skip it instead of issuing a doomed read.
    if (base.length > 1 && !seen.has(base) && !TERMINATOR.test(base)) {
      seen.add(base);
      out.push(base);
    }
  };
  // Cut at the first CJK sentence punctuation mark.
  const terminator = path.search(TERMINATOR);
  if (terminator > 0) push(path.slice(0, terminator));
  // Trim trailing junk punctuation/brackets/quotes.
  push(path.replace(/[\s,;，。；：、！？【】《》「」『』)\]}"'`]+$/u, ""));
  return out;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
