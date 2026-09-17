// Settings entry for updates: current version, a manual check (the only way to
// ask again when the launch probe ran offline), and the current phase. The
// install itself stays behind the consent card — installing stops running
// Sessions, so this section never triggers it directly.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorText } from "../api";
import { useUpdateState } from "../updateState";

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export default function UpdateSection() {
  const { t } = useTranslation("settings");
  const snapshot = useUpdateState();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const phase = snapshot?.phase ?? "idle";
  const disabled = phase === "disabled";
  const working = busy || phase === "checking" || phase === "downloading";

  async function check() {
    setBusy(true);
    setActionError(null);
    try {
      const checked = await api.updateCheck();
      // Ask for the payload right away: the launch probe does the same, and a
      // manual check that leaves the download to a later launch is useless.
      if (checked.version) await api.updateDownload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  let status: string;
  switch (phase) {
    case "disabled":
      status = t("update.disabled");
      break;
    case "checking":
      status = t("update.checking");
      break;
    case "downloading":
      status =
        snapshot?.total == null
          ? t("update.downloading", { version: snapshot?.version ?? "" })
          : t("update.downloadingProgress", {
              version: snapshot?.version ?? "",
              percent: Math.min(
                100,
                Math.floor(((snapshot?.downloaded ?? 0) / (snapshot?.total || 1)) * 100),
              ),
              size: formatBytes(snapshot?.downloaded ?? 0),
            });
      break;
    case "ready":
      status = t("update.ready", { version: snapshot?.version ?? "" });
      break;
    case "installing":
      status = t("update.installing");
      break;
    case "error":
      status = t("update.failed", { detail: snapshot?.error ?? "" });
      break;
    case "available":
      status = t("update.available", { version: snapshot?.version ?? "" });
      break;
    case "upToDate":
      status = t("update.upToDate", { version: snapshot?.currentVersion ?? "" });
      break;
    default:
      status = t("update.idle");
  }

  const failure = actionError ?? (phase === "error" ? null : snapshot?.error);

  return (
    <section aria-labelledby="about-heading">
      <div className="settings-section-heading">
        <div className="section-title" id="about-heading">
          {t("ui.sections.about")}
        </div>
        <p className="form-hint">{t("update.description")}</p>
      </div>
      <div className="settings-grid">
        <label>{t("update.currentVersion")}</label>
        <div className="control dim">
          {t("update.versionValue", { version: snapshot?.currentVersion ?? "…" })}
        </div>
        <label>{t("update.checkLabel")}</label>
        <div className="control">
          <button
            type="button"
            className="btn small"
            disabled={disabled || working}
            onClick={() => void check()}
          >
            {working ? t("update.checking") : t("update.checkButton")}
          </button>
        </div>
      </div>
      <p className="form-hint" role="status">
        {status}
      </p>
      {failure ? (
        <div className="error-bar" role="alert">
          {failure}
        </div>
      ) : null}
    </section>
  );
}
