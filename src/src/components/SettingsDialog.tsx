// Settings full-page surface (PRD 3.8 / 7.x): appearance & a11y,
// notifications & log limit, search index, renderer mode, Agent adapters,
// archive management, and Secret management against the system credential
// backend (never plaintext fallback).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, errorText } from "../api";
import { applyThemeSettings, refreshProjects } from "../actions";
import { agentDisplay, formatBytes, formatTime, secretBackendZh } from "../format";
import { orderAgentIds } from "../agentOrder";
import { AgentIcon } from "./AgentIcons";
import ShellIcon from "./ShellIcon";
import { closeDialog, confirmDialog, setState, toast, useStore } from "../store";
import type { AdapterInstall, ArchivedSessionView, Preset, SecretMeta, Settings } from "../types";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FONT_SUGGESTIONS = [
  "JetBrains Mono Variable",
  "SF Mono",
  "Menlo",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
];

function backendStatusText(status: string): { ok: boolean; locked: boolean; text: string } {
  if (status.startsWith("Available")) {
    const m = status.match(/\((\w+)\)/);
    return { ok: true, locked: false, text: `可用（${secretBackendZh(m?.[1] ?? "")}）` };
  }
  if (status.startsWith("Locked")) {
    const m = status.match(/\((\w+)\)/);
    return { ok: false, locked: true, text: `已锁定（${secretBackendZh(m?.[1] ?? "")}）` };
  }
  return { ok: false, locked: false, text: "不可用" };
}

