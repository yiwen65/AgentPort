export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export interface MarkdownImageData { mime: string; width: number; height: number; contentBase64: string }
export interface MarkdownImageClient {
  scope?: string;
  local(path: string): Promise<MarkdownImageData>;
  remote(url: string): Promise<MarkdownImageData>;
}
export type ImageSource = { kind: "local"; path: string } | { kind: "remote"; url: string };

export function resolveImageSource(documentPath: string, source: string): ImageSource | null {
  if (/^https:\/\//i.test(source)) {
    try { const url = new URL(source); if (url.username || url.password) return null; url.hash = ""; return { kind: "remote", url: url.href }; } catch { return null; }
  }
  let path: string;
  try { path = decodeURIComponent(source.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!path || /^[\/\\]/.test(path) || /[:\\\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = documentPath.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.length ? { kind: "local", path: parts.join("/") } : null;
}
