// New Session dialog. Permission choice is explicit in the form; creation does
// not add a second risk-confirmation step.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText, type CreateSessionArgs } from "../api";
import { refreshProjects, selectSession } from "../actions";
import { agentDisplay, permissionLabel, presetDisplayName } from "../format";
import { closeDialog, toast, useStore } from "../store";
import { localizedNotices } from "../runtimeMessages";
import type { AgentTransportStr, PermissionStr, Preset } from "../types";

export default function NewSessionDialog(props: {
  projectId?: string;
  worktreeId?: string;
  agent?: string;
}) {
  const { t } = useTranslation(["session", "common"]);
  const s = useStore();
  const [projectId, setProjectId] = useState(props.projectId ?? s.projects[0]?.id ?? "");
  const [agent, setAgent] = useState<string>(props.agent ?? "claude");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [position, setPosition] = useState<string>(props.worktreeId ?? "main");
  const [title, setTitle] = useState("");
  const [permission, setPermission] = useState<PermissionStr>("native");
  const transport: AgentTransportStr = "pty";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const project = s.projects.find((p) => p.id === projectId);
  const adapterFor = (a: string) => s.adapters.find((x) => x.agentType === a);
  const availableAgents = s.adapters;
  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId],
  );
  const isShell = agent === "shell";
  const isPi = agent === "pi";

  useEffect(() => {
    let cancelled = false;
    setPresets([]);
    setPresetId("");
    setPermission("native");
    api
      .listPresets(agent)
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch((e) => !cancelled && setError(
        t("session:new.presetLoadFailed", { detail: errorText(e) }),
      ));
    return () => {
      cancelled = true;
    };
  }, [agent]);

  useEffect(() => {
    if (availableAgents.length > 0 && !adapterFor(agent)) {
      setAgent(availableAgents[0].agentType);
    }
  }, [agent, availableAgents]);

  const presetHasSecrets = (selectedPreset?.secretRefIds.length ?? 0) > 0;
  const buildArgs = (): CreateSessionArgs | null => {
    if (!projectId) return null;
    return {
      projectId,
      agent,
      title: title.trim() || null,
      presetId: presetId || null,
      worktreeId: position === "main" ? null : position,
      permission: isShell || isPi ? "native" : permission,
      transport,
      riskAck: true,
      cols: null,
      rows: null,
      extraArgs: null,
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
      // The backend has created the row, but the current project snapshot is
      // stale until refreshed. Select only after React can resolve the Session
      // and mount its xterm pane.
      await refreshProjects();
      selectSession(res.id);
      for (const notice of localizedNotices(res)) toast(notice, "info");
      toast(t("session:new.started", { agent: agentDisplay(agent) }), "success");
    } catch (e) {
      setError(t("session:new.createFailed", { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button className="btn ghost" onClick={closeDialog}>
        {t("common:actions.cancel")}
      </button>
      <button className="btn primary" disabled={busy || !projectId} onClick={() => void doCreate()}>
        {busy ? t("session:new.starting") : t("session:new.start")}
      </button>
    </>
  );

  return (
    <Modal
      title={t("session:new.title")}
      onClose={closeDialog}
      footer={footer}
      workspaceCentered
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <>
          <div className="form-row">
            <label htmlFor="ns-project">{t("session:new.project")}</label>
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
                  {t("session:new.projectOption", { name: p.name, path: p.rootPath })}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label" id="ns-agent-label">
              Agent
            </span>
            <div className="radio-row" role="radiogroup" aria-labelledby="ns-agent-label">
              {availableAgents.map((inst) => {
                const a = inst.agentType;
                return (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={agent === a}
                    className={"radio-chip" + (agent === a ? " selected" : "")}
                    onClick={() => {
                      setAgent(a);
                      setPermission("native");
                    }}
                    data-tip={
                      t("session:new.versionTooltip", {
                        path: inst.executablePath,
                        version: inst.versionText,
                      })
                    }
                  >
                    {agentDisplay(a)}
                  </button>
                );
              })}
              {availableAgents.length === 0 ? (
                <span className="form-hint">{t("session:new.detectAgentFirst")}</span>
              ) : null}
            </div>
          </div>

          <div className="form-row">
            <span className="form-label" id="ns-pos-label">
              {t("session:new.position")}
            </span>
            <div className="radio-row" role="radiogroup" aria-labelledby="ns-pos-label">
              <button
                type="button"
                role="radio"
                aria-checked={position === "main"}
                className={"radio-chip" + (position === "main" ? " selected" : "")}
                onClick={() => setPosition("main")}
              >
                {t("session:new.mainDirectory")}
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
                  {t("session:new.worktreeHint")}
                </span>
              ) : null}
            </div>
          </div>

          <div className="form-row">
            <label htmlFor="ns-title">{t("session:new.titleLabel")}</label>
            <input
              id="ns-title"
              type="text"
              value={title}
              maxLength={120}
              placeholder={t("session:new.titlePlaceholder", { example: `${agent}-1` })}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {isPi ? (
            <div className="form-row">
              <span className="form-hint">
                {t("session:new.piNotice")}
              </span>
            </div>
          ) : null}

          <div className="advanced-fields">
            <button
              type="button"
              className="advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>{t("session:new.advanced")}</span>
              <span className="dim">
                {advancedOpen ? t("session:new.collapse") : t("session:new.expand")}
              </span>
            </button>
            {advancedOpen ? (
              <div className="advanced-fields-body">
                <div className="form-row">
                  <label htmlFor="ns-preset">{t("session:new.preset")}</label>
                  <select
                    id="ns-preset"
                    value={presetId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setPresetId(id);
                      const p = presets.find((x) => x.id === id);
                      if (p && !isShell && !isPi) {
                        setPermission(p.permissionMode);
                        if (p.permissionMode !== "native") setAdvancedOpen(true);
                      }
                    }}
                  >
                    <option value="">
                      {isPi
                          ? t("session:new.defaultLocalPermissions")
                          : t("session:new.defaultSafe")}
                    </option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {presetDisplayName(p)}
                        {p.permissionMode !== "native"
                          ? t("session:new.permissionSuffix", {
                              permission: permissionLabel(p.permissionMode),
                            })
                          : ""}
                        {p.secretRefIds.length > 0
                          ? t("session:new.secretSuffix", { count: p.secretRefIds.length })
                          : ""}
                      </option>
                    ))}
                  </select>
                  {selectedPreset && selectedPreset.args.length > 0 ? (
                    <span className="form-hint mono">
                      {t("session:new.arguments", { arguments: selectedPreset.args.join(" ") })}
                    </span>
                  ) : null}
                </div>

                {isShell ? (
                  <div className="form-hint">{t("session:new.shellPermissionNote")}</div>
                ) : isPi ? (
                  <div className="form-hint">{t("session:new.piPermissionNote")}</div>
                ) : (
                  <div className="form-row">
                    <label htmlFor="ns-permission">{t("session:new.permission")}</label>
                    <select
                      id="ns-permission"
                      value={permission}
                      onChange={(e) => {
                        const value = e.target.value as PermissionStr;
                        setPermission(value);
                        if (value !== "native") setAdvancedOpen(true);
                      }}
                    >
                      <option value="native">{t("session:new.nativePermission")}</option>
                      <option value="auto">{t("session:new.autoPermission")}</option>
                      <option value="bypass">{t("session:new.bypassPermission")}</option>
                    </select>
                    {permission !== "native" ? (
                      <span className="warn-text">
                        {permission === "auto"
                          ? t("session:new.autoWarning")
                          : t("session:new.bypassWarning")}
                      </span>
                    ) : (
                      <span className="form-hint">{t("session:new.nativeHint")}</span>
                    )}
                    {presetHasSecrets ? (
                      <span className="form-hint">
                        {t("session:new.selectedSecrets", {
                          count: selectedPreset?.secretRefIds.length ?? 0,
                        })}
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
