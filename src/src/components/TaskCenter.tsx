import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { findSession, useStore } from "../store";

type TaskScope = "issues" | "pulls" | "projects";

type TaskRecord = Record<string, unknown>;
type TaskResponse = {
  scope?: string;
  repository?: unknown;
  data?: { items?: unknown[] } | null;
  error?: { message?: string } | null;
};

const scopes: Array<{ id: TaskScope; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "pulls", label: "Pull Requests" },
  { id: "projects", label: "Projects" },
];

function asRecord(value: unknown): TaskRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as TaskRecord
    : null;
}

function asItems(value: unknown): TaskRecord[] {
  const response = asRecord(value) as TaskResponse | null;
  const items = response?.data?.items ?? [];
  return items
    .filter((item): item is TaskRecord => asRecord(item) !== null)
    .map((item) => item as TaskRecord);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function taskTitle(task: TaskRecord): string {
  return text(task.title, text(task.name, "Untitled task"));
}

function taskUrl(task: TaskRecord): string | null {
  const value = task.url ?? task.htmlUrl ?? task.webUrl ?? task.html_url;
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

function taskMeta(task: TaskRecord): string | null {
  const number = typeof task.number === "number" ? `#${task.number}` : null;
  const state = typeof task.state === "string" ? task.state : null;
  const owner = asRecord(task.author) ?? asRecord(task.user);
  const login = owner && typeof owner.login === "string" ? owner.login : null;
  return [number, state, login ? `@${login}` : null].filter(Boolean).join(" · ") || null;
}

function repositoryName(value: unknown): string | null {
  const repository = asRecord(value);
  if (!repository) return null;
  if (typeof repository.fullName === "string") return repository.fullName;
  if (typeof repository.nameWithOwner === "string") return repository.nameWithOwner;
  const owner = repository.owner;
  const name = repository.name;
  if (typeof owner === "string" && typeof name === "string") return `${owner}/${name}`;
  return typeof name === "string" ? name : null;
}

function useGithubTasks(projectId: string | null, open: boolean) {
  const [items, setItems] = useState<Record<TaskScope, TaskRecord[]>>({ issues: [], pulls: [], projects: [] });
  const [repository, setRepository] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!projectId) {
      setItems({ issues: [], pulls: [], projects: [] });
      setRepository(null);
      setError("Select a project or session before opening GitHub Task Center.");
      return;
    }
    setLoading(true);
    setError(null);
    void Promise.all(scopes.map(async ({ id }) => [id, await api.listGithubTasks(projectId, id)] as const))
      .then((results) => {
        if (cancelled) return;
        const next = { issues: [], pulls: [], projects: [] } as Record<TaskScope, TaskRecord[]>;
        let nextRepository: string | null = null;
        for (const [scope, value] of results) {
          const response = asRecord(value) as TaskResponse | null;
          next[scope] = asItems(value);
          nextRepository = nextRepository ?? repositoryName(response?.repository);
          if (response?.error?.message) {
            throw new Error(response.error.message);
          }
        }
        setItems(next);
        setRepository(nextRepository);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setItems({ issues: [], pulls: [], projects: [] });
          setRepository(null);
          setError(errorText(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, projectId, revision]);

  return { items, repository, loading, error, refresh };
}

export default function TaskCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activeProjectId = useStore((state) => {
    const session = findSession(state.projects, state.activeSessionId);
    return session?.projectId ?? null;
  });
  const [activeTab, setActiveTab] = useState<TaskScope>("issues");
  const { items, repository, loading, error, refresh } = useGithubTasks(activeProjectId, open);
  const activeItems = items[activeTab];
  const activeLabel = useMemo(
    () => scopes.find((scope) => scope.id === activeTab)?.label ?? "Tasks",
    [activeTab],
  );

  if (!open) return null;
  return (
    <div className="task-center-layer">
      <section className="task-center-panel" aria-label="GitHub Task Center">
        <header className="task-center-header">
          <div>
            <h2>GitHub Task Center</h2>
            <p>{repository ?? "Read-only Issues, Pull Requests, and Projects"}</p>
          </div>
          <div className="task-center-actions">
            <button className="btn btn-compact" type="button" onClick={refresh} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button className="btn btn-compact" type="button" onClick={onClose} aria-label="Close GitHub Task Center">
              Close
            </button>
          </div>
        </header>
        <div className="task-center-tabs" role="tablist" aria-label="GitHub task type">
          {scopes.map((scope) => (
            <button
              key={scope.id}
              id={`task-tab-${scope.id}`}
              className="task-center-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === scope.id}
              aria-controls={`task-panel-${scope.id}`}
              tabIndex={activeTab === scope.id ? 0 : -1}
              onClick={() => setActiveTab(scope.id)}
            >
              {scope.label}
              {!loading && items[scope.id].length > 0 ? <span>{items[scope.id].length}</span> : null}
            </button>
          ))}
        </div>
        <div
          id={`task-panel-${activeTab}`}
          className="task-center-content"
          role="tabpanel"
          aria-labelledby={`task-tab-${activeTab}`}
          tabIndex={0}
        >
          {loading ? <p className="task-center-state" role="status">Loading {activeLabel.toLowerCase()}…</p> : null}
          {!loading && error ? (
            <div className="task-center-state task-center-error" role="alert">
              <strong>Could not load GitHub tasks</strong>
              <p>{error}</p>
              <button className="btn btn-compact" type="button" onClick={refresh}>Try again</button>
            </div>
          ) : null}
          {!loading && !error && activeItems.length === 0 ? (
            <p className="task-center-state">No {activeLabel.toLowerCase()} found.</p>
          ) : null}
          {!loading && !error && activeItems.length > 0 ? (
            <ul className="task-center-list">
              {activeItems.map((task, index) => {
                const url = taskUrl(task);
                const meta = taskMeta(task);
                return (
                  <li key={String(task.id ?? task.nodeId ?? task.number ?? index)} className="task-center-row">
                    <div className="task-center-row-copy">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">{taskTitle(task)}</a>
                      ) : <strong>{taskTitle(task)}</strong>}
                      {meta ? <span>{meta}</span> : null}
                    </div>
                    {url ? <a className="task-center-open" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${taskTitle(task)} in browser`}>↗</a> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}
