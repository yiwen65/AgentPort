import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownImageSession } from "../markdownImages";
import { ImageViewer, useImageViewerDeck } from "../markdownReader/imageViewer";
import { useStore } from "../store";
import "./MarkdownImage.css";

export function MarkdownImageConsent({ session }: { session: MarkdownImageSession }) {
  const { t } = useTranslation("shell");
  const consent = useSyncExternalStore(session.subscribe, () => session.consent);
  return consent ? null : <div className="md-image-consent" role="note">{t("markdownImage.consentDescription")} <button className="btn small" onClick={() => session.allowRemote()}>{t("markdownImage.allowRemote")}</button></div>;
}

export default function MarkdownImage({
  source,
  alt,
  title,
  imageIndex,
  sourceLine,
  session,
}: {
  source: string;
  alt: string;
  title?: string;
  imageIndex?: number;
  sourceLine?: number;
  session?: MarkdownImageSession;
}) {
  const { t } = useTranslation("shell");
  const deck = useImageViewerDeck();
  const readingTheme = useStore((state) => state.docReadingTheme);
  const state = useSyncExternalStore(session?.subscribe ?? (() => () => {}), () => session?.snapshot(source) ?? null);
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [viewer, setViewer] = useState(false);
  const readyUrl = state?.status === "ready" ? state.url : null;

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

  // Register the decoded blob with the document viewer deck so ←/→ can move
  // across every loaded image. Standalone use keeps its local viewer.
  useEffect(() => {
    if (!deck || imageIndex === undefined || !readyUrl) return;
    return deck.register({ index: imageIndex, url: readyUrl, alt, title });
  }, [deck, imageIndex, readyUrl, alt, title]);

  const openViewer = () => {
    if (deck && imageIndex !== undefined) deck.open(imageIndex);
    else setViewer(true);
  };

  return <span ref={host} className="md-image" data-image-index={imageIndex} {...(sourceLine !== undefined ? { "data-source-line": sourceLine } : {})} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    {state?.status === "ready" ? <button type="button" className="md-image-open" aria-label={t("markdownImage.openImage", { alt: alt || t("markdownImage.image") })} onClick={openViewer}><img src={state.url} width={state.width} height={state.height} alt={alt} title={title || undefined} loading="lazy" onError={() => session?.decodeFailed(source)} /></button>
      : <span className="md-image-placeholder" role={state?.status === "error" ? "alert" : "status"}>{alt || t("markdownImage.image")} — {!session ? t("markdownImage.contextUnavailable") : state?.status === "blocked" ? t("markdownImage.remoteBlocked") : state?.status === "error" ? state.error : t("markdownImage.loading")}{state?.status === "error" ? <button className="btn small" onClick={() => void session?.load(source, true)}>{t("markdownImage.retry")}</button> : null}</span>}
    {title ? <span className="md-image-caption">{title}</span> : null}
    {!deck && viewer && state?.status === "ready" ? (
      <ImageViewer
        entry={{ index: imageIndex ?? 0, url: state.url, alt, title }}
        theme={readingTheme}
        count={1}
        position={0}
        onClose={() => setViewer(false)}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    ) : null}
  </span>;
}
