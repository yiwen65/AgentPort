import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "./modal.css";

/** Portaled so background inertness covers the app without hiding the dialog. */
export function Modal({ title, onClose, children, className = "" }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [portal] = useState(() => document.createElement("div"));
  const sheet = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    portal.className = "mobile-modal-portal";
    document.body.append(portal);
    const backgrounds = [...document.body.children].filter((node) => node !== portal);
    const previous = backgrounds.map((node) => [node, node.getAttribute("inert")] as const);
    backgrounds.forEach((node) => node.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    const focusables = () => [...(sheet.current?.querySelectorAll<HTMLElement>("*") ?? [])]
      .filter((node) => node.tabIndex >= 0 && !node.matches(":disabled")
        && (!node.matches('input[type="radio"]') || (node as HTMLInputElement).checked));
    focusables()[0]?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const nodes = focusables();
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first || !last) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      previous.forEach(([node, value]) => value === null ? node.removeAttribute("inert") : node.setAttribute("inert", value));
      document.body.style.overflow = overflow;
      portal.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [portal]);

  return createPortal(
    <div className="centered-modal-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={sheet} className={`centered-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="centered-modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close-button" aria-label={t("common.close")} onClick={onClose}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        {children}
      </section>
    </div>, portal,
  );
}
