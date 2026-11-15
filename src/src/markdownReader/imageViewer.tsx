// Document-owned image viewer. Images register their loaded blob URLs; the
// provider renders one viewer for the active image so ←/→ can move through
// every loaded image in the document without stacking dialogs.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DocReadingTheme } from "./types";

export interface ImageViewerEntry {
  index: number;
  url: string;
  alt: string;
  title?: string;
}

export interface ImageViewerDeck {
  open(index: number): void;
  register(entry: ImageViewerEntry): () => void;
}

const ImageViewerDeckContext = createContext<ImageViewerDeck | null>(null);

export function useImageViewerDeck(): ImageViewerDeck | null {
  return useContext(ImageViewerDeckContext);
}

export function ImageViewerProvider({
  theme,
  children,
}: {
  theme: DocReadingTheme;
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<Map<number, ImageViewerEntry>>(() => new Map());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const register = useCallback((entry: ImageViewerEntry) => {
    setEntries((current) => {
      const existing = current.get(entry.index);
      if (
        existing &&
        existing.url === entry.url &&
        existing.alt === entry.alt &&
        existing.title === entry.title
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(entry.index, entry);
      return next;
    });
    return () => {
      setEntries((current) => {
        const existing = current.get(entry.index);
        if (!existing || existing.url !== entry.url) return current;
        const next = new Map(current);
        next.delete(entry.index);
        return next;
      });
    };
  }, []);

  const open = useCallback((index: number) => setActiveIndex(index), []);
  const close = useCallback(() => setActiveIndex(null), []);
  const deck = useMemo<ImageViewerDeck>(() => ({ open, register }), [open, register]);

  const step = useCallback((delta: number) => {
    setActiveIndex((current) => {
      if (current === null) return current;
      const list = [...entriesRef.current.values()].sort((a, b) => a.index - b.index);
      if (list.length < 2) return current;
      const position = list.findIndex((entry) => entry.index === current);
      if (position < 0) return current;
      return list[(position + delta + list.length) % list.length].index;
    });
  }, []);
  const previous = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);

  const ordered = useMemo(
    () => [...entries.values()].sort((a, b) => a.index - b.index),
    [entries],
  );
  const active = activeIndex !== null ? entries.get(activeIndex) ?? null : null;

  useEffect(() => {
    if (activeIndex !== null && !entries.has(activeIndex)) setActiveIndex(null);
  }, [activeIndex, entries]);

  return (
    <ImageViewerDeckContext.Provider value={deck}>
      {children}
      {active ? (
        <ImageViewer
          entry={active}
          theme={theme}
          count={ordered.length}
          position={ordered.findIndex((entry) => entry.index === active.index)}
          onClose={close}
          onPrevious={previous}
          onNext={next}
        />
      ) : null}
    </ImageViewerDeckContext.Provider>
  );
}

export function ImageViewer({
  entry,
  theme,
  count,
  position,
  onClose,
  onPrevious,
  onNext,
}: {
  entry: ImageViewerEntry;
  theme: DocReadingTheme;
  count: number;
  position: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation("shell");
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const label = entry.title || entry.alt || t("markdownImage.image");

  const changeZoom = useCallback((next: number) => {
    setZoom(Math.max(0.25, Math.min(8, next)));
  }, []);
  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [entry.index]);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      openerRef.current?.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && count > 1) {
        event.preventDefault();
        event.stopPropagation();
        onPrevious();
        return;
      }
      if (event.key === "ArrowRight" && count > 1) {
        event.preventDefault();
        event.stopPropagation();
        onNext();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => Math.min(8, current * 1.25));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom((current) => Math.max(0.25, current / 1.25));
      } else if (event.key === "0") {
        event.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [count, onClose, onNext, onPrevious, reset]);

  return createPortal(
    <div
      className="md-image-viewer"
      data-doc-theme={theme}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="md-image-viewer-toolbar">
        <span className="md-image-viewer-title">{label}</span>
        {count > 1 ? (
          <span className="md-image-viewer-count">{position + 1} / {count}</span>
        ) : null}
        <button
          className="btn small"
          aria-label={t("markdownImage.previous")}
          disabled={count < 2}
          onClick={onPrevious}
        >
          ‹
        </button>
        <button
          className="btn small"
          aria-label={t("markdownImage.next")}
          disabled={count < 2}
          onClick={onNext}
        >
          ›
        </button>
        <button
          className="btn small"
          aria-label={t("markdownImage.zoomOut")}
          onClick={() => changeZoom(zoom / 1.25)}
        >
          −
        </button>
        <button
          className="btn small"
          aria-label={t("markdownImage.zoomReset")}
          onClick={reset}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          className="btn small"
          aria-label={t("markdownImage.zoomIn")}
          onClick={() => changeZoom(zoom * 1.25)}
        >
          +
        </button>
        <button
          className="btn small"
          ref={closeRef}
          aria-label={t("markdownImage.closeViewer")}
          onClick={onClose}
        >
          {t("markdownImage.close")}
        </button>
      </div>
      <div
        className="md-image-viewer-stage"
        onDoubleClick={reset}
        onWheel={(event) => {
          event.preventDefault();
          changeZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            dx: offset.x,
            dy: offset.y,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setOffset({
            x: drag.current.dx + event.clientX - drag.current.x,
            y: drag.current.dy + event.clientY - drag.current.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <img
          src={entry.url}
          alt={entry.alt || label}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
        />
      </div>
      {entry.title ? <div className="md-image-viewer-caption">{entry.title}</div> : null}
    </div>,
    document.body,
  );
}
