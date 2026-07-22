// New Worktree dialog (PRD 3.5): task name -> branch preview agent/<slug>,
// base = current HEAD or explicit Base Ref, optional existing branch name.
// On success the dialog closes immediately (toast confirms the branch);
// session launch stays a separate explicit action.

import { useState } from "react";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { refreshProjects } from "../actions";
import { slugify } from "../format";
import { closeDialog, toast, useStore } from "../store";

export default function NewWorktreeDialog({ projectId }: { projectId: string }) {
  const s = useStore();
  const project = s.projects.find((p) => p.id === projectId);
  const [task, setTask] = useState("");
  const [branch, setBranch] = useState("");
  const [baseMode, setBaseMode] = useState<"head" | "ref">("head");
  const [baseRef, setBaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugify(task);
  const previewBranch = branch.trim() || (slug ? `agent/${slug}` : "agent/…");

  const submit = async () => {
    if (!slug && !branch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWorktree(
        projectId,
        task.trim(),
        baseMode === "ref" && baseRef.trim() ? baseRef.trim() : null,
        branch.trim() || null,
      );
      await refreshProjects();
      closeDialog();
      toast(`已创建 Worktree：${res.branch}`, "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`新 Worktree · ${project?.name ?? ""}`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || (!slug && !branch.trim())}
            onClick={() => void submit()}
          >
            {busy ? "创建中…" : "创建 Worktree"}
          </button>
        </>
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <div className="form-row">
        <label htmlFor="wt-task">任务名</label>
        <input
          id="wt-task"
          type="text"
          value={task}
          placeholder="fix-login-timeout"
          onChange={(e) => setTask(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="wt-branch">分支名（可选，留空自动生成；也可填已有分支）</label>
        <input
          id="wt-branch"
          type="text"
          className="mono"
          value={branch}
          placeholder={slug ? `agent/${slug}` : "agent/<任务名>"}
          onChange={(e) => setBranch(e.target.value)}
        />
        <span className="form-hint">
          分支预览：<span className="mono">{previewBranch}</span>
        </span>
      </div>
      <div className="form-row">
        <span className="form-label" id="wt-base-label">
          基线
        </span>
        <div className="radio-row" role="radiogroup" aria-labelledby="wt-base-label">
          <button
            type="button"
            role="radio"
            aria-checked={baseMode === "head"}
            className={"radio-chip" + (baseMode === "head" ? " selected" : "")}
            onClick={() => setBaseMode("head")}
          >
            当前 HEAD
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={baseMode === "ref"}
            className={"radio-chip" + (baseMode === "ref" ? " selected" : "")}
            onClick={() => setBaseMode("ref")}
          >
            指定 Base Ref
          </button>
        </div>
        {baseMode === "ref" ? (
          <input
            type="text"
            className="mono"
            value={baseRef}
            placeholder="main / 分支 / commit"
            aria-label="Base Ref"
            onChange={(e) => setBaseRef(e.target.value)}
          />
        ) : null}
      </div>
      <p className="form-hint">
        Worktree 目录创建在应用数据目录下，不污染主仓库；删除前会检查未提交修改。
      </p>
    </Modal>
  );
}
