// Link classification for the document reader. External links keep the
// existing http(s)-only policy; workspace-relative links resolve against the
// document directory and must stay inside the document root.

import type { MarkdownLinkContext } from "./types";

export type DocumentLinkResolution =
  | { kind: "external"; href: string; domain: string }
  | { kind: "document"; path: string; line: number | null; anchor: string | null }
  | { kind: "anchor"; anchor: string }
  | { kind: "unresolved"; reason: "outside-root" | "unsupported-scheme" | "invalid-path" };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const POSITION = /^(.*?):(\d+)(?::\d+)?$/;

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function decodeAnchor(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveDocumentLink(raw: string, context: MarkdownLinkContext): DocumentLinkResolution {
  const text = raw.trim();
  if (!text) return { kind: "unresolved", reason: "invalid-path" };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return { kind: "external", href: url.href, domain: url.hostname };
    } catch {
      return { kind: "unresolved", reason: "invalid-path" };
    }
  }
  if (text.startsWith("#")) {
    const anchor = decodeAnchor(text.slice(1));
    return anchor ? { kind: "anchor", anchor } : { kind: "unresolved", reason: "invalid-path" };
  }
  if (SCHEME.test(text)) return { kind: "unresolved", reason: "unsupported-scheme" };

  let rest = text;
  let anchor: string | null = null;
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    anchor = decodeAnchor(rest.slice(hashIndex + 1)) || null;
    rest = rest.slice(0, hashIndex);
  }
  const queryIndex = rest.indexOf("?");
  if (queryIndex >= 0) rest = rest.slice(0, queryIndex);
  if (!rest || rest.startsWith("/") || /[\\\u0000-\u001f]/.test(rest)) {
    return { kind: "unresolved", reason: rest.startsWith("/") ? "outside-root" : "invalid-path" };
  }
  let relative: string;
  try {
    relative = decodeURIComponent(rest);
  } catch {
    return { kind: "unresolved", reason: "invalid-path" };
  }
  if (!relative || relative.startsWith("/") || /[\\\u0000-\u001f]/.test(relative)) {
    return { kind: "unresolved", reason: relative.startsWith("/") ? "outside-root" : "invalid-path" };
  }

  let line: number | null = null;
  const position = POSITION.exec(relative);
  if (position && position[1].length > 0) {
    const parsed = Number.parseInt(position[2], 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      line = parsed;
      relative = position[1];
    }
  }
  if (!relative) return { kind: "unresolved", reason: "invalid-path" };

  const root = normalizeAbsolute(context.rootPath);
  const directory = context.path.slice(0, context.path.lastIndexOf("/")) || "/";
  const path = normalizeAbsolute(`${directory}/${relative}`);
  if (path === root || !(root === "/" || path.startsWith(`${root}/`))) {
    return { kind: "unresolved", reason: "outside-root" };
  }
  return { kind: "document", path, line, anchor };
}

/** Workspace-relative path used when copying a heading link. */
export function relativePathInRoot(path: string, rootPath: string): string | null {
  const root = normalizeAbsolute(rootPath);
  const normalized = normalizeAbsolute(path);
  if (normalized === root) return "";
  if (root !== "/" && !normalized.startsWith(`${root}/`)) return null;
  return normalized.slice(root === "/" ? 1 : root.length + 1);
}

/** Scoped lookup: the same heading slug can exist in both split groups. */
export function scrollToAnchor(root: HTMLElement, anchor: string, behavior: ScrollBehavior = "smooth"): boolean {
  for (const node of root.querySelectorAll<HTMLElement>("[id]")) {
    if (node.id !== anchor) continue;
    node.scrollIntoView?.({ block: "start", behavior });
    return true;
  }
  return false;
}
