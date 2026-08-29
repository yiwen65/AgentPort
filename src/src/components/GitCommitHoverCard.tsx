import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, copyText } from "../api";
import type {
  GitCommitDetail,
  GitCommitSummary,
  GitContextLocator,
} from "../types";

// Commit detail (and therefore diff stats) is fetched lazily on first hover and
// cached per checkout so repeated hovers never re-run git.
const previewDetailCache = new Map<string, Promise<GitCommitDetail>>();

function loadPreviewDetail(
  locator: GitContextLocator,
  checkoutId: string,
  oid: string,
): Promise<GitCommitDetail> {
  const key = `${checkoutId}:${oid}`;
  let pending = previewDetailCache.get(key);
  if (!pending) {
    pending = api.getGitCommitDetail(locator, oid);
    detailCacheForgetOnError(key, pending);
  }
  return pending;
}

function detailCacheForgetOnError(key: string, pending: Promise<GitCommitDetail>) {
  previewDetailCache.set(key, pending);
  pending.catch(() => {
    if (previewDetailCache.get(key) === pending) previewDetailCache.delete(key);
  });
}

/** Test hook: drop cached hover-preview detail promises. */
export function clearCommitPreviewCache() {
  previewDetailCache.clear();
}

function relativeTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = (date.getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds || unit === "second") {
      return format.format(Math.round(seconds / unitSeconds), unit);
    }
  }
  return format.format(0, "second");
}

function absoluteTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export interface CommitWebLink {
  url: string;
  host: string;
}

/** Derive a browsable web URL for a commit from a git remote URL. */
export function commitWebLink(
  remoteUrl: string | null | undefined,
  oid: string,
): CommitWebLink | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;
  // Normalize scp-like SSH syntax (git@host:owner/repo.git) into a URL.
  const scpLike = raw.match(/^[^@/\s]+@([^:\s]+):(.+)$/);
  const normalized = scpLike ? `ssh://${scpLike[1]}/${scpLike[2]}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
    return null;
  }
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  return { url: `https://${host}${path}/commit/${oid}`, host };
}

function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="7.6" r="2.6" fill="currentColor" />
      <path
        d="M4.6 15.4c.9-2.3 3-3.4 5.4-3.4s4.5 1.1 5.4 3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6.5 3.4v3.1l2.2 1.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="2.3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M0.6 6.5h3.2m5.4 0h3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 4V2.4A1.4 1.4 0 0 0 6.6 1H2.4A1.4 1.4 0 0 0 1 2.4v4.2A1.4 1.4 0 0 0 2.4 8H4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default function GitCommitHoverCard({
  commit,
  checkoutId,
  locator,
  remoteUrl,
  onMouseEnter,
  onMouseLeave,
}: {
  commit: GitCommitSummary;
  checkoutId: string;
  locator: GitContextLocator;
  remoteUrl: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { t, i18n } = useTranslation("git");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setFailed(false);
    loadPreviewDetail(locator, checkoutId, commit.oid).then(
      (result) => {
        if (!cancelled && result.context.checkoutId === checkoutId) {
          setDetail(result);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [checkoutId, commit.oid, locator]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const locale = i18n.language;
  const stats = detail
    ? detail.files.reduce(
        (acc, file) => ({
          insertions: acc.insertions + (file.additions ?? 0),
          deletions: acc.deletions + (file.deletions ?? 0),
        }),
        { insertions: 0, deletions: 0 },
      )
    : null;
  const link = commitWebLink(remoteUrl, commit.oid);

  return (
    <div
      className="git-commit-hover-card"
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="git-commit-hover-head">
        <span className="git-commit-hover-avatar" aria-hidden="true">
          <PersonIcon />
        </span>
        <strong className="git-commit-hover-author">{commit.authorName}</strong>
        <span className="git-commit-hover-time">
          <ClockIcon />
          {relativeTime(commit.committedAt, locale)} (
          {absoluteTime(commit.committedAt, locale)})
        </span>
      </div>
      <div className="git-commit-hover-subject">
        {commit.subject || commit.shortOid}
      </div>
      <div className="git-commit-hover-stats" aria-live="polite">
        {stats && detail ? (
          <>
            <span>
              {t("history.preview.filesChanged", { count: detail.files.length })}
            </span>
            <span className="git-stat-add">
              {t("history.preview.insertions", { count: stats.insertions })}
            </span>
            <span className="git-stat-del">
              {t("history.preview.deletions", { count: stats.deletions })}
            </span>
          </>
        ) : (
          <span className="git-commit-hover-stats-pending">
            {failed
              ? t("history.preview.statsUnavailable")
              : t("history.preview.statsLoading")}
          </span>
        )}
      </div>
      <div className="git-commit-hover-actions">
        <span className="git-commit-hover-oid">
          <CommitIcon />
          <span className="mono">{commit.shortOid}</span>
          <button
            className="git-commit-hover-icon-btn"
            aria-label={t("history.preview.copyOid")}
            data-tip={copied ? t("history.preview.copied") : t("history.preview.copyOid")}
            onClick={() => {
              void copyText(commit.oid).then((ok) => {
                if (ok) setCopied(true);
              });
            }}
          >
            <CopyIcon />
          </button>
        </span>
        {link ? (
          <>
            <span className="git-commit-hover-divider" aria-hidden="true" />
            <button
              className="git-commit-hover-link"
              onClick={() => void api.openExternalUrl(link.url)}
            >
              <GitHubMark />
              {t("history.preview.openRemote", {
                host: link.host === "github.com" ? "GitHub" : link.host,
              })}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