function SecretSection() {
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
      setError(errorText(e));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = backendStatusText(status);

  const add = async () => {
    if (!envName.trim() || !presetId || !value) return;
    setBusy(true);
    setError(null);
    try {
      await api.secretAdd(presetId, envName.trim(), value);
      setEnvName("");
      setValue("");
      toast("已保存到系统安全存储", "success");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const meta = secrets.find((x) => x.id === id);
    const ok = await confirmDialog({
      title: `删除 Secret「${meta?.envName ?? id}」？`,
      body: "将从系统安全存储与预设引用中移除，不影响已运行的 Session。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete(id);
      await reload();
      toast("已删除", "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <>
      <div className="section-title">Secret 管理</div>
      <div className="settings-grid">
        <label>存储后端</label>
        <div className="control">
          <span className={st.ok ? "" : "warn-text"}>{st.text}</span>
          <button className="btn small ghost" onClick={() => void reload()}>
            刷新
          </button>
        </div>
      </div>
      {!st.ok ? (
        <p className="warn-text" style={{ margin: 0 }}>
          系统安全存储不可用，AgentPort 不会改用明文保存。
          {st.locked
            ? "请在系统中解锁 Keychain / Secret Service 后重试。"
            : "可解锁系统存储、改用 Shell 环境变量注入，或移除相关引用。"}
        </p>
      ) : null}
      {error ? <div className="error-bar">{error}</div> : null}
      <div className="form-row">
        <span className="form-label">添加敏感环境变量</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            style={{ flex: "1 1 140px" }}
            placeholder="环境变量名，如 KIMI_API_KEY"
            aria-label="环境变量名"
            value={envName}
            disabled={!st.ok}
            onChange={(e) => setEnvName(e.target.value)}
          />
          <select
            style={{ flex: "1 1 140px" }}
            aria-label="所属预设"
            value={presetId}
            disabled={!st.ok}
            onChange={(e) => setPresetId(e.target.value)}
          >
            <option value="">选择预设…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="password"
            style={{ flex: "1 1 160px" }}
            placeholder="值（只写入系统安全存储）"
            aria-label="Secret 值"
            value={value}
            disabled={!st.ok}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="btn"
            disabled={!st.ok || busy || !envName.trim() || !presetId || !value}
            onClick={() => void add()}
          >
            {busy ? "保存中…" : "保存到系统安全存储"}
          </button>
        </div>
        <span className="form-hint">
          原值只进入 macOS Keychain / Linux Secret Service；AgentPort 仅保存引用元数据。
        </span>
      </div>
      {secrets.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          尚未保存敏感环境变量；也可以继续使用 Shell 环境。
        </p>
      ) : (
        <table className="table" aria-label="已保存的 Secret 列表">
          <thead>
            <tr>
              <th>环境变量</th>
              <th>后端</th>
              <th>账户键</th>
              <th>更新时间</th>
              <th aria-label="操作" />
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
                    删除
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
      const bad = outcomes.filter((o) => o.state !== "available");
      if (bad.length > 0) {
        toast(
          `${bad.map((b) => `${b.displayName}：${b.reason ?? b.state}`).join("；")}`,
          "error",
        );
      } else {
        toast("全部 Agent 探测通过", "success");
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title">Agent 适配器</div>
      <p className="dim" style={{ margin: 0 }}>
        自动检测全部已注册适配器；多条安装路径会按优先级验证并自动选用可用版本。调整顺序后，项目行的快速启动图标会按相同顺序显示。
      </p>
      {s.adapters.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          尚未探测到任何 Agent CLI。
        </p>
      ) : (
        <table className="table" aria-label="Agent 适配器列表">
          <thead>
            <tr>
              <th>Agent</th>
              <th>路径</th>
              <th>版本</th>
              <th>Hook</th>
              <th>精确恢复</th>
              <th>排序</th>
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
                <td className="mono dim" style={{ wordBreak: "break-all" }}>
                  {a.executablePath}
                </td>
                <td className="dim">{a.versionText}</td>
                <td>{a.hookStatus}</td>
                <td>{a.exactResume ? "支持" : "不支持"}</td>
                <td>
                  <span className="adapter-order-actions">
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={index === 0}
                      onClick={() => move(a.agentType, -1)}
                      aria-label={`上移 ${agentDisplay(a.agentType)}`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={index === orderedAdapters.length - 1}
                      onClick={() => move(a.agentType, 1)}
                      aria-label={`下移 ${agentDisplay(a.agentType)}`}
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
          {busy ? "探测中…" : "重新检测全部"}
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            closeDialog();
            setState({ showOnboarding: true });
          }}
        >
          管理 / 新增 Agent
        </button>
      </div>
    </>
  );
}

function formatArchivedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type BackupItem = { path: string; name: string; size: number; modifiedAt: string };

/** 备份与恢复：创建经校验的全量备份、按需校验历史备份、恢复到新目录。
 *  恢复永不触碰正在运行的数据目录——换目录重启是刻意保留的手动步骤。 */
function BackupSection() {
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
      setError(errorText(e));
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
      toast(`备份完成：${r.files} 个文件，已通过完整性校验`, "success");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  const verify = async (path: string) => {
    setVerifyState((v) => ({ ...v, [path]: { ok: true, text: "校验中…" } }));
    try {
      const r = await api.backupVerify(path);
      setVerifyState((v) => ({ ...v, [path]: { ok: true, text: `完整 · ${r.files} 个文件` } }));
    } catch (e) {
      setVerifyState((v) => ({ ...v, [path]: { ok: false, text: errorText(e) } }));
    }
  };

  const restore = async () => {
    setError(null);
    const archive = await api.pickFile("AgentPort 备份");
    if (!archive) return;
    const ok = await confirmDialog({
      title: "恢复备份到新目录？",
      body: "恢复会写入一个全新的数据目录，不会修改当前正在使用的数据。完成后退出 AgentPort，用恢复目录替换原数据目录，再重新启动。",
      confirmLabel: "选择恢复位置",
    });
    if (!ok) return;
    const parent = await api.pickDirectory();
    if (!parent) return;
    setRestoring(true);
    try {
      const r = await api.backupRestore(archive, `${parent}/agentport-restored`);
      setRestored(r.restored);
      toast("恢复完成", "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <div className="settings-section-heading">
        <div className="section-title">备份与恢复</div>
        <p className="form-hint">
          备份包含数据库与全部 Session 日志；不含 Worktree、导出物与 Secret 值（恢复后需重新绑定系统安全存储中的凭据）。
        </p>
      </div>
      <div className="settings-grid">
        <label>创建备份</label>
        <div className="control">
          <button className="btn primary" disabled={creating} onClick={() => void create()}>
            {creating ? "备份中…" : "立即备份"}
          </button>
          <button
            className="btn small ghost"
            onClick={() =>
              void api.revealInFileManager(backupsDir).catch((e) => toast(errorText(e), "error"))
            }
          >
            打开备份目录
          </button>
          <span className="form-hint">保存到应用数据目录 backups/，创建后自动校验</span>
        </div>
        <label>恢复备份</label>
        <div className="control">
          <button className="btn" disabled={restoring} onClick={() => void restore()}>
            {restoring ? "恢复中…" : "从备份恢复到新目录…"}
          </button>
          <span className="form-hint">不修改当前数据；替换目录需先退出应用</span>
        </div>
      </div>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {restored ? (
        <div className="info-box" role="status">
          <div className="kv">
            <span className="k">已恢复到</span>
            <span className="v mono">{restored}</span>
          </div>
          <p className="form-hint">
            启用恢复数据：1) 退出 AgentPort；2) 将当前数据目录{" "}
            <span className="mono">{dataRoot}</span> 改名备份；3) 将恢复目录改名为该路径；4)
            重新启动 AgentPort。恢复过程不会删除任何原数据。
          </p>
          <button
            className="btn small"
            onClick={() =>
              void api.revealInFileManager(restored).catch((e) => toast(errorText(e), "error"))
            }
          >
            在访达中显示
          </button>
        </div>
      ) : null}
      <div className="section-title">已有备份</div>
      {loading ? <p className="dim">正在读取备份列表…</p> : null}
      {!loading && items.length === 0 ? <p className="dim">暂无备份。建议升级应用前手动备份一次。</p> : null}
      {!loading && items.length > 0 ? (
        <table className="table" aria-label="已有备份列表">
          <thead>
            <tr>
              <th>文件名</th>
              <th>大小</th>
              <th>修改时间</th>
              <th>状态</th>
              <th aria-label="操作" />
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
                  {verifyState[item.path]?.text ?? "未校验"}
                </td>
                <td>
                  <button className="btn small" onClick={() => void verify(item.path)}>
                    校验
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
      setError(errorText(e));
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
      toast(`已恢复「${session.title}」`, "success");
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (session: ArchivedSessionView) => {
    const confirmed = await confirmDialog({
      title: `永久删除「${session.title}」？`,
      body: "会停止残留进程，并永久删除该会话的归档记录、终端日志和搜索索引；此操作不可恢复。",
      confirmLabel: "永久删除",
      danger: true,
    });
    if (!confirmed) return;
    setBusyId(session.id);
    setError(null);
    try {
      await api.deleteArchivedSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      toast("归档会话已永久删除", "success");
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const removeAll = async () => {
    if (sessions.length === 0) return;
    const confirmed = await confirmDialog({
      title: `永久删除全部 ${sessions.length} 个归档会话？`,
      body: "会停止残留进程，并永久删除全部归档记录、终端日志和搜索索引；此操作不可恢复。",
      confirmLabel: "全部永久删除",
      danger: true,
    });
    if (!confirmed) return;
    setClearingAll(true);
    setError(null);
    try {
      await api.deleteAllArchivedSessions();
      setSessions([]);
      toast("全部归档会话已永久删除", "success");
      // Tree/list refresh is reconciliation only. It must never keep the
      // destructive-action spinner alive after the backend has succeeded.
      void reload();
      void refreshProjects();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setClearingAll(false);
    }
  };

  return (
    <section className="archive-settings" aria-labelledby="archive-heading">
      <div className="archive-heading-row">
        <div>
          <h3 id="archive-heading">归档会话</h3>
          <p>已归档的会话不会出现在项目树中；可恢复或永久删除。</p>
        </div>
        <button
          className="btn small danger"
          disabled={sessions.length === 0 || clearingAll || busyId !== null}
          onClick={() => void removeAll()}
        >
          {clearingAll ? "删除中…" : "删除全部"}
        </button>
      </div>

      <div className="archive-filters" aria-label="归档会话筛选">
        <input
          className="archive-search"
          type="search"
          value={query}
          placeholder="搜索归档会话"
          aria-label="搜索归档会话"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select aria-label="按 Agent 筛选" value={agent} onChange={(event) => setAgent(event.target.value)}>
          <option value="all">全部 Agent</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="kimi">Kimi Code</option>
          <option value="shell">Shell</option>
        </select>
        <select aria-label="按项目筛选" value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="all">全部项目</option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {loading ? <div className="archive-empty dim">正在读取归档会话…</div> : null}
      {!loading && !error && sessions.length === 0 ? (
        <div className="archive-empty">暂无归档会话</div>
      ) : null}
      {!loading && !error && sessions.length > 0 && groups.length === 0 ? (
        <div className="archive-empty">没有符合当前筛选条件的归档会话</div>
      ) : null}
      {!loading && !error
        ? groups.map(([projectId, group]) => (
            <div className="archive-project" key={projectId}>
              <div className="archive-project-head">
                <span className="archive-project-name">▱ {group.name}</span>
                <span>{group.sessions.length} 个会话</span>
              </div>
              <div className="archive-session-list">
                {group.sessions.map((session) => {
                  const busy = busyId === session.id;
                  return (
                    <article className="archive-session-row" key={session.id}>
                      <div className="archive-session-copy">
                        <div className="archive-session-title">{session.title}</div>
                        <div className="archive-session-meta">
                          {agentDisplay(session.adapter)} · 归档于 {formatArchivedAt(session.archivedAt)}
                        </div>
                      </div>
                      <div className="archive-session-actions">
                        <button
                          className="btn small ghost"
                          disabled={busy || clearingAll}
                          onClick={() => void remove(session)}
                        >
                          删除
                        </button>
                        <button
                          className="btn small"
                          disabled={busy || clearingAll}
                          onClick={() => void restore(session)}
                        >
                          {busy ? "处理中…" : "恢复"}
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
  | "secrets"
  | "archive"
  | "backup";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "外观与可访问性" },
  { id: "notifications", label: "通知与日志" },
  { id: "search", label: "搜索与渲染" },
  { id: "adapters", label: "Agent 适配器" },
  { id: "secrets", label: "Secret 管理" },
  { id: "archive", label: "归档会话" },
  { id: "backup", label: "备份与恢复" },
];

export default function SettingsDialog() {
  const s = useStore();
  const pageRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Settings | null>(s.settings ? { ...s.settings } : null);
  const [busy, setBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>("appearance");

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
      setError(`主题切换失败：${errorText(e)}`);
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
      toast("设置已保存", "success");
      closeDialog();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const appearanceSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">外观与可访问性</div>
        <p className="form-hint">控制窗口、终端和状态反馈的视觉表现。</p>
      </div>
      <div className="settings-grid">
        <label id="set-theme-label">主题</label>
        <div className="control theme-control">
          <div className="theme-segmented" role="radiogroup" aria-labelledby="set-theme-label">
            {(
              [
                ["system", "系统"],
                ["light", "浅色"],
                ["dark", "深色"],
              ] as const
            ).map(([value, label]) => (
              <label className="theme-segment" key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="theme"
                  value={value}
                  checked={draft.theme === value}
                  disabled={busy || themeBusy}
                  onChange={() => void switchTheme(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <span className="sr-only" aria-live="polite">
            当前生效：{s.themeEffective === "dark" ? "深色" : "浅色"}
          </span>
        </div>

        <label htmlFor="set-font">终端字体族</label>
        <div className="control">
          <input
            id="set-font"
            type="text"
            list="font-suggestions"
            value={draft.terminalFontFamily === "system-monospace" ? "" : draft.terminalFontFamily}
            placeholder="JetBrains Mono"
            onChange={(e) =>
              patch({ terminalFontFamily: e.target.value.trim() || "system-monospace" })
            }
          />
          <datalist id="font-suggestions">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>

        <label htmlFor="set-fontsize">终端字号（10–28）</label>
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

        <label htmlFor="set-motion">减少动效</label>
        <div className="control">
          <select
            id="set-motion"
            value={draft.reducedMotion}
            onChange={(e) => patch({ reducedMotion: e.target.value as Settings["reducedMotion"] })}
          >
            <option value="system">跟随系统</option>
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </select>
          <span className="form-hint">开启后移除位移动画，仅保留透明度变化</span>
        </div>

        <label htmlFor="set-sr">屏幕阅读器模式</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-sr"
              type="checkbox"
              checked={draft.screenReaderMode}
              onChange={(e) => patch({ screenReaderMode: e.target.checked })}
            />
            <span>启用终端无障碍树与状态变化朗读</span>
          </label>
        </div>
      </div>
    </>
  );

  const notificationsSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">通知与日志</div>
        <p className="form-hint">控制状态变化提醒和日志保留范围。</p>
      </div>
      <div className="settings-grid">
        <label htmlFor="set-notify">系统通知</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-notify"
              type="checkbox"
              checked={draft.notificationsEnabled}
              onChange={(e) => patch({ notificationsEnabled: e.target.checked })}
            />
            <span>状态变化时发送系统通知（应用内未读始终生效）</span>
          </label>
        </div>

        <label htmlFor="set-loglimit">日志上限（20–2048 MiB）</label>
        <div className="control">
          <input
            id="set-loglimit"
            type="number"
            min={20}
            max={2048}
            value={draft.logLimitMib}
            onChange={(e) => patch({ logLimitMib: Number(e.target.value) })}
          />
          <span className="form-hint">达到上限后历史日志轮转，仅保留最近部分</span>
        </div>

      </div>
    </>
  );

  const searchSection = (
    <>
      <div className="settings-section-heading">
        <div className="section-title">搜索与渲染</div>
        <p className="form-hint">控制终端索引和终端渲染器。</p>
      </div>
      <div className="settings-grid">
        <label htmlFor="set-index">搜索索引</label>
        <div className="control">
          <label className="check-row">
            <input
              id="set-index"
              type="checkbox"
              checked={draft.searchIndexEnabled}
              onChange={(e) => patch({ searchIndexEnabled: e.target.checked })}
            />
            <span>索引终端文本（源日志不被修改，索引可随时重建）</span>
          </label>
        </div>
        <label>索引状态</label>
        <div className="control">
          <span className="mono">{s.indexState}</span>
          <button
            className="btn small"
            onClick={() => {
              toast("已开始后台重建搜索索引", "info");
              api
                .rebuildSearchIndex()
                .then(() => toast("搜索索引重建完成", "success"))
                .catch((e) => toast(`重建失败：${errorText(e)}`, "error"));
            }}
          >
            手动重建
          </button>
        </div>
        <label>渲染模式</label>
        <div className="control">
          <span>稳定终端渲染器</span>
          {s.rendererFallbackReason ? (
            <span className="form-hint">{s.rendererFallbackReason}</span>
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
    secrets: <SecretSection />,
    archive: <ArchiveSection />,
    backup: <BackupSection />,
  }[section];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
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
          <span>设置</span>
          <span className="settings-page-breadcrumb-separator" aria-hidden="true">/</span>
          <span>{SETTINGS_SECTIONS.find((item) => item.id === section)?.label}</span>
        </h1>
      </header>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="设置分类">
          <button className="settings-back" onClick={closeDialog}>
            返回
          </button>
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${section === item.id ? " active" : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <section className="settings-page-panel" aria-label="设置内容">
          <div className="settings-content">
            {error ? <div className="error-bar" role="alert">{error}</div> : null}
            {content}
          </div>
          {dirty && section !== "archive" && section !== "backup" ? (
            <footer className="settings-page-footer" data-tauri-drag-region="false">
              <button className="btn ghost" onClick={closeDialog}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={busy || themeBusy}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : "保存更改"}
              </button>
            </footer>
          ) : null}
        </section>
      </div>
    </div>
  );
}
