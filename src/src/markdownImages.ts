// Desktop-owned Markdown image transport and per-document resource lifetime.
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { b64ToBytes, bytesToB64, errorText } from "./api";
const describeImageError = (error: unknown) => error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : errorText(error);
import type { DeviceContext } from "./deviceContext";
import { remoteBackendFor } from "./remote/runtime";
import { LOCAL_SVG_REFERENCE, reduceStaticSvgStyles, validateStaticSvgUseGraph } from "./markdownSvg";

// Isolate sanitizer configuration/hooks from Mermaid and other consumers.
const imagePurifier = DOMPurify(window);

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 256 * 1024;
export interface MarkdownImageContext { path: string; rootPath: string; device: DeviceContext }
export interface ValidatedMarkdownImage { mime: string; width: number; height: number; contentBase64: string }
interface ImageOpen { downloadId: string; sizeBytes: number; chunkBytes: number }
interface ImageChunk { offset: number; contentBase64: string; eof: boolean }
export interface ImageTransport {
  open(rootPath: string, path: string): Promise<ImageOpen>;
  chunk(downloadId: string, offset: number, maxBytes: number): Promise<ImageChunk>;
  finish(downloadId: string): Promise<unknown>;
  close(downloadId: string): Promise<unknown>;
  fetch(url: string): Promise<ValidatedMarkdownImage>;
  validate(contentBase64: string): Promise<ValidatedMarkdownImage>;
}

