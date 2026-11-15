import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DocReadingTheme } from "../markdownReader/types";

export default function ExternalLinkBubble({
  href,
  domain,
  x,
  y,
  theme,
  onOpen,
  onCopy,
  onClose,
}: {
  href: string;
  domain: string;
  x: number;
  y: number;
  theme: DocReadingTheme;
  onOpen: (remember: boolean) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("shell");
  const openRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    openRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".doc-link-bubble")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const left = Math.min(Math.max(12, x - 20), Math.max(12, window.innerWidth - 300));
  const top = Math.min(Math.max(12, y + 14), Math.max(12, window.innerHeight - 190));
  return createPortal(
    <div
      className="doc-link-bubble"
      data-doc-theme={theme}
      role="dialog"
      aria-label={t("ui.document.externalLinkTitle")}
      style={{ left: `${left}px`, top: `${top}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="doc-link-domain">{domain}</div>
      <div className="doc-link-url" title={href}>
        {href}
      </div>
      <div className="doc-link-hint">{t("ui.document.externalLinkHint")}</div>
      <label className="doc-link-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("ui.document.externalLinkRemember")}
      </label>
      <div className="doc-link-actions">
        <button
          ref={openRef}
          type="button"
          className="btn small primary"
          onClick={() => onOpen(remember)}
        >
          {t("ui.document.externalLinkOpen")}
        </button>
        <button type="button" className="btn small" onClick={onCopy}>
          {t("ui.document.externalLinkCopy")}
        </button>
        <button
          type="button"
          className="btn small ghost"
          aria-label={t("ui.document.externalLinkClose")}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
