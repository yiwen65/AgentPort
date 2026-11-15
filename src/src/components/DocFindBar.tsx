import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export default function DocFindBar({
  query,
  count,
  index,
  focusRequest,
  onChange,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  count: number;
  index: number;
  focusRequest: number;
  onChange: (query: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("shell");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusRequest]);

  const position = count > 0 ? `${index + 1}/${count}` : "0/0";
  return (
    <div
      className="doc-find-bar"
      role="search"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.shiftKey) onPrev();
          else onNext();
        }
      }}
    >
      <input
        ref={inputRef}
        className="doc-find-input"
        type="text"
        value={query}
        placeholder={t("ui.document.find")}
        aria-label={t("ui.document.findInput")}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="doc-find-count" aria-live="polite">
        {query ? position : ""}
      </span>
      <button
        type="button"
        className="doc-find-btn"
        aria-label={t("ui.document.findPrevious")}
        data-tip={t("ui.document.findPrevious")}
        disabled={count === 0}
        onClick={onPrev}
      >
        ↑
      </button>
      <button
        type="button"
        className="doc-find-btn"
        aria-label={t("ui.document.findNext")}
        data-tip={t("ui.document.findNext")}
        disabled={count === 0}
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="doc-find-btn"
        aria-label={t("ui.document.findClose")}
        data-tip={t("ui.document.findClose")}
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