export function imageTransport(device: DeviceContext): ImageTransport {
  // Resolve the backend ONCE. A later device switch cannot retarget a stream.
  const backend = device.kind === "remote" ? remoteBackendFor(device.deviceId) : null;
  return {
    open: (rootPath, path) => backend ? backend.documentImageOpen(rootPath, path) : invoke("document_image_open", { rootPath, path }),
    chunk: (downloadId, offset, maxBytes) => backend ? backend.documentImageChunk(downloadId, offset, maxBytes) : invoke("document_image_chunk", { downloadId, offset }),
    finish: (downloadId) => backend ? backend.documentImageFinish(downloadId) : invoke("document_image_finish", { downloadId }),
    close: (downloadId) => backend ? backend.documentImageClose(downloadId) : invoke("document_image_close", { downloadId }),
    // Even a remote-host document fetches public URLs on the READING device.
    fetch: (url) => invoke("markdown_image_fetch", { url }),
    validate: (contentBase64) => invoke("markdown_image_validate", { contentBase64 }),
  };
}

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function resolveMarkdownImage(source: string, context: MarkdownImageContext): { kind: "remote" | "local"; path: string } {
  if (/^https:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password || /^https:\/\/[^/?#]*@/i.test(source)) throw new Error("Only anonymous public HTTPS images are supported");
    url.hash = "";
    return { kind: "remote", path: url.href };
  }
  let relative: string;
  try { relative = decodeURIComponent(source.split(/[?#]/, 1)[0]); } catch { throw new Error("Invalid image path"); }
  if (!relative || /^[\\/]/.test(relative) || /^[a-z][a-z\d+.-]*:/i.test(relative) || /[\\\u0000-\u001f]/.test(relative)) throw new Error("Image source must be a root-contained relative path or public HTTPS URL");
  const root = normalizeAbsolute(context.rootPath);
  const directory = context.path.slice(0, context.path.lastIndexOf("/")) || "/";
  const path = normalizeAbsolute(`${directory}/${relative}`);
  if (!(path.startsWith(`${root === "/" ? "" : root}/`)) || path === root) throw new Error("Image is outside the document root");
  return { kind: "local", path: path.slice(root.length + (root === "/" ? 0 : 1)) };
}

/** SVG never reaches img decoding before both native validation and this
 * strict static allowlist. Safe styles become presentation attributes; escaped
 * CSS is rejected. Local use references have bounded expansion/cycle checks.
 * No embedded raster images, links, animation, script or foreignObject. */
export function sanitizeMarkdownSvg(source: string, width?: number, height?: number): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("SVG declarations are not supported");
  const xml = new DOMParser().parseFromString(source, "image/svg+xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "svg") throw new Error("Invalid SVG");
  reduceStaticSvgStyles(xml);
  for (const use of xml.querySelectorAll("use")) {
    if (!use.hasAttribute("href") && use.hasAttribute("xlink:href")) use.setAttribute("href", use.getAttribute("xlink:href")!);
    use.removeAttribute("xlink:href");
  }
  const clean = imagePurifier.sanitize(new XMLSerializer().serializeToString(xml.documentElement), {
    ALLOWED_TAGS: ["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "use", "symbol"],
    ALLOWED_ATTR: ["color", "xmlns", "viewBox", "width", "height", "id", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "clip-path", "clip-rule", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "dx", "dy", "href", "font-style", "letter-spacing", "word-spacing", "display", "visibility"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const result = new DOMParser().parseFromString(clean, "image/svg+xml");
  if (result.querySelector("parsererror") || result.documentElement.localName !== "svg") throw new Error("Invalid sanitized SVG");
  for (const node of [result.documentElement, ...result.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const value = attr.value.trim();
      if (attr.localName === "href" && (node.localName !== "use" || !/^#[a-zA-Z_][\w.-]*$/.test(value)) || /url\s*\(/i.test(value) && !LOCAL_SVG_REFERENCE.test(value) || /[\\]|(?:https?:|data:|file:|\/\/)/i.test(value)) node.removeAttributeNode(attr);
    }
  }
  validateStaticSvgUseGraph(result);
  if (width !== undefined && height !== undefined) {
    result.documentElement.setAttribute("width", String(width));
    result.documentElement.setAttribute("height", String(height));
    result.documentElement.setAttribute("style", `width:${width}px;height:${height}px;overflow:hidden`);
  }
  return new XMLSerializer().serializeToString(result.documentElement);
}

export async function readLocalMarkdownImage(transport: ImageTransport, rootPath: string, path: string, alive: () => boolean = () => true): Promise<ValidatedMarkdownImage> {
  const opened = await transport.open(rootPath, path);
  try {
    if (!alive()) throw new Error("Document image reading ended");
    if (!Number.isSafeInteger(opened.sizeBytes) || opened.sizeBytes <= 0) throw new Error("Image is empty or has invalid metadata");
    if (opened.sizeBytes > IMAGE_MAX_BYTES) throw new Error("Image exceeds the 20 MiB size limit");
    const bytes = new Uint8Array(opened.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await transport.chunk(opened.downloadId, offset, IMAGE_CHUNK_BYTES);
      if (!alive()) throw new Error("Document image reading ended");
      if (typeof chunk.contentBase64 !== "string" || chunk.contentBase64.length > Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4) throw new Error("Invalid image stream chunk");
      const data = b64ToBytes(chunk.contentBase64);
      if (chunk.offset !== offset || !data.length || data.length > IMAGE_CHUNK_BYTES || offset + data.length > bytes.length) throw new Error("Invalid image stream chunk");
      bytes.set(data, offset); offset += data.length;
      if (chunk.eof !== (offset === bytes.length)) throw new Error("Invalid image stream end");
    }
    // Mutation check precedes validation/decoding. Always close, even on failure.
    await transport.finish(opened.downloadId);
    return await transport.validate(bytesToB64(bytes));
  } finally { await transport.close(opened.downloadId).catch(() => {}); }
}

export type ImageState = { status: "idle" | "loading" | "blocked" | "error"; error?: string } | { status: "ready"; url: string; width: number; height: number };
const IDLE: ImageState = { status: "idle" };
export class MarkdownImageSession {
  private entries = new Map<string, ImageState>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private activeLoads = 0;
  private pendingLoads: Array<(proceed: boolean) => void> = [];
  private acquire(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.activeLoads < 2) { this.activeLoads++; return Promise.resolve(true); }
    return new Promise((resolve) => this.pendingLoads.push(resolve));
  }
  private complete() {
    const next = this.pendingLoads.shift();
    if (next && !this.disposed) next(true); else this.activeLoads--;
  }
  private sizes = new Map<string, number>();
  private visible = new Map<string, number>();
  retain(source: string) { this.visible.set(source, (this.visible.get(source) ?? 0) + 1); }
  release(source: string) { this.visible.set(source, Math.max(0, (this.visible.get(source) ?? 0) - 1)); }
  private reserve(size: number) {
    let retained = [...this.sizes.values()].reduce((a, b) => a + b, 0);
    for (const [source, state] of this.entries) {
      if (retained + size <= 64 * 1024 * 1024) break;
      if (state.status !== "ready" || (this.visible.get(source) ?? 0) > 0) continue;
      URL.revokeObjectURL(state.url); retained -= this.sizes.get(source) ?? 0;
      this.sizes.delete(source); this.entries.delete(source);
    }
    if (retained + size > 64 * 1024 * 1024) throw new Error("Document image cache limit reached; retry after other images leave view");
  }
  consent = false;
  constructor(readonly context: MarkdownImageContext, private transport: ImageTransport = imageTransport(context.device)) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (source: string): ImageState => this.entries.get(source) ?? IDLE;
  private emit() { for (const listener of this.listeners) listener(); }
  allowRemote() { if (this.disposed) return; this.consent = true; for (const [source, state] of this.entries) if (state.status === "blocked") this.entries.delete(source); this.emit(); }
  async load(source: string, retry = false): Promise<void> {
    if (this.disposed) return;
    const current = this.snapshot(source);
    if (current.status === "loading" || current.status === "ready" || current.status === "error" && !retry) return;
    let resolved: ReturnType<typeof resolveMarkdownImage>;
    try { resolved = resolveMarkdownImage(source, this.context); } catch (error) { this.entries.set(source, { status: "error", error: describeImageError(error) }); this.emit(); return; }
    if (resolved.kind === "remote" && !this.consent) { this.entries.set(source, { status: "blocked" }); this.emit(); return; }
    this.entries.set(source, { status: "loading" }); this.emit();
    if (!await this.acquire()) return;
    try {
      if (this.disposed) return;
      const image = resolved.kind === "remote" ? await this.transport.fetch(resolved.path) : await readLocalMarkdownImage(this.transport, this.context.rootPath, resolved.path, () => !this.disposed);
      if (this.disposed) return;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(image.mime) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 || !Number.isFinite(image.width * image.height) || image.width * image.height > 20_000_000) throw new Error("Unsupported image or image exceeds the 20 million pixel limit");
      if (typeof image.contentBase64 !== "string" || image.contentBase64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) throw new Error("Image exceeds the 20 MiB size limit");
      let bytes = b64ToBytes(image.contentBase64);
      if (bytes.length > IMAGE_MAX_BYTES) throw new Error("Image exceeds the 20 MiB size limit");
      if (image.mime === "image/svg+xml") bytes = new TextEncoder().encode(sanitizeMarkdownSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes), image.width, image.height));
      this.reserve(bytes.length);
      const url = URL.createObjectURL(new Blob([bytes], { type: image.mime }));
      this.sizes.set(source, bytes.length);
      this.entries.set(source, { status: "ready", url, width: image.width, height: image.height });
    } catch (error) { if (!this.disposed) this.entries.set(source, { status: "error", error: describeImageError(error) }); }
    finally { this.complete(); }
    if (!this.disposed) this.emit();
  }
  decodeFailed(source: string) {
    const state = this.entries.get(source);
    if (state?.status === "ready") URL.revokeObjectURL(state.url);
    this.sizes.delete(source);
    this.entries.set(source, { status: "error", error: "Image could not be decoded" }); this.emit();
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.pendingLoads) pending(false);
    this.pendingLoads = [];
    for (const state of this.entries.values()) if (state.status === "ready") URL.revokeObjectURL(state.url);
    this.entries.clear(); this.sizes.clear(); this.visible.clear(); this.listeners.clear();
  }
}
