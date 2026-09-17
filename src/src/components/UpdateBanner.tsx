// Persistent in-app update card. Rust owns the whole update flow (check,
// background download, verified Session shutdown, install, relaunch); this
// component only mirrors the published state and requires an explicit click
// before the install step stops running Sessions.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorText, type UpdatePhase, type UpdateSnapshot } from "../api";
import { useUpdateState } from "../updateState";

/** States that need no user-visible surface. */
const QUIET_PHASES: UpdatePhase[] = ["disabled", "idle", "checking", "upToDate"];

function percent(snapshot: UpdateSnapshot): number | null {
  if (!snapshot.total || snapshot.total <= 0) return null;
  return Math.min(100, Math.floor((snapshot.downloaded / snapshot.total) * 100));
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export default function UpdateBanner() {
  const { t } = useTranslation("shell");
  const snapshot = useUpdateState();
  // Dismissal is bound to the announced version, so re-emitted progress never
  // resurrects a postponed card while a newer release still gets its prompt.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!snapshot || QUIET_PHASES.includes(snapshot.phase)) return null;
  // A failed probe with no announced release is noise: the app works offline
  // and the next launch retries. Only surface failures the user acted on or
  // that concern a release already offered.
  if (snapshot.phase === "error" && !snapshot.version) return null;
  if (dismissed === `${snapshot.phase}:${snapshot.version}`) return null;

  const version = snapshot.version ?? snapshot.currentVersion;
  const progress = percent(snapshot);

  async function retry() {
    setBusy(true);
    setActionError(null);
    try {
      const checked = await api.updateCheck();
      if (checked.version) await api.updateDownload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setActionError(null);
    try {
      // On success the process relaunches; this promise never resolves first.
      await api.updateInstall();
    } catch (error) {
      setActionError(errorText(error));
      setBusy(false);
    }
  }

  let message: string;
  switch (snapshot.phase) {
    case "downloading":
      message =
        progress === null
          ? t("update.downloading", { version })
          : t("update.downloadingProgress", {
              version,
              percent: progress,
              size: formatBytes(snapshot.downloaded),
            });
      break;
    case "ready":
      message = t("update.ready", { version });
      break;
    case "installing":
      message = t("update.installing");
      break;
    case "error":
      message = t("update.failed", { detail: snapshot.error ?? "" });
      break;
    default:
      message = t("update.available", { version });
  }

  const failure = actionError ?? (snapshot.phase === "error" ? null : snapshot.error);
  const canInstall = snapshot.phase === "ready";
  const canRetry = snapshot.phase === "available" || snapshot.phase === "error";

  return (
    <div className="update-banner" role="status">
      <div>{message}</div>
      {failure ? <div className="update-error">{failure}</div> : null}
      {snapshot.phase === "ready" ? (
        <div className="update-hint">
          {snapshot.liveSessions > 0
            ? t("update.sessionWarning", { count: snapshot.liveSessions })
            : t("update.sessionWarningNone")}
        </div>
      ) : null}
      {canInstall || canRetry ? (
        <div className="update-actions">
          <button
            type="button"
            className="btn ghost small"
            disabled={busy}
            onClick={() => setDismissed(`${snapshot.phase}:${snapshot.version}`)}
          >
            {t("update.later")}
          </button>
          {canRetry ? (
            <button type="button" className="btn small" disabled={busy} onClick={() => void retry()}>
              {t("update.retry")}
            </button>
          ) : null}
          {canInstall ? (
            <button
              type="button"
              className="btn primary small"
              disabled={busy}
              onClick={() => void install()}
            >
              {t("update.restart")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
