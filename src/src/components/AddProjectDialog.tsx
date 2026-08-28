// Add project dialog. The native directory picker is available via
// api.pickDirectory (tauri-plugin-dialog); manual path input also works.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { refreshProjects } from "../actions";
import {
  closeDialog,
  getState,
  persistProjectExpansion,
  setState,
  toast,
} from "../store";

export default function AddProjectDialog() {
  const { t } = useTranslation(["shell", "common"]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.addProject(path.trim(), name.trim() || null);
      await refreshProjects();
      if (res.focusedExisting) {
        toast(t("shell:project.alreadyAdded"), "info");
      } else {
        toast(t("shell:project.added", { name: res.name ?? path }), "success");
      }
      if (res.id) {
        const expandedProjects = { ...getState().expandedProjects, [res.id]: true };
        persistProjectExpansion(expandedProjects);
        setState({ expandedProjects });
      }
      closeDialog();
    } catch (e) {
      setError(t("shell:project.addFailed", { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("shell:project.title")}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common:actions.cancel")}
          </button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={() => void submit()}>
            {busy ? t("shell:project.checking") : t("common:actions.add")}
          </button>
        </>
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <div className="form-row">
        <label htmlFor="ap-path">{t("shell:project.directory")}</label>
        <div className="inline-form">
          <input
            id="ap-path"
            type="text"
            className="mono"
            value={path}
            placeholder="/Users/you/dev/main-api"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={() =>
              void api
                .pickDirectory()
                .then((p) => {
                  if (p) setPath(p);
                })
                .catch((e) => setError(
                  t("shell:project.chooseDirectoryFailed", { detail: errorText(e) }),
                ))
            }
          >
            {t("shell:project.chooseDirectory")}
          </button>
        </div>
        <span className="form-hint">
          {t("shell:project.directoryHint")}
        </span>
      </div>
      <div className="form-row">
        <label htmlFor="ap-name">{t("shell:project.displayName")}</label>
        <input
          id="ap-name"
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
    </Modal>
  );
}
