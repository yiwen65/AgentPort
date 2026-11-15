import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export default function DocFindBar({
  query,
  count,
  index,
  focusRequest,
  replaceFocusRequest,
  showOptions,
  caseSensitive,
  wholeWord,
  regex,
  regexDisabled,
  canReplace,
  canUndoReplace,
  replacement,
  onChange,
  onPrev,
  onNext,
  onClose,
  onReplacementChange,
  onReplace,
  onReplaceAll,
  onUndoReplace,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
}: {
  query: string;
  count: number;
  index: number;
  focusRequest: number;
  replaceFocusRequest: number;
  showOptions: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  regexDisabled: boolean;
  canReplace: boolean;
  canUndoReplace: boolean;
  replacement: string;
  onChange: (query: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onReplacementChange: (replacement: string) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onUndoReplace: () => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleRegex: () => void;
}) {
  const { t } = useTranslation("shell");
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusRequest]);

  useEffect(() => {
    if (replaceFocusRequest <= 0) return;
    const input = replaceRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [replaceFocusRequest]);

  const position = count > 0 ? `${index + 1}/${count}` : "0/0";
  return (
    <div
      className="doc-find-bar"
      role="search"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "z" &&
          canUndoReplace
        ) {
          event.preventDefault();
          event.stopPropagation();
          onUndoReplace();
          return;
        }
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
      <div className="doc-find-row">
        <input
          ref={inputRef}
          className="doc-find-input"
          type="text"
          value={query}
          placeholder={t("ui.document.find")}
          aria-label={t("ui.document.findInput")}
          onChange={(event) => onChange(event.target.value)}
        />
        {showOptions ? (
          <span className="doc-find-options" role="group">
            <button
              type="button"
              className="doc-find-btn doc-find-toggle"
              aria-label={t("ui.document.findCaseSensitive")}
              data-tip={t("ui.document.findCaseSensitive")}
              aria-pressed={caseSensitive}
              onClick={onToggleCaseSensitive}
            >
              Aa
            </button>
            <button
              type="button"
              className="doc-find-btn doc-find-toggle"
              aria-label={t("ui.document.findWholeWord")}
              data-tip={t("ui.document.findWholeWord")}
              aria-pressed={wholeWord}
              onClick={onToggleWholeWord}
            >
              ab
            </button>
            <button
              type="button"
              className="doc-find-btn doc-find-toggle"
              aria-label={t("ui.document.findRegex")}
              data-tip={
                regexDisabled
                  ? t("ui.document.findRegexDisabled")
                  : t("ui.document.findRegex")
              }
              aria-pressed={regex}
              disabled={regexDisabled}
              onClick={onToggleRegex}
            >
              .*
            </button>
          </span>
        ) : null}
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
      {canReplace ? (
        <div className="doc-find-row doc-find-replace-row">
          <input
            ref={replaceRef}
            className="doc-find-input"
            type="text"
            value={replacement}
            placeholder={t("ui.document.replaceInput")}
            aria-label={t("ui.document.replaceInput")}
            onChange={(event) => onReplacementChange(event.target.value)}
          />
          <button
            type="button"
            className="doc-find-text-btn"
            disabled={count === 0}
            onClick={onReplace}
          >
            {t("ui.document.replace")}
          </button>
          <button
            type="button"
            className="doc-find-text-btn"
            disabled={count === 0}
            onClick={onReplaceAll}
          >
            {t("ui.document.replaceAll")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
