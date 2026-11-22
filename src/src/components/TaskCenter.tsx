import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { findSession, useStore } from "../store";

type Provider = "github" | "gitlab";
type TaskScope = "issues" | "pulls" | "projects" | "boards";
type TaskRecord = Record<string, unknown>;
type TaskResponse = { repository?: unknown; data?: { items?: unknown[] } | null; items?: unknown[]; error?: { message?: string } | null };
const scopes: Array<{ id: TaskScope; label: string }> = [
  { id: "issues", label: "Issues" }, { id: "pulls", label: "Pull Requests" },
  { id: "projects", label: "Projects" }, { id: "boards", label: "Boards" },
];
function asRecord(value: unknown): TaskRecord | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as TaskRecord : null; }
function asItems(value: unknown): TaskRecord[] {
  const response = asRecord(value) as TaskResponse | null;
  return (response?.data?.items ?? response?.items ?? []).filter((item): item is TaskRecord => asRecord(item) !== null).map((item) => item as TaskRecord);
}
function text(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value : fallback; }
function taskTitle(task: TaskRecord): string { return text(task.title, text(task.name, "Untitled task")); }
function taskUrl(task: TaskRecord): string | null { const value = task.url ?? task.htmlUrl ?? task.webUrl ?? task.html_url; return typeof value === "string" && /^https?:\/\//.test(value) ? value : null; }
function taskMeta(task: TaskRecord): string | null { const number = typeof task.number === "number" ? `#${task.number}` : null; const state = typeof task.state === "string" ? task.state : null; return [number, state].filter(Boolean).join(" · ") || null; }
function repositoryName(value: unknown): string | null { const repository = asRecord(value); if (!repository) return null; if (typeof repository.fullName === "string") return repository.fullName; if (typeof repository.nameWithOwner === "string") return repository.nameWithOwner; if (typeof repository.projectPath === "string") return repository.projectPath; return typeof repository.name === "string" ? repository.name : null; }

function useTasks(projectId: string | null, provider: Provider, open: boolean) {
  const [items, setItems] = useState<Record<TaskScope, TaskRecord[]>>({ issues: [], pulls: [], projects: [], boards: [] });
  const [repository, setRepository] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!open) return; let cancelled = false;
    if (!projectId) { setItems({ issues: [], pulls: [], projects: [], boards: [] }); setRepository(null); setError("Select a project or session before opening Task Center."); return; }
    setLoading(true); setError(null);
    const supported = provider === "github" ? scopes.filter(({ id }) => id !== "boards") : scopes.filter(({ id }) => id !== "projects");
    void Promise.all(supported.map(async ({ id }) => [id, provider === "github" ? await api.listGithubTasks(projectId, id as "issues" | "pulls" | "projects") : await api.listGitlabTasks(projectId, id as "issues" | "pulls" | "boards")] as const)).then((results) => {
      if (cancelled) return; const next = { issues: [], pulls: [], projects: [], boards: [] } as Record<TaskScope, TaskRecord[]>; let nextRepository: string | null = null;
      for (const [scope, value] of results) { const response = asRecord(value) as TaskResponse | null; next[scope] = asItems(value); nextRepository = nextRepository ?? repositoryName(response?.repository); if (response?.error?.message) throw new Error(response.error.message); }
      setItems(next); setRepository(nextRepository);
    }).catch((reason: unknown) => { if (!cancelled) { setItems({ issues: [], pulls: [], projects: [], boards: [] }); setRepository(null); setError(errorText(reason)); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, provider, revision]);
  return { items, repository, loading, error, refresh };
}

export default function TaskCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>("github");
  const activeProjectId = useStore((state) => { const session = findSession(state.projects, state.activeSessionId); return session?.projectId ?? null; });
  const [activeTab, setActiveTab] = useState<TaskScope>("issues");
  const { items, repository, loading, error, refresh } = useTasks(activeProjectId, provider, open);
  const activeItems = items[activeTab]; const activeLabel = useMemo(() => scopes.find((scope) => scope.id === activeTab)?.label ?? "Tasks", [activeTab]);
  if (!open) return null;
  const visibleScopes = scopes.filter(({ id }) => provider === "github" ? id !== "boards" : id !== "projects");
  return <div className="task-center-layer"><section className="task-center-panel" aria-label={`${provider === "github" ? "GitHub" : "GitLab"} Task Center`}>
    <header className="task-center-header"><div><h2>{provider === "github" ? "GitHub" : "GitLab"} Task Center</h2><p>{repository ?? "Read-only task list"}</p></div><div className="task-center-actions"><button className="btn btn-compact" type="button" onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button><button className="btn btn-compact" type="button" onClick={onClose}>Close</button></div></header>
    <div className="task-center-tabs" role="tablist" aria-label="Task provider and type"><button type="button" className="task-center-tab" aria-pressed={provider === "github"} onClick={() => { setProvider("github"); setActiveTab("issues"); }}>GitHub</button><button type="button" className="task-center-tab" aria-pressed={provider === "gitlab"} onClick={() => { setProvider("gitlab"); setActiveTab("issues"); }}>GitLab</button>{visibleScopes.map((scope) => <button key={scope.id} id={`task-tab-${scope.id}`} className="task-center-tab" type="button" role="tab" aria-selected={activeTab === scope.id} onClick={() => setActiveTab(scope.id)}>{scope.label}{!loading && items[scope.id].length > 0 ? <span>{items[scope.id].length}</span> : null}</button>)}</div>
    <div id={`task-panel-${activeTab}`} className="task-center-content" role="tabpanel" tabIndex={0}>{loading ? <p className="task-center-state" role="status">Loading {activeLabel.toLowerCase()}…</p> : null}{!loading && error ? <div className="task-center-state task-center-error" role="alert"><strong>Could not load tasks</strong><p>{error}</p><button className="btn btn-compact" type="button" onClick={refresh}>Try again</button></div> : null}{!loading && !error && activeItems.length === 0 ? <p className="task-center-state">No {activeLabel.toLowerCase()} found.</p> : null}{!loading && !error && activeItems.length > 0 ? <ul className="task-center-list">{activeItems.map((task, index) => { const url = taskUrl(task); const meta = taskMeta(task); return <li key={String(task.id ?? task.nodeId ?? task.number ?? index)} className="task-center-row"><div className="task-center-row-copy">{url ? <a href={url} target="_blank" rel="noreferrer">{taskTitle(task)}</a> : <strong>{taskTitle(task)}</strong>}{meta ? <span>{meta}</span> : null}</div>{url ? <a className="task-center-open" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${taskTitle(task)} in browser`}>↗</a> : null}</li>; })}</ul> : null}</div>
  </section></div>;
}
