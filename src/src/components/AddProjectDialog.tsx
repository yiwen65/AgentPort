// Add project dialog. The native directory picker is available via
// api.pickDirectory (tauri-plugin-dialog); manual path input also works.

import { useState } from "react";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { refreshProjects } from "../actions";
import { closeDialog, setState, toast } from "../store";

export default function AddProjectDialog() {
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
        toast("该项目已在列表中，已为你聚焦", "info");
      } else {
        toast(`已添加项目「${res.name ?? path}」`, "success");
      }
      if (res.id) setState({ expandedProjects: {} });
      closeDialog();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加项目"
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={() => void submit()}>
            {busy ? "检查中…" : "添加"}
          </button>
        </>
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <div className="form-row">
        <label htmlFor="ap-path">项目目录（绝对路径）</label>
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
                .catch((e) => setError(errorText(e)))
            }
          >
            选择目录…
          </button>
        </div>
        <span className="form-hint">
          目录不存在或不可读时不会保存；同一路径重复添加会聚焦已有项目。
        </span>
      </div>
      <div className="form-row">
        <label htmlFor="ap-name">显示名（可选，默认取目录名）</label>
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
