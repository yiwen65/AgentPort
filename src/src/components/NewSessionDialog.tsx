// New Session dialog. Permission choice is explicit in the form; creation does
// not add a second risk-confirmation step.

import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { api, errorText, type CreateSessionArgs } from "../api";
import { selectSession } from "../actions";
import { agentDisplay, permissionZh } from "../format";
import { closeDialog, toast, useStore } from "../store";
import type { PermissionStr, Preset } from "../types";

const AGENTS = ["claude", "codex", "kimi", "shell"] as const;

export default function NewSessionDialog(props: {
  projectId?: string;
  worktreeId?: string;
  agent?: string;
}) {
  const s = useStore();
  const [projectId, setProjectId] = useState(props.projectId ?? s.projects[0]?.id ?? "");
  const [agent, setAgent] = useState<string>(props.agent ?? "claude");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [position, setPosition] = useState<string>(props.worktreeId ?? "main");
  const [title, setTitle] = useState("");
  const [extraArgsText, setExtraArgsText] = useState("");
  const [permission, setPermission] = useState<PermissionStr>("native");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const project = s.projects.find((p) => p.id === projectId);
  const adapterFor = (a: string) => s.adapters.find((x) => x.agentType === a);
  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId],
  );
  const isShell = agent === "shell";

  useEffect(() => {
    let cancelled = false;
    setPresets([]);
    setPresetId("");
    if (agent === "shell") setPermission("native");
    api
      .listPresets(agent)
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const presetHasSecrets = (selectedPreset?.secretRefIds.length ?? 0) > 0;
  // PRD 3.2 参数框：空格分隔为 argv 数组（不做 shell 拼接，后端按数组透传）。
  const extraArgs = useMemo(() => {
    const list = extraArgsText.split(/\s+/).filter((x) => x.length > 0);
    return list.length > 0 ? list : null;
  }, [extraArgsText]);

  const buildArgs = (): CreateSessionArgs | null => {
    if (!projectId) return null;
    return {
      projectId,
      agent,
      title: title.trim() || null,
      presetId: presetId || null,
      worktreeId: position === "main" ? null : position,
      permission: isShell ? "native" : permission,
      riskAck: true,
      cols: null,
      rows: null,
      extraArgs,
    };
  };

  const doCreate = async () => {
    const args = buildArgs();
    if (!args) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createSession(args);
      closeDialog();
      selectSession(res.id);
      for (const n of res.notes ?? []) toast(n, "info");
      toast(`Session 已启动（${agentDisplay(agent)}）`, "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button className="btn ghost" onClick={closeDialog}>
        取消
      </button>
      <button className="btn primary" disabled={busy || !projectId} onClick={() => void doCreate()}>
        {busy ? "启动中…" : "启动"}
      </button>
    </>
  );

  return (
    <Modal
      title="新建 Session"
      onClose={closeDialog}
      footer={footer}
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <>
          <div className="form-row">
            <label htmlFor="ns-project">项目</label>
            <select
              id="ns-project"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setPosition("main");
              }}
            >
              {s.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.rootPath}）
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label" id="ns-agent-label">
              Agent
            </span>
            <div className="radio-row" role="radiogroup" aria-labelledby="ns-agent-label">
              {AGENTS.map((a) => {
                const inst = adapterFor(a);
                return (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={agent === a}
                    className={"radio-chip" + (agent === a ? " selected" : "")}
                    onClick={() => {
                      setAgent(a);
                      if (a === "shell") setPermission("native");
                    }}
                    data-tip={
                      inst
                        ? `${inst.executablePath}\n版本：${inst.versionText}`
                        : "尚未检测到该 CLI；启动时会尝试探测"
                    }
                  >
                    {agentDisplay(a)}
                    {!inst ? <span className="dim">（未检测）</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-row">
            <span className="form-label" id="ns-pos-label">
              位置
            </span>
            <div className="radio-row" role="radiogroup" aria-labelledby="ns-pos-label">
              <button
                type="button"
                role="radio"
                aria-checked={position === "main"}
                className={"radio-chip" + (position === "main" ? " selected" : "")}
                onClick={() => setPosition("main")}
              >
                主目录
              </button>
              {(project?.worktrees ?? []).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={position === w.id}
                  className={"radio-chip" + (position === w.id ? " selected" : "")}
                  onClick={() => setPosition(w.id)}
                >
                  ⎇ {w.branch}
                </button>
              ))}
              {project?.gitRootPath ? (
                <span className="form-hint" style={{ alignSelf: "center" }}>
                  需要新分支？先经右键菜单「新建 Worktree…」创建
                </span>
              ) : null}
            </div>
          </div>

          <div className="form-row">
            <label htmlFor="ns-title">标题（可选）</label>
            <input
              id="ns-title"
              type="text"
              value={title}
              maxLength={120}
              placeholder={`留空自动命名，如 ${agent}-1`}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="advanced-fields">
            <button
              type="button"
              className="advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>高级设置</span>
              <span className="dim">{advancedOpen ? "收起" : "展开"}</span>
            </button>
            {advancedOpen ? (
              <div className="advanced-fields-body">
                <div className="form-row">
                  <label htmlFor="ns-preset">预设</label>
                  <select
                    id="ns-preset"
                    value={presetId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setPresetId(id);
                      const p = presets.find((x) => x.id === id);
                      if (p && p.permissionMode !== "native") {
                        if (!isShell) setPermission(p.permissionMode);
                        setAdvancedOpen(true);
                      }
                    }}
                  >
                    <option value="">（默认）安全默认</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.permissionMode !== "native" ? `（⚠ ${permissionZh(p.permissionMode)}）` : ""}
                        {p.secretRefIds.length > 0 ? `（含 ${p.secretRefIds.length} 个 Secret）` : ""}
                      </option>
                    ))}
                  </select>
                  {selectedPreset && selectedPreset.args.length > 0 ? (
                    <span className="form-hint mono">参数：{selectedPreset.args.join(" ")}</span>
                  ) : null}
                </div>

                <div className="form-row">
                  <label htmlFor="ns-args">参数（可选，空格分隔）</label>
                  <input
                    id="ns-args"
                    type="text"
                    className="mono"
                    value={extraArgsText}
                    placeholder="--model sonnet"
                    onChange={(e) => setExtraArgsText(e.target.value)}
                  />
                  <span className="form-hint">
                    以参数数组追加到启动命令末尾，不经过 shell 拼接。
                  </span>
                </div>

                {isShell ? (
                  <div className="form-hint">Generic Shell 不使用 Agent 权限模式，直接以终端会话启动。</div>
                ) : (
                  <div className="form-row">
                    <label htmlFor="ns-permission">权限</label>
                    <select
                      id="ns-permission"
                      value={permission}
                      onChange={(e) => {
                        const value = e.target.value as PermissionStr;
                        setPermission(value);
                        if (value !== "native") setAdvancedOpen(true);
                      }}
                    >
                      <option value="native">原生审批（默认，推荐）</option>
                      <option value="auto">自动批准 ⚠</option>
                      <option value="bypass">绕过全部权限检查 ⚠⚠</option>
                    </select>
                    {permission !== "native" ? (
                      <span className="warn-text">
                        {permission === "auto"
                          ? "自动批准：文件写入与 Shell 命令无需逐次确认。"
                          : "绕过全部权限检查（危险）。"}
                      </span>
                    ) : (
                      <span className="form-hint">沿用各 CLI 原生确认，不添加任何跳过参数。</span>
                    )}
                    {presetHasSecrets ? (
                      <span className="form-hint">
                        所选预设包含 {selectedPreset?.secretRefIds.length} 个 Secret。
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
      </>
    </Modal>
  );
}
