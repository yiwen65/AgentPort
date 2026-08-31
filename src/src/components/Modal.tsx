// Base modal: Esc to close, focus trap, focus restore, aria-modal.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  workspaceCentered?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    return () => {
      prev?.focus?.();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === "Tab") {
      const el = ref.current;
      if (!el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className={`modal-backdrop${props.workspaceCentered ? " workspace-centered" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className={`modal${props.wide ? " wide" : ""}${props.className ? ` ${props.className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={onKeyDown}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}
