// Settings full-page surface (PRD 3.8 / 7.x): appearance & a11y,
// notifications, Agent adapters, and archive/backup management.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  commitAiErrorText,
  errorText,
  onProjectsChanged,
  onBackupProgress,
  type BackupProgress,
  type NativeCoverageSummary,
} from "../api";
import { applyThemeSettings, refreshProjects } from "../actions";
import {
  agentDisplay,
  formatBytes,
  formatTime,
} from "../format";
import { applyUiLanguage, currentUiLanguage, i18n } from "../i18n";
import { orderAgentIds } from "../agentOrder";
import { applyTerminalLanguage } from "../terminals";
import { getTerminalPalette, TERMINAL_THEME_IDS } from "../terminalThemes";
import { AgentIcon } from "./AgentIcons";
import type { McpRegistration } from "../types";
import NotificationSetupPanel from "./NotificationSetupPanel";
import DeviceSettings from "./DeviceSettings";
import ShellIcon from "./ShellIcon";
import { PairingSection } from "./PairingSection";
import UpdateSection from "./UpdateSection";
import {
  canRestoreBackups,
  canUseLocalOsIntegration,
  closeDialog,
  confirmDialog,
  destinationsAreRemote,
  getState,
  setState,
  toast,
  useStore,
} from "../store";
import type {
  AdapterInstall,
  AgentRole,
  AgentRoleDraft,
  ArchivedSessionView,
  CommitAiConfig,
  CommitAiLanguage,
  CommitAiProvider,
  Settings,
  SettingsSection,
  TerminalThemeId,
} from "../types";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FONT_OPTIONS = [
  { value: "system-monospace", labelKey: "settings:ui.appearance.font.options.systemDefault" },
  {
    value: "JetBrains Mono Variable",
    labelKey: "settings:ui.appearance.font.options.jetbrainsMonoVariable",
  },
  { value: "SF Mono", labelKey: "settings:ui.appearance.font.options.sfMono" },
  { value: "Menlo", labelKey: "settings:ui.appearance.font.options.menlo" },
  { value: "Consolas", labelKey: "settings:ui.appearance.font.options.consolas" },
  { value: "Cascadia Mono", labelKey: "settings:ui.appearance.font.options.cascadiaMono" },
  { value: "DejaVu Sans Mono", labelKey: "settings:ui.appearance.font.options.dejavuSansMono" },
  { value: "Sarasa Mono SC", labelKey: "settings:ui.appearance.font.options.sarasaMonoSc" },
  {
    value: "Noto Sans Mono CJK SC",
    labelKey: "settings:ui.appearance.font.options.notoSansMonoCjkSc",
  },
  {
    value: "LXGW WenKai Mono",
    labelKey: "settings:ui.appearance.font.options.lxgwWenKaiMono",
  },
] as const;

function CommitAiSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [config, setConfig] = useState<CommitAiConfig | null>(null);
  const [provider, setProvider] = useState<CommitAiProvider>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [language, setLanguage] = useState<CommitAiLanguage>("zh");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyConfig = (next: CommitAiConfig) => {
    setConfig(next);
    setProvider(next.provider);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setLanguage(next.language);
    setApiKey("");
  };

  useEffect(() => {
    let active = true;
    api
      .getCommitAiConfig()
      .then((next) => {
        if (active) applyConfig(next);
      })
      .catch((reason) => {
        if (active) {
          setError(t("settings:ui.commitAi.loadFailed", {
            detail: commitAiErrorText(reason),
          }));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveCommitAiConfig(
        provider,
        baseUrl.trim(),
        model.trim(),
        apiKey.trim() || null,
        language,
      );
      applyConfig(next);
      toast(t("settings:ui.commitAi.saved"), "success");
    } catch (reason) {
      setError(t("settings:ui.commitAi.saveFailed", {
        detail: commitAiErrorText(reason),
      }));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    const confirmed = await confirmDialog({
      title: t("settings:ui.commitAi.clearKeyTitle"),
      body: t("settings:ui.commitAi.clearKeyBody"),
      confirmLabel: t("settings:ui.commitAi.clearKeyConfirm"),
      danger: true,
    });
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      applyConfig(await api.clearCommitAiApiKey());
      toast(t("settings:ui.commitAi.keyCleared"), "success");
    } catch (reason) {
      setError(t("settings:ui.commitAi.clearKeyFailed", {
        detail: commitAiErrorText(reason),
      }));
    } finally {
      setSaving(false);
    }
  };

  const insecure = baseUrl.trim().toLocaleLowerCase().startsWith("http://");
  const placeholderUrl = provider === "openai"
    ? "https://api.openai.com/v1"
    : "https://api.anthropic.com";
  const placeholderModel = provider === "openai" ? "gpt-5.1" : "claude-sonnet-4-5";

  return (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.commitAi")}</div>
        <p className="form-hint">{t("settings:ui.commitAi.description")}</p>
      </div>
      {loading ? <p className="dim">{t("common:status.loading")}</p> : null}
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {!loading ? (
        <>
          <div className="settings-subheading">
            {t("settings:ui.commitAi.connectionTitle")}
          </div>
          <div className="settings-grid">
            <label htmlFor="commit-ai-provider">
              {t("settings:ui.commitAi.providerLabel")}
            </label>
            <div className="control">
              <select
                id="commit-ai-provider"
                value={provider}
                disabled={saving}
                onChange={(event) =>
                  setProvider(event.target.value as CommitAiProvider)}
              >
                <option value="openai">
                  {t("settings:ui.commitAi.providers.openai")}
                </option>
                <option value="anthropic">
                  {t("settings:ui.commitAi.providers.anthropic")}
                </option>
              </select>
              <span className="form-hint">
                {t("settings:ui.commitAi.providerHint")}
              </span>
            </div>

            <label htmlFor="commit-ai-base-url">
              {t("settings:ui.commitAi.baseUrlLabel")}
            </label>
            <div className="control">
              <input
                id="commit-ai-base-url"
                type="url"
                value={baseUrl}
                disabled={saving}
                placeholder={placeholderUrl}
                spellCheck={false}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <span className="form-hint">
                {t("settings:ui.commitAi.baseUrlHint")}
              </span>
              {insecure ? (
                <span className="warn-text" role="alert">
                  {t("settings:ui.commitAi.httpWarning")}
                </span>
              ) : null}
            </div>

            <label htmlFor="commit-ai-model">
              {t("settings:ui.commitAi.modelLabel")}
            </label>
            <div className="control">
              <input
                id="commit-ai-model"
                type="text"
                value={model}
                disabled={saving}
                placeholder={placeholderModel}
                spellCheck={false}
                onChange={(event) => setModel(event.target.value)}
              />
              <span className="form-hint">
                {t("settings:ui.commitAi.modelHint")}
              </span>
            </div>
          </div>

          <div className="settings-subheading">
            {t("settings:ui.commitAi.credentialsTitle")}
          </div>
          <div className="settings-grid">
            <label htmlFor="commit-ai-api-key">
              {t("settings:ui.commitAi.apiKeyLabel")}
            </label>
            <div className="control">
              <input
                id="commit-ai-api-key"
                type="password"
                value={apiKey}
                disabled={saving}
                placeholder={config?.hasApiKey
                  ? t("settings:ui.commitAi.apiKeyConfigured")
                  : t("settings:ui.commitAi.apiKeyPlaceholder")}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="form-hint">
                {config?.hasApiKey
                  ? t("settings:ui.commitAi.apiKeyKeepHint")
                  : t("settings:ui.commitAi.apiKeyStorageHint")}
              </span>
            </div>
          </div>

          <div className="settings-subheading">
            {t("settings:ui.commitAi.generationTitle")}
          </div>
          <div className="settings-grid">
            <label id="commit-ai-language-label">
              {t("settings:ui.commitAi.languageLabel")}
            </label>
            <div className="control theme-control">
              <div
                className="theme-segmented"
                role="radiogroup"
                aria-labelledby="commit-ai-language-label"
              >
                {(
                  [
                    ["zh", t("settings:ui.commitAi.languageZh")],
                    ["en", "English"],
                  ] as const
                ).map(([value, label]) => (
                  <label className="theme-segment" key={value}>
                    <input
                      className="sr-only"
                      type="radio"
                      name="commit-ai-language"
                      value={value}
                      checked={language === value}
                      disabled={saving}
                      onChange={() => setLanguage(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <span className="form-hint">
                {t("settings:ui.commitAi.languageHint")}
              </span>
            </div>
          </div>

          <div className="commit-ai-settings-actions">
            <button
              className="btn primary"
              disabled={saving || !baseUrl.trim() || !model.trim()}
              onClick={() => void save()}
            >
              {saving
                ? t("common:actions.saving")
                : t("settings:ui.commitAi.save")}
            </button>
            {config?.hasApiKey ? (
              <button
                className="btn danger"
                disabled={saving}
                onClick={() => void clearKey()}
              >
                {t("settings:ui.commitAi.clearKey")}
              </button>
            ) : null}
          </div>
          <div className="info-box">
            <strong>{t("settings:ui.commitAi.privacyTitle")}</strong>
            <p className="form-hint">{t("settings:ui.commitAi.privacyBody")}</p>
          </div>
        </>
      ) : null}
    </>
  );
}

function AdapterOrderIcon({ agent }: { agent: string }) {
  if (agent === "shell") return <ShellIcon className="adapter-order-icon" size={18} />;
  return <AgentIcon agent={agent} className="adapter-order-icon" size={18} />;
}

function roleDraft(role: AgentRole): AgentRoleDraft {
  return {
    name: role.name,
    description: role.description,
    instructions: role.instructions,
    outputContract: role.outputContract,
  };
}

function RoleSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentRoleDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (preferredId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listAgentRoles();
      setRoles(next);
      const target = preferredId === undefined ? selectedId : preferredId;
      const selected = next.find((role) => role.id === target) ?? next[0];
      if (selected) {
        setSelectedId(selected.id);
        setDraft(roleDraft(selected));
        setCreating(false);
      } else {
        setSelectedId(null);
        setDraft(null);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(null);
    // Roles are local configuration and are loaded once when this section opens.
    // Each mutation refreshes the authoritative list explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (role: AgentRole) => {
    setSelectedId(role.id);
    setDraft(roleDraft(role));
    setCreating(false);
    setError(null);
  };

  const startCreate = () => {
    setSelectedId(null);
    setCreating(true);
    setDraft({ name: "", description: "", instructions: "", outputContract: null });
    setError(null);
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = creating
        ? await api.createAgentRole(draft)
        : await api.updateAgentRole(
            selectedId!,
            roles.find((role) => role.id === selectedId)?.revision ?? 0,
            draft,
          );
      await load(saved.id);
      toast(t("settings:ui.roles.saved"), "success");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (role: AgentRole) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setAgentRoleEnabled(role.id, role.revision, !role.enabled);
      await load(role.id);
    } catch (reason) {
      setError(errorText(reason));
      await load(role.id);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (role: AgentRole) => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: t("settings:ui.roles.resetTitle"),
      body: t("settings:ui.roles.resetBody", { name: role.name }),
      confirmLabel: t("settings:ui.roles.reset"),
      danger: false,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetAgentRole(role.id, role.revision);
      await load(role.id);
      toast(t("settings:ui.roles.restored"), "success");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: AgentRole) => {
    if (busy || role.builtIn) return;
    const confirmed = await confirmDialog({
      title: t("settings:ui.roles.deleteTitle"),
      body: t("settings:ui.roles.deleteBody", { name: role.name }),
      confirmLabel: t("common:actions.delete"),
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgentRole(role.id, role.revision);
      await load(null);
      toast(t("settings:ui.roles.deleted"), "success");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectedRole = roles.find((role) => role.id === selectedId) ?? null;
  return (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.roles")}</div>
        <p className="form-hint">{t("settings:ui.roles.description")}</p>
      </div>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {loading ? <p className="dim">{t("common:status.loading")}</p> : null}
      {!loading ? (
        <div className="agent-roles-layout">
          <div className="agent-role-list" aria-label={t("settings:ui.roles.listLabel")}>
            <div className="agent-role-list-heading">
              <strong>{t("settings:ui.roles.listTitle")}</strong>
              <button className="btn small primary" type="button" onClick={startCreate} disabled={busy}>
                {t("settings:ui.roles.add")}
              </button>
            </div>
            {roles.map((role) => (
              <div
                className={`agent-role-card${role.id === selectedId ? " selected" : ""}`}
                key={role.id}
              >
                <button className="agent-role-select" type="button" onClick={() => select(role)}>
                  <strong>{role.name}</strong>
                  <span>{role.description}</span>
                  <small>{role.builtIn ? t("settings:ui.roles.builtIn") : t("settings:ui.roles.custom")}</small>
                </button>
                <button
                  type="button"
                  className="adapter-enabled-switch"
                  role="switch"
                  aria-checked={role.enabled}
                  aria-label={t("settings:ui.roles.enabledLabel", { name: role.name })}
                  disabled={busy}
                  onClick={() => void toggle(role)}
                />
              </div>
            ))}
          </div>
          <div className="agent-role-editor">
            <div className="agent-role-editor-heading">
              <strong>
                {creating ? t("settings:ui.roles.newTitle") : selectedRole?.name ?? t("settings:ui.roles.editorTitle")}
              </strong>
              {selectedRole ? <span className="form-hint">v{selectedRole.revision}</span> : null}
            </div>
            {draft ? (
              <div className="settings-grid">
                <label htmlFor="agent-role-name">{t("settings:ui.roles.name")}</label>
                <div className="control">
                  <input
                    id="agent-role-name"
                    value={draft.name}
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <label htmlFor="agent-role-description">{t("settings:ui.roles.descriptionLabel")}</label>
                <div className="control">
                  <textarea
                    id="agent-role-description"
                    value={draft.description}
                    disabled={busy}
                    rows={3}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </div>
                <label htmlFor="agent-role-instructions">{t("settings:ui.roles.instructions")}</label>
                <div className="control">
                  <textarea
                    id="agent-role-instructions"
                    value={draft.instructions}
                    disabled={busy}
                    rows={9}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                  />
                  <span className="form-hint">{t("settings:ui.roles.instructionsHint")}</span>
                </div>
                <label htmlFor="agent-role-output">{t("settings:ui.roles.outputContract")}</label>
                <div className="control">
                  <textarea
                    id="agent-role-output"
                    value={draft.outputContract ?? ""}
                    disabled={busy}
                    rows={4}
                    onChange={(event) => setDraft({ ...draft, outputContract: event.target.value || null })}
                  />
                  <span className="form-hint">{t("settings:ui.roles.outputContractHint")}</span>
                </div>
              </div>
            ) : (
              <p className="dim">{t("settings:ui.roles.empty")}</p>
            )}
            {draft ? (
              <div className="agent-role-actions">
                <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
                  {t("common:actions.save")}
                </button>
                {!creating && selectedRole?.builtIn ? (
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => void reset(selectedRole)}>
                    {t("settings:ui.roles.reset")}
                  </button>
                ) : null}
                {!creating && selectedRole && !selectedRole.builtIn ? (
                  <button className="btn ghost danger" type="button" disabled={busy} onClick={() => void remove(selectedRole)}>
                    {t("common:actions.delete")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Last MCP registration answer, kept across mounts so a reopen never flickers. */
let lastKnownMcpRegistrations: Record<string, McpRegistration> = {};

function AdapterSection({
  agentOrder,
  agentHidden,
  onAgentOrderChange,
  onAgentHiddenChange,
}: {
  agentOrder: string[];
  agentHidden: string[];
  onAgentOrderChange: (next: string[]) => void;
  onAgentHiddenChange: (next: string[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [notificationRevision, setNotificationRevision] = useState(0);
  // MCP registration is per Agent and lives in that Agent's own config, so the
  // panel reads it once on mount and after every toggle. Seeding from the last
  // answer keeps the switches from flickering through "off" while the first
  // probe runs; `mcpLoaded` marks whether a real answer has arrived.
  const [mcp, setMcp] = useState<Record<string, McpRegistration>>(
    () => lastKnownMcpRegistrations,
  );
  const [mcpLoaded, setMcpLoaded] = useState(
    () => Object.keys(lastKnownMcpRegistrations).length > 0,
  );
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);

  const loadMcp = useMemo(
    () => async () => {
      try {
        const reports = await api.mcpRegistrations();
        const next = Object.fromEntries(
          reports.map((report) => [report.agent, report]),
        );
        lastKnownMcpRegistrations = next;
        setMcp(next);
        setMcpLoaded(true);
      } catch {
        // A failed probe leaves the switches disabled rather than guessing, but
        // keeps whatever we knew before instead of claiming they are off.
        setMcpLoaded(true);
      }
    },
    [],
  );

  useEffect(() => {
    void loadMcp();
  }, [loadMcp, notificationRevision]);

  const toggleMcp = async (agent: string, enable: boolean) => {
    setMcpBusy(agent);
    try {
      const report = await api.setMcpRegistration(agent, enable);
      setMcp((current) => {
        const next = { ...current, [report.agent]: report };
        lastKnownMcpRegistrations = next;
        return next;
      });
      toast(
        enable
          ? t("settings:ui.adapters.mcpEnabled", { agent: agentDisplay(agent) })
          : t("settings:ui.adapters.mcpDisabled", { agent: agentDisplay(agent) }),
        "success",
      );
    } catch (error) {
      toast(
        t("settings:ui.adapters.mcpFailed", {
          agent: agentDisplay(agent),
          detail: errorText(error),
        }),
        "error",
      );
      void loadMcp();
    } finally {
      setMcpBusy(null);
    }
  };
  // Disabled adapters stay in this management table so they can be enabled again.
  const orderedAgentIds = orderAgentIds(
    agentOrder,
    s.adapters.map((adapter) => adapter.agentType),
  );
  const orderedAdapters = orderedAgentIds
    .map((agent) => s.adapters.find((adapter) => adapter.agentType === agent))
    .filter((adapter): adapter is AdapterInstall => adapter !== undefined);
  const move = (agent: string, direction: -1 | 1) => {
    const next = [...agentOrder];
    for (const id of orderedAgentIds) {
      if (!next.includes(id)) next.push(id);
    }
    const from = next.indexOf(agent);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    onAgentOrderChange(next);
  };
  const toggleAgent = (agent: string) => {
    onAgentHiddenChange(agentHidden.includes(agent)
      ? agentHidden.filter((id) => id !== agent)
      : [...agentHidden, agent]);
  };
  const reprobe = async () => {
    setBusy(true);
    try {
      const supported = await api.listSupportedAgents();
      const missing = supported.filter(({ agent }) =>
        !getState().adapters.some((adapter) => adapter.agentType === agent));
      if (missing.length === 0) {
        toast(t("settings:ui.adapters.nothingMissing"), "success");
        return;
      }
      let added = 0;
      const failures: string[] = [];
      for (const { agent } of missing) {
        // Another view may have configured this adapter while discovery awaited.
        if (getState().adapters.some((adapter) => adapter.agentType === agent)) continue;
        try {
          const outcome = await api.probeAgent(agent, null);
          if (outcome.install && !getState().adapters.some((adapter) => adapter.agentType === agent)) {
            setState({ adapters: [...getState().adapters, outcome.install] });
            added += 1;
          }
        } catch (error) {
          failures.push(`${agentDisplay(agent)}: ${errorText(error)}`);
        }
      }
      setNotificationRevision((value) => value + 1);
      if (added > 0) toast(t("settings:ui.adapters.probePassed", { count: added }), "success");
      if (failures.length > 0) {
        toast(t("settings:ui.adapters.reprobeFailed", { detail: failures.join("; ") }), "error");
      } else if (added === 0) {
        toast(t("settings:ui.adapters.probeNone"), "error");
      }
    } catch (e) {
      toast(t("settings:ui.adapters.reprobeFailed", { detail: errorText(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.adapters")}</div>
        <p className="form-hint">{t("settings:ui.adapters.description")}</p>
      </div>
      {orderedAdapters.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          {t("settings:ui.adapters.empty")}
        </p>
      ) : (
        <table className="table" aria-label={t("settings:ui.adapters.tableAriaLabel")}>
          <thead>
            <tr>
              <th>{t("settings:ui.adapters.columns.agent")}</th>
              <th>{t("settings:ui.adapters.columns.selection")}</th>
              <th>{t("settings:ui.adapters.columns.order")}</th>
              <th>{t("settings:ui.adapters.columns.mcp")}</th>
              <th>{t("settings:ui.adapters.columns.enabled")}</th>
            </tr>
          </thead>
          <tbody>
            {orderedAdapters.map((a, index) => (
              <tr key={a.agentType}>
                <td>
                  <span className="adapter-order-name">
                    <AdapterOrderIcon agent={a.agentType} />
                    {agentDisplay(a.agentType)}
                  </span>
                </td>
                <td style={{ wordBreak: "break-all" }}>
                  <div>{a.versionText}</div>
                  <div className="mono dim">{a.executablePath}</div>
                </td>
                <td>
                  <span className="adapter-order-actions">
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={index === 0}
                      onClick={() => move(a.agentType, -1)}
                      aria-label={t("settings:ui.adapters.moveUp", {
                        agent: agentDisplay(a.agentType),
                      })}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={index === orderedAdapters.length - 1}
                      onClick={() => move(a.agentType, 1)}
                      aria-label={t("settings:ui.adapters.moveDown", {
                        agent: agentDisplay(a.agentType),
                      })}
                    >
                      ↓
                    </button>
                  </span>
                </td>
                <td>
                  {(() => {
                    const report = mcp[a.agentType];
                    const pending = !report && !mcpLoaded;
                    const supported = report
                      ? report.state !== "unsupported" && report.command !== null
                      : false;
                    const registered = report?.state === "registered";
                    const label = t("settings:ui.adapters.mcpLabel", {
                      agent: agentDisplay(a.agentType),
                    });
                    const hint = report
                      ? report.detail || report.target
                      : t("settings:ui.adapters.mcpUnknown");
                    return (
                      <span className="adapter-mcp-cell">
                        <button
                          type="button"
                          className="adapter-enabled-switch"
                          role="switch"
                          aria-checked={registered}
                          aria-busy={pending || undefined}
                          data-mcp-pending={pending ? "true" : undefined}
                          disabled={pending || !supported || mcpBusy === a.agentType}
                          title={pending ? t("settings:ui.adapters.mcpChecking") : hint}
                          aria-label={label}
                          onClick={() => void toggleMcp(a.agentType, !registered)}
                        />
                      </span>
                    );
                  })()}
                </td>
                <td>
                  <button
                    type="button"
                    className="adapter-enabled-switch"
                    role="switch"
                    aria-checked={!agentHidden.includes(a.agentType)}
                    onClick={() => toggleAgent(a.agentType)}
                    aria-label={t("settings:ui.adapters.enabledLabel", {
                      agent: agentDisplay(a.agentType),
                    })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="adapter-actions">
        <button
          className="btn primary"
          disabled={busy || setupBusy}
          aria-busy={busy}
          onClick={() => void reprobe()}
        >
          {busy ? (
            <svg className="adapter-action-icon spinning" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" opacity="0.35" />
              <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          ) : (
            <svg className="adapter-action-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10.3 10.3 3.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M7 5.1v3.8M5.1 7h3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          {busy ? t("settings:ui.adapters.probing") : t("settings:ui.adapters.reprobeAll")}
        </button>
        <button
          className="btn adapter-manage"
          onClick={() => {
            closeDialog();
            setState({ showOnboarding: true });
          }}
        >
          <svg className="adapter-action-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 5.5h4.7m3.9 0h2.4M2.5 10.5h.6m3.8 0h6.6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="9.1" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="4.8" cy="10.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {t("settings:ui.adapters.manage")}
        </button>
      </div>
      <NotificationSetupPanel refreshKey={notificationRevision} disabled={busy} onBusyChange={setSetupBusy} />
    </>
  );
}

function formatArchivedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(currentUiLanguage(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type BackupItem = { path: string; name: string; size: number; modifiedAt: string };
type BackupStatus = {
  kind: "pending" | "complete" | "incomplete" | "legacy" | "error";
  text: string;
};

export function nativeCoverageComplete(coverage: NativeCoverageSummary): boolean {
  return coverage.missing === 0 && coverage.ambiguous === 0;
}

/** Per-agent archives and insert-only restore; existing Sessions stay intact. */
export function BackupSection() {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const remoteDestinations = useStore(destinationsAreRemote);
  const restoreAllowed = useStore(canRestoreBackups);
  const osIntegration = useStore(canUseLocalOsIntegration);
  const dataRoot = s.exportsDir.replace(/\/exports$/, "");
  const backupsDir = `${dataRoot}/backups`;
  const [items, setItems] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupElapsed, setBackupElapsed] = useState(0);
  const progressListener = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; progressListener.current?.(); progressListener.current = null; };
  }, []);
  useEffect(() => {
    if (!creating) return;
    const startedAt = Date.now();
    setBackupElapsed(0);
    const timer = setInterval(() => setBackupElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [creating]);
  const [verifyState, setVerifyState] = useState<Record<string, BackupStatus>>({});
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ agent: string; imported: string[]; skipped: string[] } | null>(null);
  const busy = creating !== null || restoring !== null;
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.backupList());
    } catch (e) {
      setError(t("settings:ui.backup.listFailed", { detail: errorText(e) }));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const create = async (agent: string) => {
    setCreating(agent);
    setBackupProgress(null);
    setBackupElapsed(0);
    setError(null);
    setRestored(null);
    try {
      const requestId = crypto.randomUUID();
      // Install the listener before invoking: even a fast snapshot must not
      // outrun subscription. Ignore other windows' and older jobs' events.
      const unlisten = await onBackupProgress((event) => {
        if (mounted.current && event.requestId === requestId && event.agent === agent) setBackupProgress(event);
      });
      if (!mounted.current) { unlisten(); return; }
      progressListener.current = unlisten;
      const r = await api.backupCreate(agent, null, requestId);
      const complete = nativeCoverageComplete(r.nativeCoverage);
      toast(
        t(
          complete
            ? "settings:ui.backup.createComplete"
            : "settings:ui.backup.createIncomplete",
          { count: r.files, ...r.nativeCoverage },
        ),
        complete ? "success" : "info",
      );
      await reload();
      setVerifyState((current) => ({
        ...current,
        [r.path]: {
          kind: complete ? "complete" : "incomplete",
          text: t(
            complete
              ? "settings:ui.backup.verificationV2Complete"
              : "settings:ui.backup.verificationV2Incomplete",
            { count: r.files, ...r.nativeCoverage },
          ),
        },
      }));
    } catch (e) {
      setError(t("settings:ui.backup.createFailed", { detail: errorText(e) }));
    } finally {
      progressListener.current?.();
      progressListener.current = null;
      setCreating(null);
      setBackupProgress(null);
    }
  };

  const verify = async (path: string) => {
    setVerifyState((v) => ({
      ...v,
      [path]: { kind: "pending", text: t("settings:ui.backup.verifying") },
    }));
    try {
      const r = await api.backupVerify(path);
      const legacy = r.formatVersion === 1;
      const complete = !legacy && nativeCoverageComplete(r.nativeCoverage);
      const key = legacy
        ? "settings:ui.backup.verificationV1Legacy"
        : complete
          ? "settings:ui.backup.verificationV2Complete"
          : "settings:ui.backup.verificationV2Incomplete";
      setVerifyState((v) => ({
        ...v,
        [path]: {
          kind: legacy ? "legacy" : complete ? "complete" : "incomplete",
          text: t(key, { count: r.files, ...r.nativeCoverage }),
        },
      }));
    } catch (e) {
      setVerifyState((v) => ({
        ...v,
        [path]: {
          kind: "error",
          text: t("settings:ui.backup.verifyFailed", { detail: errorText(e) }),
        },
      }));
    }
  };

  const restore = async (agent: string) => {
    setError(null);
    setRestored(null);
    setRestoring(agent);
    try {
      const archive = await api.pickFile(t("settings:ui.backup.filePickerTitle"));
      if (!archive) return;
      const ok = await confirmDialog({
        title: t("settings:ui.backup.restoreTitle", { agent: agentDisplay(agent) }),
        body: t("settings:ui.backup.restoreBody", { agent: agentDisplay(agent) }),
        confirmLabel: t("settings:ui.backup.mergeRestore"),
      });
      if (!ok) return;
      const r = await api.backupRestore(archive, agent);
      setRestored({ agent, imported: r.imported, skipped: r.skipped });
      toast(t("settings:ui.backup.mergeResult", {
        agent: agentDisplay(agent), imported: r.imported.length, skipped: r.skipped.length,
      }), r.skipped.length ? "info" : "success");
      await refreshProjects();
    } catch (e) {
      setError(t("settings:ui.backup.restoreFailed", { detail: errorText(e) }));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.backup")}</div>
        <p className="form-hint">
          {t("settings:ui.backup.description")}
        </p>
      </div>
      <div className="info-box backup-data-boundary" role="note">
        <strong>{t("settings:ui.backup.dataBoundaryTitle")}</strong>
        <p className="form-hint">{t("settings:ui.backup.dataBoundaryBody")}</p>
      </div>
      {remoteDestinations ? (
        <div className="info-box backup-remote-boundary" role="note">
          <p className="form-hint">{t("settings:ui.backup.remoteServerSideHint")}</p>
        </div>
      ) : null}
      {creating ? <div className="info-box backup-progress">
        <strong role="status">{agentDisplay(creating)} · {t(`settings:ui.backup.phases.${backupProgress?.phase ?? "preparing"}`)}
          {backupProgress && backupProgress.total > 0 ? ` · ${backupProgress.completed} / ${backupProgress.total}` : ""}
        </strong>
        {backupProgress && backupProgress.total > 0 ? <progress
          aria-label={t("settings:ui.backup.phaseProgress")}
          max={backupProgress.total} value={backupProgress.completed} /> : null}
        <p className="form-hint">{t("settings:ui.backup.elapsed", { seconds: backupElapsed })}</p>
        <p className="form-hint">{t("settings:ui.backup.busyHint")}</p>
      </div> : null}
      {s.adapters.length === 0 ? <p className="form-hint">{t("settings:ui.backup.noInstalledAgents")}</p> : null}
      <div className="backup-agent-list" aria-busy={busy}>
        {orderAgentIds(s.settings?.agentOrder, s.adapters.map((adapter) => adapter.agentType)).map((agent) => (
          <div className="backup-agent-row" role="group" aria-label={agentDisplay(agent)} key={agent}>
            <strong>{agentDisplay(agent)}</strong>
            <button className="btn" disabled={busy}
              aria-label={t("settings:ui.backup.createAgent", { agent: agentDisplay(agent) })}
              onClick={() => void create(agent)}>
              {creating === agent ? t("settings:ui.backup.creating") : t("settings:ui.backup.createNow")}
            </button>
            <button className="btn" disabled={busy || !restoreAllowed}
              title={restoreAllowed ? undefined : t("settings:ui.backup.remoteRestoreUnavailable")}
              aria-label={t("settings:ui.backup.restoreAgent", { agent: agentDisplay(agent) })}
              onClick={() => void restore(agent)}>
              {restoring === agent ? t("settings:ui.backup.restoring") : t("settings:ui.backup.mergeRestore")}
            </button>
          </div>
        ))}
      </div>
      <p className="form-hint">{t("settings:ui.backup.createHint")}</p>
      <button className="btn small ghost" disabled={!osIntegration}
        title={osIntegration ? undefined : t("settings:ui.backup.remoteOpenDirectoryUnavailable")}
        onClick={() =>
        void api.revealInFileManager(backupsDir).catch((e) =>
          toast(t("settings:ui.backup.openDirectoryFailed", { detail: errorText(e) }), "error"))}>
        {t("settings:ui.backup.openDirectory")}
      </button>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {restored ? (
        <div className="info-box" role="status">
          <p>{t("settings:ui.backup.mergeResult", {
            agent: agentDisplay(restored.agent), imported: restored.imported.length, skipped: restored.skipped.length,
          })}</p>
          {restored.skipped.length > 0 ? <details>
            <summary>{t("settings:ui.backup.skippedSessions")}</summary>
            <ul>{restored.skipped.map((id) => <li className="mono" key={id}>{id}</li>)}</ul>
          </details> : null}
        </div>
      ) : null}
      <div className="section-title">{t("settings:ui.backup.existingTitle")}</div>
      {loading ? <p className="dim">{t("settings:ui.backup.loading")}</p> : null}
      {!loading && items.length === 0 ? (
        <p className="dim">{t("settings:ui.backup.empty")}</p>
      ) : null}
      {!loading && items.length > 0 ? (
        <table className="table" aria-label={t("settings:ui.backup.tableAriaLabel")}>
          <thead>
            <tr>
              <th>{t("settings:ui.backup.columns.fileName")}</th>
              <th>{t("settings:ui.backup.columns.size")}</th>
              <th>{t("settings:ui.backup.columns.modifiedAt")}</th>
              <th>{t("settings:ui.backup.columns.status")}</th>
              <th aria-label={t("settings:ui.columns.actions")} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.path}>
                <td className="mono dim" style={{ wordBreak: "break-all" }}>
                  {item.name}
                </td>
                <td>{formatBytes(item.size)}</td>
                <td className="dim">{item.modifiedAt ? formatTime(item.modifiedAt) : "—"}</td>
                <td
                  className={
                    ["incomplete", "legacy", "error"].includes(
                      verifyState[item.path]?.kind ?? "",
                    )
                      ? "warn-text"
                      : "dim"
                  }
                >
                  {verifyState[item.path]?.text ?? t("settings:ui.backup.notVerified")}
                </td>
                <td>
                  <button className="btn small" onClick={() => void verify(item.path)}>
                    {t("settings:ui.backup.verify")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function ArchiveSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [sessions, setSessions] = useState<ArchivedSessionView[]>([]);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await api.listArchivedSessions());
    } catch (e) {
      setError(t("settings:ui.archive.loadFailed", { detail: errorText(e) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void reload();
    void onProjectsChanged(() => {
      void reload();
    }).then((fn) => {
      unlisten = fn;
    });
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const projects = useMemo(
    () =>
      Array.from(new Map(sessions.map((session) => [session.projectId, session.projectName])).entries()).map(
        ([id, name]) => ({ id, name }),
      ),
    [sessions],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      const matchesQuery =
        !needle ||
        session.title.toLocaleLowerCase().includes(needle) ||
        session.projectName.toLocaleLowerCase().includes(needle) ||
        agentDisplay(session.adapter).toLocaleLowerCase().includes(needle);
      return (
        matchesQuery &&
        (agent === "all" || session.adapter === agent) &&
        (project === "all" || session.projectId === project)
      );
    });
  }, [agent, project, query, sessions]);
  const groups = useMemo(() => {
    const next = new Map<string, { name: string; sessions: ArchivedSessionView[] }>();
    for (const session of visible) {
      const group = next.get(session.projectId) ?? { name: session.projectName, sessions: [] };
      group.sessions.push(session);
      next.set(session.projectId, group);
    }
    return Array.from(next.entries());
  }, [visible]);

  const restore = async (session: ArchivedSessionView) => {
    setBusyId(session.id);
    setError(null);
    try {
      await api.unarchiveSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      toast(t("settings:ui.archive.restored", { title: session.title }), "success");
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(t("settings:ui.archive.restoreFailed", { detail: errorText(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (session: ArchivedSessionView) => {
    const confirmed = await confirmDialog({
      title: t("settings:ui.archive.deleteTitle", { title: session.title }),
      body: t("settings:ui.archive.deleteBody"),
      confirmLabel: t("settings:ui.archive.permanentlyDelete"),
      danger: true,
    });
    if (!confirmed) return;
    setBusyId(session.id);
    setError(null);
    try {
      await api.deleteArchivedSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      toast(t("settings:ui.archive.deleted"), "success");
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(t("settings:ui.archive.deleteFailed", { detail: errorText(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const removeAll = async () => {
    if (sessions.length === 0) return;
    const confirmed = await confirmDialog({
      title: t("settings:ui.archive.deleteAllTitle", { count: sessions.length }),
      body: t("settings:ui.archive.deleteAllBody"),
      confirmLabel: t("settings:ui.archive.permanentlyDeleteAll"),
      danger: true,
    });
    if (!confirmed) return;
    setClearingAll(true);
    setError(null);
    try {
      await api.deleteAllArchivedSessions();
      setSessions([]);
      toast(t("settings:ui.archive.deletedAll"), "success");
      // Tree/list refresh is reconciliation only. It must never keep the
      // destructive-action spinner alive after the backend has succeeded.
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(t("settings:ui.archive.deleteAllFailed", { detail: errorText(e) }));
    } finally {
      setClearingAll(false);
    }
  };

  return (
    <section className="archive-settings" aria-labelledby="archive-heading">
      <div className="archive-heading-row">
        <div>
          <h3 id="archive-heading">{t("settings:ui.sections.archive")}</h3>
          <p>{t("settings:ui.archive.description")}</p>
        </div>
        <button
          className="btn small danger"
          disabled={sessions.length === 0 || clearingAll || busyId !== null}
          onClick={() => void removeAll()}
        >
          {clearingAll ? t("settings:ui.archive.deleting") : t("settings:ui.archive.deleteAll")}
        </button>
      </div>

      <div className="archive-filters" aria-label={t("settings:ui.archive.filtersAriaLabel")}>
        <input
          className="archive-search"
          type="search"
          value={query}
          placeholder={t("settings:ui.archive.searchPlaceholder")}
          aria-label={t("settings:ui.archive.searchAriaLabel")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={t("settings:ui.archive.agentFilterAriaLabel")}
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value="all">{t("settings:ui.archive.allAgents")}</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="kimi">Kimi Code</option>
          <option value="shell">Shell</option>
        </select>
        <select
          aria-label={t("settings:ui.archive.projectFilterAriaLabel")}
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="all">{t("settings:ui.archive.allProjects")}</option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {loading ? <div className="archive-empty dim">{t("settings:ui.archive.loading")}</div> : null}
      {!loading && !error && sessions.length === 0 ? (
        <div className="archive-empty">{t("settings:ui.archive.empty")}</div>
      ) : null}
      {!loading && !error && sessions.length > 0 && groups.length === 0 ? (
        <div className="archive-empty">{t("settings:ui.archive.noResults")}</div>
      ) : null}
      {!loading && !error
        ? groups.map(([projectId, group]) => (
            <div className="archive-project" key={projectId}>
              <div className="archive-project-head">
                <span className="archive-project-name">▱ {group.name}</span>
                <span>{t("settings:ui.archive.sessionCount", { count: group.sessions.length })}</span>
              </div>
              <div className="archive-session-list">
                {group.sessions.map((session) => {
                  const busy = busyId === session.id;
                  return (
                    <article className="archive-session-row" key={session.id}>
                      <div className="archive-session-copy">
                        <div className="archive-session-title">{session.title}</div>
                        <div className="archive-session-meta">
                          {t("settings:ui.archive.archivedAt", {
                            agent: agentDisplay(session.adapter),
                            date: formatArchivedAt(session.archivedAt),
                          })}
                        </div>
                      </div>
                      <div className="archive-session-actions">
                        <button
                          className="btn small ghost"
                          disabled={busy || clearingAll}
                          onClick={() => void remove(session)}
                        >
                          {t("common:actions.delete")}
                        </button>
                        <button
                          className="btn small"
                          disabled={busy || clearingAll}
                          onClick={() => void restore(session)}
                        >
                          {busy ? t("settings:ui.archive.processing") : t("common:actions.restore")}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))
        : null}
    </section>
  );
}

const SETTINGS_SECTIONS = [
  { id: "appearance", labelKey: "settings:ui.sections.appearance" },
  { id: "adapters", labelKey: "settings:ui.sections.adapters" },
  { id: "roles", labelKey: "settings:ui.sections.roles" },
  { id: "commitAi", labelKey: "settings:ui.sections.commitAi" },
  { id: "archive", labelKey: "settings:ui.sections.archive" },
  { id: "backup", labelKey: "settings:ui.sections.backup" },
  { id: "devices", labelKey: "settings:ui.sections.devices" },
  { id: "pairing", labelKey: "settings:ui.sections.pairing" },
  { id: "about", labelKey: "settings:ui.sections.about" },
] as const satisfies ReadonlyArray<{ id: SettingsSection; labelKey: string }>;

export default function SettingsDialog({
  initialSection = "appearance",
}: { initialSection?: SettingsSection } = {}) {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const pageRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Settings | null>(s.settings ? { ...s.settings } : null);
  const [busy, setBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const closeBlocked = busy || themeBusy || languageBusy;
  const requestClose = () => {
    if (!closeBlocked) closeDialog();
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pageRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [section]);

  if (!draft) return null;
  const patch = (p: Partial<Settings>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const dirty = s.settings !== null && JSON.stringify(draft) !== JSON.stringify(s.settings);

  const switchLanguage = async (uiLanguage: Settings["uiLanguage"]) => {
    if (languageBusy || themeBusy || !s.settings || s.settings.uiLanguage === uiLanguage) return;
    const previousSettings = s.settings;
    const previousLanguage = currentUiLanguage();
    const nextSettings = { ...previousSettings, uiLanguage, telemetryEnabled: false };
    setLanguageBusy(true);
    setError(null);
    setDraft((current) => (current ? { ...current, uiLanguage } : current));
    setState({ settings: nextSettings });
    try {
      await applyUiLanguage(uiLanguage);
      applyTerminalLanguage();
      await api.saveSettings(nextSettings);
    } catch (e) {
      setState({ settings: previousSettings });
      setDraft((current) =>
        current ? { ...current, uiLanguage: previousSettings.uiLanguage } : current,
      );
      await applyUiLanguage(previousLanguage);
      applyTerminalLanguage();
      setError(t("settings:ui.appearance.languageSaveFailed", { detail: errorText(e) }));
    } finally {
      setLanguageBusy(false);
    }
  };

  const switchTheme = async (theme: Settings["theme"]) => {
    if (themeBusy || languageBusy || !s.settings || s.settings.theme === theme) return;
    const previousSettings = s.settings;
    const nextSettings = { ...previousSettings, theme, telemetryEnabled: false };
    setThemeBusy(true);
    setError(null);
    // Theme selection is an immediate preference, independent from the rest
    // of the settings draft. Other edited fields remain unsaved until the
    // user explicitly saves them.
    setDraft((current) => (current ? { ...current, theme } : current));
    setState({ settings: nextSettings });
    applyThemeSettings();
    try {
      await api.saveSettings(nextSettings);
    } catch (e) {
      setState({ settings: previousSettings });
      setDraft((current) =>
        current ? { ...current, theme: previousSettings.theme } : current,
      );
      applyThemeSettings();
      setError(t("settings:ui.appearance.theme.switchFailed", { detail: errorText(e) }));
    } finally {
      setThemeBusy(false);
    }
  };

  const switchTerminalTheme = async (terminalTheme: TerminalThemeId) => {
    if (
      themeBusy ||
      languageBusy ||
      !s.settings ||
      s.settings.terminalTheme === terminalTheme
    ) {
      return;
    }
    const previousSettings = s.settings;
    const nextSettings = { ...previousSettings, terminalTheme, telemetryEnabled: false };
    setThemeBusy(true);
    setError(null);
    setDraft((current) => (current ? { ...current, terminalTheme } : current));
    setState({ settings: nextSettings });
    applyThemeSettings();
    try {
      await api.saveSettings(nextSettings);
    } catch (e) {
      setState({ settings: previousSettings });
      setDraft((current) =>
        current
          ? { ...current, terminalTheme: previousSettings.terminalTheme }
          : current,
      );
      applyThemeSettings();
      setError(
        t("settings:ui.appearance.terminalTheme.switchFailed", {
          detail: errorText(e),
        }),
      );
    } finally {
      setThemeBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings({ ...draft, telemetryEnabled: false });
      setState({ settings: { ...draft, telemetryEnabled: false } });
      applyThemeSettings();
      await refreshProjects();
      toast(t("settings:ui.saved"), "success");
      closeDialog();
    } catch (e) {
      setError(t("settings:ui.saveFailed", { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const appearanceSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.appearance")}</div>
        <p className="form-hint">{t("settings:ui.appearance.description")}</p>
      </div>
      <div className="settings-grid">
        <label htmlFor="set-language">{t("settings:ui.appearance.language")}</label>
        <div className="control">
          <select
            id="set-language"
            value={draft.uiLanguage}
            disabled={busy || languageBusy || themeBusy}
            onChange={(event) =>
              void switchLanguage(event.target.value as Settings["uiLanguage"])
            }
          >
            <option value="zh-CN">{t("common:language.zhCN")}</option>
            <option value="en-US">{t("common:language.enUS")}</option>
          </select>
          <span className="form-hint">{t("settings:ui.appearance.languageHint")}</span>
        </div>

        <label id="set-theme-label">{t("settings:ui.appearance.theme.label")}</label>
        <div className="control theme-control">
          <div className="theme-segmented" role="radiogroup" aria-labelledby="set-theme-label">
            {(
              [
                ["system", "settings:ui.appearance.theme.system"],
                ["light", "settings:ui.appearance.theme.light"],
                ["dark", "settings:ui.appearance.theme.dark"],
              ] as const
            ).map(([value, labelKey]) => (
              <label className="theme-segment" key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="theme"
                  value={value}
                  checked={draft.theme === value}
                  disabled={busy || themeBusy || languageBusy}
                  onChange={() => void switchTheme(value)}
                />
                <span>{t(labelKey)}</span>
              </label>
            ))}
          </div>
          <span className="sr-only" aria-live="polite">
            {t("settings:ui.appearance.theme.effective", {
              theme: t(
                s.themeEffective === "dark"
                  ? "settings:ui.appearance.theme.dark"
                  : "settings:ui.appearance.theme.light",
              ),
            })}
          </span>
        </div>

        <section
          className="terminal-theme-setting"
          aria-labelledby="set-terminal-theme-label"
        >
          <div className="terminal-theme-heading">
            <div>
              <label id="set-terminal-theme-label">
                {t("settings:ui.appearance.terminalTheme.label")}
              </label>
              <span className="form-hint">
                {t("settings:ui.appearance.terminalTheme.hint")}
              </span>
            </div>
            <span className="terminal-theme-mode">
              {t("settings:ui.appearance.terminalTheme.effective", {
                mode: t(
                  s.themeEffective === "dark"
                    ? "settings:ui.appearance.theme.dark"
                    : "settings:ui.appearance.theme.light",
                ),
              })}
            </span>
          </div>
          <div
            className="terminal-theme-grid"
            role="radiogroup"
            aria-labelledby="set-terminal-theme-label"
          >
            {TERMINAL_THEME_IDS.map((terminalTheme) => {
              const themePalette = getTerminalPalette(
                terminalTheme,
                s.themeEffective,
              ).xterm;
              const selected = draft.terminalTheme === terminalTheme;
              const descriptionId = `terminal-theme-${terminalTheme}-description`;
              return (
                <label
                  className={`terminal-theme-card${selected ? " selected" : ""}`}
                  key={terminalTheme}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="terminal-theme"
                    value={terminalTheme}
                    checked={selected}
                    disabled={busy || themeBusy || languageBusy}
                    aria-describedby={descriptionId}
                    onChange={() => void switchTerminalTheme(terminalTheme)}
                  />
                  <span
                    className="terminal-theme-preview"
                    style={{
                      background: themePalette.background,
                      color: themePalette.foreground,
                    }}
                    aria-hidden="true"
                  >
                    <span className="terminal-theme-preview-bar">
                      <span style={{ background: themePalette.red }} />
                      <span style={{ background: themePalette.yellow }} />
                      <span style={{ background: themePalette.green }} />
                    </span>
                    <span className="terminal-theme-preview-line">
                      <span style={{ color: themePalette.green }}>~/AgentPort</span>
                      <span style={{ color: themePalette.brightBlack }}> git:</span>
                      <span style={{ color: themePalette.magenta }}>main</span>
                    </span>
                    <span className="terminal-theme-preview-line">
                      <span style={{ color: themePalette.blue }}>❯</span>
                      <span> agentport</span>
                      <span style={{ color: themePalette.cyan }}> ready</span>
                    </span>
                    <span className="terminal-theme-swatches">
                      {[
                        themePalette.red,
                        themePalette.yellow,
                        themePalette.green,
                        themePalette.cyan,
                        themePalette.blue,
                        themePalette.magenta,
                      ].map((color, index) => (
                        <span key={`${terminalTheme}-${index}`} style={{ background: color }} />
                      ))}
                    </span>
                  </span>
                  <span className="terminal-theme-card-copy">
                    <span>
                      <strong>
                        {t(`settings:ui.appearance.terminalTheme.options.${terminalTheme}.name`)}
                      </strong>
                      <small id={descriptionId}>
                        {t(
                          `settings:ui.appearance.terminalTheme.options.${terminalTheme}.description`,
                        )}
                      </small>
                    </span>
                    <span className="terminal-theme-check" aria-hidden="true">
                      {selected ? "✓" : ""}
                    </span>
                    {selected ? (
                      <span className="sr-only">
                        {t("settings:ui.appearance.terminalTheme.selected")}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
          <span className="sr-only" aria-live="polite">
            {t("settings:ui.appearance.terminalTheme.current", {
              theme: t(
                `settings:ui.appearance.terminalTheme.options.${draft.terminalTheme}.name`,
              ),
            })}
          </span>
        </section>

        <label htmlFor="set-font">{t("settings:ui.appearance.font.label")}</label>
        <div className="control">
          <select
            id="set-font"
            value={draft.terminalFontFamily}
            onChange={(e) => patch({ terminalFontFamily: e.target.value })}
          >
            {!FONT_OPTIONS.some((font) => font.value === draft.terminalFontFamily) ? (
              <option value={draft.terminalFontFamily}>
                {t("settings:ui.appearance.font.custom", {
                  font: draft.terminalFontFamily,
                })}
              </option>
            ) : null}
            {FONT_OPTIONS.map((font) => (
              <option key={font.value} value={font.value}>
                {t(font.labelKey)}
              </option>
            ))}
          </select>
        </div>

        <label htmlFor="set-fontsize">{t("settings:ui.appearance.fontSize")}</label>
        <div className="control">
          <input
            id="set-fontsize"
            type="number"
            min={10}
            max={28}
            value={draft.terminalFontSize}
            onChange={(e) => patch({ terminalFontSize: Number(e.target.value) })}
          />
          <span className="form-hint">px</span>
        </div>

        <label htmlFor="set-motion">{t("settings:ui.appearance.motion.label")}</label>
        <div className="control">
          <select
            id="set-motion"
            value={draft.reducedMotion}
            onChange={(e) => patch({ reducedMotion: e.target.value as Settings["reducedMotion"] })}
          >
            <option value="system">{t("settings:ui.appearance.motion.system")}</option>
            <option value="on">{t("settings:ui.appearance.motion.on")}</option>
            <option value="off">{t("settings:ui.appearance.motion.off")}</option>
          </select>
          <span className="form-hint">{t("settings:ui.appearance.motion.hint")}</span>
        </div>

        <label htmlFor="set-sr">{t("settings:ui.appearance.screenReader.label")}</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-sr"
              type="checkbox"
              checked={draft.screenReaderMode}
              onChange={(e) => patch({ screenReaderMode: e.target.checked })}
            />
            <span>{t("settings:ui.appearance.screenReader.hint")}</span>
          </label>
        </div>

        <label
          htmlFor="set-notify"
          data-tip={t("settings:ui.notifications.systemHint")}
        >
          {t("settings:ui.notifications.systemLabel")}
        </label>
        <div className="control">
          <input
            id="set-notify"
            type="checkbox"
            checked={draft.notificationsEnabled}
            onChange={(e) => patch({ notificationsEnabled: e.target.checked })}
            aria-describedby="set-notify-hint"
          />
          <span id="set-notify-hint" className="sr-only">
            {t("settings:ui.notifications.systemHint")}{" "}
            {s.platform?.os === "macos"
              ? t("settings:ui.notifications.permissionHintMacos")
              : t("settings:ui.notifications.permissionHintLinux")}
          </span>
        </div>

        {s.platform?.os === "linux" ? (
          <>
            <label htmlFor="set-terminal-command">
              {t("settings:ui.notifications.terminalCommandLabel")}
            </label>
            <div className="control">
              <input
                id="set-terminal-command"
                type="text"
                value={draft.terminalCommand}
                placeholder={t("settings:ui.notifications.terminalCommandPlaceholder")}
                onChange={(e) => patch({ terminalCommand: e.target.value })}
              />
              <span className="form-hint">
                {t("settings:ui.notifications.terminalCommandHint")}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </>
  );

  const content = {
    appearance: appearanceSection,
    adapters: <AdapterSection agentOrder={draft.agentOrder} agentHidden={draft.agentHidden} onAgentOrderChange={(agentOrder) => patch({ agentOrder })} onAgentHiddenChange={(agentHidden) => patch({ agentHidden })} />,
    roles: <RoleSection />,
    commitAi: <CommitAiSection />,
    archive: <ArchiveSection />,
    backup: <BackupSection />,
    devices: <DeviceSettings />,
    pairing: <PairingSection />,
    about: <UpdateSection />,
  }[section];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const page = pageRef.current;
    if (!page) return;
    const items = Array.from(page.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (item) => item.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !page.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="settings-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-page-title"
      ref={pageRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="settings-page-header" data-tauri-drag-region="deep">
        <h1 id="settings-page-title" className="settings-page-breadcrumb">
          <span>{t("settings:ui.title")}</span>
          <span className="settings-page-breadcrumb-separator" aria-hidden="true">/</span>
          <span>
            {t(SETTINGS_SECTIONS.find((item) => item.id === section)?.labelKey ?? "settings:ui.title")}
          </span>
        </h1>
      </header>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label={t("settings:ui.navigationAriaLabel")}>
          <button className="settings-back" disabled={closeBlocked} onClick={requestClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M7.5 2.5 3 6l4.5 3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {t("common:actions.back")}
          </button>
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${section === item.id ? " active" : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
          <div className="settings-nav-meta">
            <a
              className="settings-author-link"
              href="https://github.com/yiwen65"
              onClick={(event) => {
                // In-app navigation would replace the settings surface, so
                // route the click through the native external-open path.
                event.preventDefault();
                void api.openExternalUrl("https://github.com/yiwen65").catch((error) =>
                  toast(i18n.t("shell:ui.sidebar.openFailed", { detail: errorText(error) }), "error"),
                );
              }}
            >
              {t("settings:ui.authorCredit")}
            </a>
          </div>
        </nav>
        <section className="settings-page-panel" aria-label={t("settings:ui.contentAriaLabel")}>
          <div ref={contentScrollRef} className="settings-content">
            <div className="settings-section-surface">
              {error ? <div className="error-bar" role="alert">{error}</div> : null}
              {content}
            </div>
          </div>
          {dirty && section !== "archive" && section !== "backup" ? (
            <footer className="settings-page-footer" data-tauri-drag-region="false">
              <button className="btn ghost" disabled={closeBlocked} onClick={requestClose}>
                {t("common:actions.cancel")}
              </button>
              <button
                className="btn primary"
                disabled={busy || themeBusy || languageBusy}
                onClick={() => void save()}
              >
                {busy ? t("common:actions.saving") : t("settings:ui.saveChanges")}
              </button>
            </footer>
          ) : null}
        </section>
      </div>
    </div>
  );
}
