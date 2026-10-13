import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MarkdownImageSession } from "../markdownImages";
import "./MarkdownImage.css";

export function MarkdownImageConsent({ session }: { session: MarkdownImageSession }) {
  const { t } = useTranslation("shell");
  const consent = useSyncExternalStore(session.subscribe, () => session.consent);
  return consent ? null : <div className="md-image-consent" role="note">{t("markdownImage.consentDescription")} <button className="btn small" onClick={() => session.allowRemote()}>{t("markdownImage.allowRemote")}</button></div>;
}

export function MarkdownImageViewer({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const { t } = useTranslation("shell");
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); focus?.focus({ preventScroll: true }); };
  }, [onClose]);
  function changeZoom(next: number) { setZoom(Math.max(0.25, Math.min(8, next))); }
  return createPortal(<div className="md-image-viewer" role="dialog" aria-modal="true" aria-label={alt || t("markdownImage.viewer")} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <div className="md-image-viewer-toolbar">
      <span>{alt || t("markdownImage.image")}</span>
      <button className="btn small" aria-label={t("markdownImage.zoomOut")} onClick={() => changeZoom(zoom / 1.25)}>−</button>
      <button className="btn small" aria-label={t("markdownImage.zoomReset")} onClick={() => { setZoom(1); setPosition({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
      <button className="btn small" aria-label={t("markdownImage.zoomIn")} onClick={() => changeZoom(zoom * 1.25)}>+</button>
      <button className="btn small" ref={closeRef} aria-label={t("markdownImage.closeViewer")} onClick={onClose}>{t("markdownImage.close")}</button>
    </div>
    <div className="md-image-viewer-stage" onWheel={(event) => { event.preventDefault(); changeZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); }}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, y: event.clientY, dx: position.x, dy: position.y }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setPosition({ x: drag.current.dx + event.clientX - drag.current.x, y: drag.current.dy + event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <img src={url} alt={alt} draggable={false} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} />
    </div>
  </div>, document.body);
}

export default function MarkdownImage({ source, alt, session }: { source: string; alt: string; session?: MarkdownImageSession }) {
  const { t } = useTranslation("shell");
  const state = useSyncExternalStore(session?.subscribe ?? (() => () => {}), () => session?.snapshot(source) ?? null);
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [viewer, setViewer] = useState(false);
  const closeViewer = useRef(() => setViewer(false)).current;
  useEffect(() => {
    if (!session) return;
    const node = host.current;
    let retained = false;
    const visibility = (value: boolean) => {
      if (value !== retained) { if (value) session.retain(source); else session.release(source); retained = value; }
      setVisible(value);
    };
    let observer: IntersectionObserver | null = null;
    if (node && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(([entry]) => visibility(entry.isIntersecting), { rootMargin: "160px" }); observer.observe(node);
    } else visibility(true);
    return () => { observer?.disconnect(); if (retained) session.release(source); };
  }, [session, source]);
  useEffect(() => { if (visible && session && (!state || state.status === "idle" || state.status === "blocked" && session.consent)) void session.load(source); }, [visible, session, source, state]);
  useEffect(() => { if (viewer && session) { session.retain(source); return () => session.release(source); } }, [viewer, session, source]);
  return <span ref={host} className="md-image" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    {state?.status === "ready" ? <button type="button" className="md-image-open" aria-label={t("markdownImage.openImage", { alt: alt || t("markdownImage.image") })} onClick={() => setViewer(true)}><img src={state.url} width={state.width} height={state.height} alt={alt} loading="lazy" onError={() => session?.decodeFailed(source)} /></button>
      : <span className="md-image-placeholder" role={state?.status === "error" ? "alert" : "status"}>{alt || t("markdownImage.image")} — {!session ? t("markdownImage.contextUnavailable") : state?.status === "blocked" ? t("markdownImage.remoteBlocked") : state?.status === "error" ? state.error : t("markdownImage.loading")}{state?.status === "error" ? <button className="btn small" onClick={() => void session?.load(source, true)}>{t("markdownImage.retry")}</button> : null}</span>}
    {viewer && state?.status === "ready" ? <MarkdownImageViewer url={state.url} alt={alt} onClose={closeViewer} /> : null}
  </span>;
}
