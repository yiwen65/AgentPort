import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { resolveImageSource, type ImageSource, type MarkdownImageClient } from "../../protocol/markdownImageClient";
import { createImageAsset, type ImageAsset } from "./markdownImageAssets";
import { MarkdownImageViewer } from "./MarkdownImageViewer";
import "./markdown-images.css";

interface Entry { users: number; asset?: ImageAsset; promise: Promise<ImageAsset> }
interface Images {
  allowed: boolean; grant: () => void;
  acquire: (source: ImageSource) => { promise: Promise<ImageAsset>; release: () => void };
  retry: (source: ImageSource) => void;
  path: string;
}
const Context = createContext<Images | null>(null);
const CACHE_BYTES = 64 * 1024 * 1024;
const sourceKey = (source: ImageSource) => source.kind === "local" ? `local:${source.path}` : source.url;

export function MarkdownImageProvider({ path, client, children }: { path: string; client: MarkdownImageClient; children: ReactNode }) {
  const [allowed, setAllowed] = useState(false);
  const cache = useRef(new Map<string, Entry>());
  const alive = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const entry of cache.current.values()) if (entry.asset) URL.revokeObjectURL(entry.asset.url); cache.current.clear(); };
  }, []);
  const manager = useMemo<Omit<Images, "allowed" | "grant">>(() => ({ path,
    retry: source => { const key = sourceKey(source); const entry = cache.current.get(key); if (entry?.asset) URL.revokeObjectURL(entry.asset.url); cache.current.delete(key); },
    acquire: source => {
      const key = sourceKey(source);
      let entry = cache.current.get(key);
      if (!entry) {
        const fresh: Entry = { users: 0, promise: Promise.resolve(undefined as unknown as ImageAsset) };
        const work = queue.current.then(async () => {
          if (!alive.current || !fresh.users) throw { code: "image_cancelled" };
          const data = await (source.kind === "local" ? client.local(source.path) : client.remote(source.url));
          if (!alive.current || !fresh.users) throw { code: "image_cancelled" };
          const required = Math.ceil(data.contentBase64.length * 3 / 4);
          let used = [...cache.current.values()].reduce((sum, item) => sum + (item.asset?.bytes ?? 0), 0);
          for (const [oldKey, old] of cache.current) {
            if (used + required <= CACHE_BYTES) break;
            if (!old.users && old.asset) { URL.revokeObjectURL(old.asset.url); used -= old.asset.bytes; cache.current.delete(oldKey); }
          }
          if (used + required > CACHE_BYTES) throw { code: "image_cache_full" };
          const asset = createImageAsset(data); fresh.asset = asset; return asset;
        });
        fresh.promise = work; queue.current = work.catch(() => undefined); cache.current.set(key, fresh); entry = fresh;
        void work.catch(() => { if (cache.current.get(key) === fresh) cache.current.delete(key); });
      }
      entry.users++; let released = false;
      return { promise: entry.promise, release: () => { if (!released) { released = true; entry!.users--; } } };
    },
  }), [client, path]);
  return <Context.Provider value={{ ...manager, allowed, grant: () => setAllowed(true) }}>{children}</Context.Provider>;
}

const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "image_failed";
export function MarkdownImage({ source, alt = "" }: { source: string; alt?: string }) {
  const { t } = useTranslation(); const context = useContext(Context);
  const host = useRef<HTMLSpanElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(() => !globalThis.IntersectionObserver);
  const [asset, setAsset] = useState<ImageAsset>();
  const [shape, setShape] = useState<{ width: number; height: number }>();
  const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0); const [viewer, setViewer] = useState(false);
  const resolved = useMemo(() => context ? resolveImageSource(context.path, source) : null, [context?.path, source]);
  const ready = resolved && (resolved.kind === "local" || context?.allowed);
  const wanted = visible || viewer;
  useEffect(() => {
    if (!host.current || !globalThis.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => { setVisible(entries[0]?.isIntersecting ?? false); }, { rootMargin: "200px" });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setAsset(undefined); setError("");
    if (!context || !resolved || !ready || !wanted) return;
    let current = true;
    const lease = context.acquire(resolved);
    void lease.promise.then(value => { if (current) { setAsset(value); setShape(value); } }).catch(value => { if (current) setError(errorCode(value)); });
    return () => { current = false; lease.release(); };
  }, [context?.acquire, resolved, ready, wanted, attempt]);
  const retry = () => { if (context && resolved) context.retry(resolved); setAttempt(value => value + 1); };
  const label = alt || t("images.label");
  return <span ref={host} className="markdown-image" data-no-page-swipe="true">
    {asset ? <button type="button" className="markdown-image-open" ref={opener} aria-label={t("images.open", { alt: label })} onClick={() => setViewer(true)}><img src={asset.url} alt={alt} width={asset.width} height={asset.height} decoding="async" onLoad={() => { const bounds = opener.current?.getBoundingClientRect(); if (bounds?.width && bounds.height) setShape({ width: bounds.width, height: bounds.height }); }} onError={() => { setError("invalid_image"); setAsset(undefined); }} /></button>
      : <span className="markdown-image-placeholder" style={shape ? { width: `min(100%, max(44px, ${shape.width}px))`, aspectRatio: `${shape.width}/${shape.height}`, minHeight: 44, padding: 0 } : undefined}>
        <span>{label}</span>
        {!resolved ? <span role="status">{t("images.blocked")}</span>
          : !ready ? <button type="button" onClick={context?.grant}>{t("images.allowRemote")}</button>
          : error ? <><span role="status">{t(["image_too_large", "image_dimensions", "file_too_large", "byte_limit", "pixel_limit"].includes(error) ? "images.tooLarge" : error === "image_cache_full" ? "images.cacheFull" : ["image_url_blocked", "blocked_url", "blocked_address", "invalid_url"].includes(error) ? "images.urlBlocked" : ["invalid_image", "unsupported_image", "unsupported_format", "unsafe_svg", "mime_mismatch"].includes(error) ? "images.unsupported" : "images.failed")}</span><button type="button" onClick={retry}>{t("images.retry")}</button></>
          : <span role="status">{t(visible ? "images.loading" : "images.waiting")}</span>}
      </span>}
    {viewer && asset ? <MarkdownImageViewer asset={asset} alt={label} onClose={() => { setViewer(false); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); }} /> : null}
  </span>;
}
