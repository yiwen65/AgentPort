import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  refreshGitHistory,
  selectGitCommit,
} from "../gitCenter";
import { useStore } from "../store";
import type { GitCommitSummary } from "../types";
import GitCommitHoverCard from "./GitCommitHoverCard";

const HOVER_SHOW_DELAY_MS = 400;
const HOVER_HIDE_DELAY_MS = 200;

function readableDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface HoverAnchor {
  oid: string;
  top: number;
  left: number;
}

function CommitRow({
  commit,
  selected,
  onHoverStart,
  onHoverEnd,
}: {
  commit: GitCommitSummary;
  selected: boolean;
  onHoverStart: (oid: string, anchor: HTMLElement) => void;
  onHoverEnd: () => void;
}) {
  const { t } = useTranslation("git");
  return (
    <button
      className={`git-history-row${selected ? " active" : ""}`}
      onClick={() => void selectGitCommit(commit.oid)}
      onMouseEnter={(event) => onHoverStart(commit.oid, event.currentTarget)}
      onMouseLeave={onHoverEnd}
      aria-current={selected ? "true" : undefined}
    >
      <span className="git-commit-dot" aria-hidden="true" />
      <span className="git-history-main">
        <strong>{commit.subject || commit.shortOid}</strong>
        <small>
          {t("history.by", {
            author: commit.authorName,
            date: readableDate(commit.committedAt),
          })}
        </small>
      </span>
      <span className="mono git-short-oid">{commit.shortOid}</span>
    </button>
  );
}

export default function GitHistoryPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const locator = useStore((state) => state.gitCenter.locator);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  const [hover, setHover] = useState<HoverAnchor | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // Keep the card inside the viewport: re-anchor upward when it would
  // overflow the window bottom.
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el || !hover) return;
    el.style.top = `${hover.top}px`;
    el.style.left = `${hover.left}px`;
    const rect = el.getBoundingClientRect();
    const overflowBottom = rect.bottom - (window.innerHeight - 8);
    if (overflowBottom > 0) {
      el.style.top = `${Math.max(8, hover.top - overflowBottom)}px`;
    }
    const overflowRight = rect.right - (window.innerWidth - 8);
    if (overflowRight > 0) {
      el.style.left = `${Math.max(8, hover.left - overflowRight)}px`;
    }
  }, [hover]);

  const clearTimer = (ref: { current: number | null }) => {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  };

  const handleHoverStart = (oid: string, anchor: HTMLElement) => {
    clearTimer(hideTimer);
    clearTimer(showTimer);
    const rect = anchor.getBoundingClientRect();
    const position = { oid, top: rect.top - 6, left: rect.right + 10 };
    // Switch instantly when a card is already visible; otherwise debounce so
    // casual mouse sweeps never trigger a fetch or flash the card.
    if (hover) {
      setHover(position);
      return;
    }
    showTimer.current = window.setTimeout(
      () => setHover(position),
      HOVER_SHOW_DELAY_MS,
    );
  };

  const handleHoverEnd = () => {
    clearTimer(showTimer);
    clearTimer(hideTimer);
    hideTimer.current = window.setTimeout(
      () => setHover(null),
      HOVER_HIDE_DELAY_MS,
    );
  };

  const handleCardEnter = () => {
    clearTimer(hideTimer);
  };

  useEffect(() => {
    if (!hover) return;
    const hide = () => setHover(null);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [hover]);

  useEffect(
    () => () => {
      clearTimer(showTimer);
      clearTimer(hideTimer);
    },
    [],
  );

  if (!cache || (cache.historyPhase === "loading" && !cache.history)) {
    return <div className="git-panel-state" role="status">{t("states.loading")}</div>;
  }
  if (cache.historyPhase === "error" && !cache.history) {
    return (
      <div className="git-panel-state error" role="alert">
        <strong>{t("states.error")}</strong>
        <span>{cache.historyError}</span>
        <button className="btn small" onClick={() => void refreshGitHistory({ reset: true })}>
          {t("retry")}
        </button>
      </div>
    );
  }
  const history = cache.history;
  const hoveredCommit = hover
    ? history?.commits.find((commit) => commit.oid === hover.oid)
    : undefined;
  return (
    <section className="git-history-panel">
      {history?.headChanged ? (
        <div className="git-inline-state info" role="status">
          <span>{t("history.newCommits")}</span>
          <button
            className="btn small"
            onClick={() => void refreshGitHistory({ reset: true })}
          >
            {t("history.refreshNow")}
          </button>
        </div>
      ) : null}
      {cache.historyPhase === "error" ? (
        <div className="git-inline-state error">{cache.historyError}</div>
      ) : null}
      {!history || history.commits.length === 0 ? (
        <div className="git-panel-state empty">{t("history.empty")}</div>
      ) : (
        <div className="git-history-list">
          {history.commits.map((commit) => (
            <CommitRow
              key={commit.oid}
              commit={commit}
              selected={cache.selectedCommitOid === commit.oid}
              onHoverStart={handleHoverStart}
              onHoverEnd={handleHoverEnd}
            />
          ))}
          {history.nextCursor ? (
            <button
              className="btn ghost git-load-more"
              disabled={cache.historyPhase === "refreshing"}
              onClick={() => void refreshGitHistory()}
            >
              {cache.historyPhase === "refreshing"
                ? t("refreshing")
                : t("actions.loadMore")}
            </button>
          ) : null}
        </div>
      )}
      {hover && hoveredCommit && checkoutId && locator ? (
        <div
          ref={anchorRef}
          className="git-commit-hover-anchor"
          style={{ top: hover.top, left: hover.left }}
        >
          <GitCommitHoverCard
            commit={hoveredCommit}
            checkoutId={checkoutId}
            locator={locator}
            remoteUrl={cache.context.remoteUrl}
            onMouseEnter={handleCardEnter}
            onMouseLeave={handleHoverEnd}
          />
        </div>
      ) : null}
    </section>
  );
}
