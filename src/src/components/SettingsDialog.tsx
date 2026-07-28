// Settings full-page surface (PRD 3.8 / 7.x): appearance & a11y,
// notifications & log limit, search index, renderer mode, Agent adapters,
// archive management, and Secret management against the system credential
// backend (never plaintext fallback).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, commitAiErrorText, errorText } from "../api";
import { applyThemeSettings, refreshProjects } from "../actions";
import {
  agentDisplay,
  formatBytes,
  formatTime,
  indexStateLabel,
  presetDisplayName,
  secretBackendZh,
} from "../format";
import { applyUiLanguage, currentUiLanguage, i18n } from "../i18n";
import { orderAgentIds } from "../agentOrder";
import { applyTerminalLanguage } from "../terminals";
import { AgentIcon } from "./AgentIcons";
import ShellIcon from "./ShellIcon";
import { closeDialog, confirmDialog, setState, toast, useStore } from "../store";
import type {
  AdapterInstall,
  ArchivedSessionView,
  CommitAiConfig,
  CommitAiLanguage,
  CommitAiProvider,
  Preset,
  SecretMeta,
  Settings,
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

function backendStatus(status: string): { ok: boolean; locked: boolean; backend: string } {
  if (status.startsWith("Available")) {
    const m = status.match(/\((\w+)\)/);
    return { ok: true, locked: false, backend: secretBackendZh(m?.[1] ?? "") };
  }
  if (status.startsWith("Locked")) {
    const m = status.match(/\((\w+)\)/);
    return { ok: false, locked: true, backend: secretBackendZh(m?.[1] ?? "") };
  }
  return { ok: false, locked: false, backend: "" };
}

function SecretSection() {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const [status, setStatus] = useState(s.secretBackend);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [envName, setEnvName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [st, list, pre] = await Promise.all([
        api.secretStatus(),
        api.secretList(),
        api.listPresets(null),
      ]);
      setStatus(st);
      setSecrets(list);
      setPresets(pre);
      setState({ secretBackend: st });
    } catch (e) {
      setError(t("settings:ui.secrets.loadFailed", { detail: errorText(e) }));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = backendStatus(status);
  const statusText = st.ok
    ? t("settings:ui.secrets.backendAvailable", { backend: st.backend })
    : st.locked
      ? t("settings:ui.secrets.backendLocked", { backend: st.backend })
      : t("common:status.unavailable");

  const add = async () => {
    if (!envName.trim() || !presetId || !value) return;
    setBusy(true);
    setError(null);
    try {
      await api.secretAdd(presetId, envName.trim(), value);
      setEnvName("");
      setValue("");
      toast(t("settings:ui.secrets.saved"), "success");
      await reload();
    } catch (e) {
      setError(t("settings:ui.secrets.saveFailed", { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const meta = secrets.find((x) => x.id === id);
    const ok = await confirmDialog({
      title: t("settings:ui.secrets.deleteTitle", { name: meta?.envName ?? id }),
      body: t("settings:ui.secrets.deleteBody"),
      confirmLabel: t("common:actions.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete(id);
      await reload();
      toast(t("settings:ui.secrets.deleted"), "success");
    } catch (e) {
      toast(t("settings:ui.secrets.deleteFailed", { detail: errorText(e) }), "error");
    }
  };

  return (
    <>
      <div className="section-title">{t("settings:ui.sections.secrets")}</div>
      <div className="settings-grid">
        <label>{t("settings:ui.secrets.backendLabel")}</label>
        <div className="control">
          <span className={st.ok ? "" : "warn-text"}>{statusText}</span>
          <button className="btn small ghost" onClick={() => void reload()}>
            {t("common:actions.refresh")}
          </button>
        </div>
      </div>
      {!st.ok ? (
        <p className="warn-text" style={{ margin: 0 }}>
          {t("settings:ui.secrets.unavailableWarning")}{" "}
          {st.locked
            ? t("settings:ui.secrets.lockedHint")
            : t("settings:ui.secrets.unavailableHint")}
        </p>
      ) : null}
      {error ? <div className="error-bar">{error}</div> : null}
      <div className="form-row">
        <span className="form-label">{t("settings:ui.secrets.addLabel")}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            style={{ flex: "1 1 140px" }}
            placeholder={t("settings:ui.secrets.envPlaceholder")}
            aria-label={t("settings:ui.secrets.envAriaLabel")}
            value={envName}
            disabled={!st.ok}
            onChange={(e) => setEnvName(e.target.value)}
          />
          <select
            style={{ flex: "1 1 140px" }}
            aria-label={t("settings:ui.secrets.presetAriaLabel")}
            value={presetId}
            disabled={!st.ok}
            onChange={(e) => setPresetId(e.target.value)}
          >
            <option value="">{t("settings:ui.secrets.selectPreset")}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {presetDisplayName(p)}
              </option>
            ))}
          </select>
          <input
            type="password"
            style={{ flex: "1 1 160px" }}
            placeholder={t("settings:ui.secrets.valuePlaceholder")}
            aria-label={t("settings:ui.secrets.valueAriaLabel")}
            value={value}
            disabled={!st.ok}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="btn"
            disabled={!st.ok || busy || !envName.trim() || !presetId || !value}
            onClick={() => void add()}
          >
            {busy ? t("common:actions.saving") : t("settings:ui.secrets.save")}
          </button>
        </div>
        <span className="form-hint">
          {t("settings:ui.secrets.valueHint")}
        </span>
      </div>
      {secrets.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          {t("settings:ui.secrets.empty")}
        </p>
      ) : (
        <table className="table" aria-label={t("settings:ui.secrets.tableAriaLabel")}>
          <thead>
            <tr>
              <th>{t("settings:ui.secrets.columns.environmentVariable")}</th>
              <th>{t("settings:ui.secrets.columns.backend")}</th>
              <th>{t("settings:ui.secrets.columns.accountKey")}</th>
              <th>{t("settings:ui.secrets.columns.updatedAt")}</th>
              <th aria-label={t("settings:ui.columns.actions")} />
            </tr>
          </thead>
          <tbody>
            {secrets.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.envName}</td>
                <td>{secretBackendZh(m.backend)}</td>
                <td className="mono dim">{m.account ?? "—"}</td>
                <td className="dim">{m.updatedAt ? m.updatedAt.slice(0, 10) : "—"}</td>
                <td>
                  <button className="btn small danger" onClick={() => void remove(m.id)}>
                    {t("common:actions.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

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
                    ["zh", "中文"],
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

function AdapterSection({
  agentOrder,
  onAgentOrderChange,
}: {
  agentOrder: string[];
  onAgentOrderChange: (next: string[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const [busy, setBusy] = useState(false);
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
  const reprobe = async () => {
    setBusy(true);
    try {
      const outcomes = await api.probeAgents();
      const installs = outcomes
        .map((o) => o.install)
        .filter((x): x is AdapterInstall => x !== null);
      setState({ adapters: installs });
      if (installs.length > 0) {
        toast(t("settings:ui.adapters.probePassed", { count: installs.length }), "success");
      } else {
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
      <div className="section-title">{t("settings:ui.sections.adapters")}</div>
      <p className="dim" style={{ margin: 0 }}>
        {t("settings:ui.adapters.description")}
      </p>
      {s.adapters.length === 0 ? (
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="control" style={{ display: "flex", gap: 8 }}>
        <button className="btn small" disabled={busy} onClick={() => void reprobe()}>
          {busy ? t("settings:ui.adapters.probing") : t("settings:ui.adapters.reprobeAll")}
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            closeDialog();
            setState({ showOnboarding: true });
          }}
        >
          {t("settings:ui.adapters.manage")}
        </button>
      </div>
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

/** Backup and restore: create verified full backups, verify existing backups on
 * demand, and restore into a new directory without touching live data. */
function BackupSection() {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const dataRoot = s.exportsDir.replace(/\/exports$/, "");
  const backupsDir = `${dataRoot}/backups`;
  const [items, setItems] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [verifyState, setVerifyState] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
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

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const r = await api.backupCreate(null);
      toast(t("settings:ui.backup.createComplete", { count: r.files }), "success");
      await reload();
    } catch (e) {
      setError(t("settings:ui.backup.createFailed", { detail: errorText(e) }));
    } finally {
      setCreating(false);
    }
  };

  const verify = async (path: string) => {
    setVerifyState((v) => ({
      ...v,
      [path]: { ok: true, text: t("settings:ui.backup.verifying") },
    }));
    try {
      const r = await api.backupVerify(path);
      setVerifyState((v) => ({
        ...v,
        [path]: {
          ok: true,
          text: t("settings:ui.backup.verificationComplete", { count: r.files }),
        },
      }));
    } catch (e) {
      setVerifyState((v) => ({
        ...v,
        [path]: {
          ok: false,
          text: t("settings:ui.backup.verifyFailed", { detail: errorText(e) }),
        },
      }));
    }
  };

  const restore = async () => {
    setError(null);
    const archive = await api.pickFile(t("settings:ui.backup.filePickerTitle"));
    if (!archive) return;
    const ok = await confirmDialog({
      title: t("settings:ui.backup.restoreTitle"),
      body: t("settings:ui.backup.restoreBody"),
      confirmLabel: t("settings:ui.backup.chooseRestoreLocation"),
    });
    if (!ok) return;
    const parent = await api.pickDirectory();
    if (!parent) return;
    setRestoring(true);
    try {
      const r = await api.backupRestore(archive, `${parent}/agentport-restored`);
      setRestored(r.restored);
      toast(t("settings:ui.backup.restoreComplete"), "success");
    } catch (e) {
      setError(t("settings:ui.backup.restoreFailed", { detail: errorText(e) }));
    } finally {
      setRestoring(false);
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
      <div className="settings-grid">
        <label>{t("settings:ui.backup.createLabel")}</label>
        <div className="control">
          <button className="btn primary" disabled={creating} onClick={() => void create()}>
            {creating ? t("settings:ui.backup.creating") : t("settings:ui.backup.createNow")}
          </button>
          <button
            className="btn small ghost"
            onClick={() =>
              void api.revealInFileManager(backupsDir).catch((e) =>
                toast(t("settings:ui.backup.openDirectoryFailed", { detail: errorText(e) }), "error"))
            }
          >
            {t("settings:ui.backup.openDirectory")}
          </button>
          <span className="form-hint">{t("settings:ui.backup.createHint")}</span>
        </div>
        <label>{t("settings:ui.backup.restoreLabel")}</label>
        <div className="control">
          <button className="btn" disabled={restoring} onClick={() => void restore()}>
            {restoring ? t("settings:ui.backup.restoring") : t("settings:ui.backup.restoreToNew")}
          </button>
          <span className="form-hint">{t("settings:ui.backup.restoreHint")}</span>
        </div>
      </div>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {restored ? (
        <div className="info-box" role="status">
          <div className="kv">
            <span className="k">{t("settings:ui.backup.restoredTo")}</span>
            <span className="v mono">{restored}</span>
          </div>
          <p className="form-hint">
            {t("settings:ui.backup.instructionsBeforePath")}{" "}
            <span className="mono">{dataRoot}</span>{" "}
            {t("settings:ui.backup.instructionsAfterPath")}
          </p>
          <button
            className="btn small"
            onClick={() =>
              void api.revealInFileManager(restored).catch((e) =>
                toast(t("settings:ui.backup.revealRestoredFailed", { detail: errorText(e) }), "error"))
            }
          >
            {t("settings:ui.backup.revealRestored")}
          </button>
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
                <td className={verifyState[item.path]?.ok === false ? "warn-text" : "dim"}>
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
    void reload();
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

type SettingsSection =
  | "appearance"
  | "notifications"
  | "search"
  | "adapters"
  | "commitAi"
  | "secrets"
  | "archive"
  | "backup";

const SETTINGS_SECTIONS = [
  { id: "appearance", labelKey: "settings:ui.sections.appearance" },
  { id: "notifications", labelKey: "settings:ui.sections.notifications" },
  { id: "search", labelKey: "settings:ui.sections.search" },
  { id: "adapters", labelKey: "settings:ui.sections.adapters" },
  { id: "commitAi", labelKey: "settings:ui.sections.commitAi" },
  { id: "secrets", labelKey: "settings:ui.sections.secrets" },
  { id: "archive", labelKey: "settings:ui.sections.archive" },
  { id: "backup", labelKey: "settings:ui.sections.backup" },
] as const satisfies ReadonlyArray<{ id: SettingsSection; labelKey: string }>;

export default function SettingsDialog() {
  const { t } = useTranslation(["settings", "common"]);
  const s = useStore();
  const pageRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Settings | null>(s.settings ? { ...s.settings } : null);
  const [busy, setBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const closeBlocked = busy || themeBusy || languageBusy;
  const requestClose = () => {
    if (!closeBlocked) closeDialog();
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const page = pageRef.current;
    const first = page?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? page)?.focus();
    return () => previous?.focus?.();
  }, []);

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
    if (themeBusy || !s.settings || s.settings.theme === theme) return;
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
      </div>
    </>
  );

  const notificationsSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.notifications")}</div>
        <p className="form-hint">{t("settings:ui.notifications.description")}</p>
      </div>
      <div className="settings-grid">
        <label htmlFor="set-notify">{t("settings:ui.notifications.systemLabel")}</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-notify"
              type="checkbox"
              checked={draft.notificationsEnabled}
              onChange={(e) => patch({ notificationsEnabled: e.target.checked })}
            />
            <span>{t("settings:ui.notifications.systemHint")}</span>
          </label>
          <span className="form-hint">
            {s.platform?.os === "macos"
              ? t("settings:ui.notifications.permissionHintMacos")
              : t("settings:ui.notifications.permissionHintLinux")}
          </span>
        </div>

        <label htmlFor="set-loglimit">{t("settings:ui.notifications.logLimitLabel")}</label>
        <div className="control">
          <input
            id="set-loglimit"
            type="number"
            min={20}
            max={2048}
            value={draft.logLimitMib}
            onChange={(e) => patch({ logLimitMib: Number(e.target.value) })}
          />
          <span className="form-hint">{t("settings:ui.notifications.logLimitHint")}</span>
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

  const searchSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">{t("settings:ui.sections.search")}</div>
        <p className="form-hint">{t("settings:ui.search.description")}</p>
      </div>
      <div className="settings-grid">
        <label htmlFor="set-index">{t("settings:ui.search.indexLabel")}</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-index"
              type="checkbox"
              checked={draft.searchIndexEnabled}
              onChange={(e) => patch({ searchIndexEnabled: e.target.checked })}
            />
            <span>{t("settings:ui.search.indexHint")}</span>
          </label>
        </div>
        <label>{t("settings:ui.search.indexStatus")}</label>
        <div className="control">
          <span>{indexStateLabel(s.indexState)}</span>
          <button
            className="btn small"
            onClick={() => {
              toast(t("settings:ui.search.rebuildStarted"), "info");
              api
                .rebuildSearchIndex()
                .then(() => toast(t("settings:ui.search.rebuildComplete"), "success"))
                .catch((e) =>
                  toast(
                    t("settings:ui.search.rebuildFailed", { detail: errorText(e) }),
                    "error",
                  ),
                );
            }}
          >
            {t("settings:ui.search.rebuild")}
          </button>
        </div>
        <label>{t("settings:ui.search.rendererLabel")}</label>
        <div className="control">
          <span>{t("settings:ui.search.stableRenderer")}</span>
          {s.rendererFallbackReason ? (
            <span className="form-hint">
              {t("settings:ui.search.canvasRendererUnavailable", {
                detail: s.rendererFallbackReason,
              })}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  const content = {
    appearance: appearanceSection,
    notifications: notificationsSection,
    search: searchSection,
    adapters: <AdapterSection agentOrder={draft.agentOrder} onAgentOrderChange={(agentOrder) => patch({ agentOrder })} />,
    commitAi: <CommitAiSection />,
    secrets: <SecretSection />,
    archive: <ArchiveSection />,
    backup: <BackupSection />,
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
          <div className="settings-content">
            {error ? <div className="error-bar" role="alert">{error}</div> : null}
            {content}
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
