// Export a normalized conversation directly from the agent-owned native log.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { copyTextWithToast } from "../actions";
import { closeDialog, findSession, getState, toast, useStore } from "../store";

function defaultDest(sessionId: string, kind: "md" | "json"): string {
  const base = getState().exportsDir || "/tmp";
  return `${base}/agentport-${sessionId}.${kind}`;
}

export default function ExportDialog({
  sessionId,
  exportKind,
}: {
  sessionId: string;
  exportKind: "md" | "json";
}) {
  const { t } = useTranslation(["runtime", "common"]);
  const s = useStore();
  const ses = findSession(s.projects, sessionId);
  const [dest, setDest] = useState(defaultDest(sessionId, exportKind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);

  const submit = async () => {
    if (!dest.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.exportSession({
        sessionId,
        kind: exportKind,
        dest: dest.trim(),
        last: null,
        stripAnsi: true,
      });
      setDonePath(p);
      toast(t("runtime:export.complete"), "success");
    } catch (e) {
      setError(t("runtime:export.failed", { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={exportKind === "md"
        ? t("runtime:export.markdownTitle", { title: ses?.title ?? "" })
        : t("runtime:export.logTitle", { title: ses?.title ?? "" })}
      onClose={closeDialog}
      footer={
        donePath ? (
          <>
            <button
              className="btn"
              onClick={() => void copyTextWithToast(donePath, t("runtime:export.pathCopied"))}
            >
              {t("runtime:export.copyPath")}
            </button>
            <button className="btn primary" onClick={closeDialog}>
              {t("common:actions.done")}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={closeDialog}>
              {t("common:actions.cancel")}
            </button>
            <button className="btn primary" disabled={busy || !dest.trim()} onClick={() => void submit()}>
              {busy ? t("common:actions.exporting") : t("common:actions.export")}
            </button>
          </>
        )
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {donePath ? (
        <div className="info-box" role="status">
          <div className="kv">
            <span className="k">{t("runtime:export.exportedTo")}</span>
            <span className="v mono">{donePath}</span>
          </div>
        </div>
      ) : (
        <>
          <p className="form-hint">{t("runtime:export.markdownHint")}</p>
          <div className="form-row">
            <label htmlFor="ex-dest">{t("runtime:export.destination")}</label>
            <div className="inline-form">
              <input
                id="ex-dest"
                type="text"
                className="mono"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
              />
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void api
                    .pickSavePath(`agentport-${sessionId}.${exportKind}`)
                    .then((p) => {
                      if (p) setDest(p);
                    })
                    .catch((e) => setError(
                      t("runtime:export.chooseDestinationFailed", { detail: errorText(e) }),
                    ))
                }
              >
                {t("common:actions.browse")}
              </button>
            </div>
            <span className="form-hint">{t("runtime:export.redactionHint")}</span>
          </div>
        </>
      )}
    </Modal>
  );
}
