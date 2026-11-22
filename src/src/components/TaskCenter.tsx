import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { findSession, useStore } from "../store";

type Provider = "github" | "gitlab";
type TaskScope = "issues" | "pulls" | "projects" | "boards";
type TaskRecord = Record<string, unknown>;
type TaskItems = Record<TaskScope, TaskRecord[]>;
type ScopeErrors = Record<TaskScope, string | null>;
type TaskResponse = {
  repository?: unknown;
  data?: { items?: unknown[] } | null;
  items?: unknown[];
  error?: { message?: unknown; code?: unknown } | null;
};

type ScopeMeta = {
  id: TaskScope;
  label: string;
  shortLabel: string;
  description: string;
  icon: string;
};

const scopes: ScopeMeta[] = [
  { id: "issues", label: "Issues", shortLabel: "Issues", description: "Open work and discussions", icon: "◉" },
  { id: "pulls", label: "Pull requests", shortLabel: "Pulls", description: "Changes waiting for review", icon: "↗" },
  { id: "projects", label: "Projects", shortLabel: "Projects", description: "Planning views and milestones", icon: "▦" },
  { id: "boards", label: "Boards", shortLabel: "Boards", description: "Team board lanes", icon: "▤" },
];

const providerLabels: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

function emptyItems(): TaskItems {
  return { issues: [], pulls: [], projects: [], boards: [] };
}

function emptyErrors(): ScopeErrors {
  return { issues: null, pulls: null, projects: null, boards: null };
}

function asRecord(value: unknown): TaskRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as TaskRecord
    : null;
}

function asItems(value: unknown): TaskRecord[] {
  const response = asRecord(value) as TaskResponse | null;
  const data = asRecord(response?.data);
  const items = data?.items ?? response?.items;
  return Array.isArray(items)
    ? items.filter((item): item is TaskRecord => asRecord(item) !== null).map((item) => item as TaskRecord)
    : [];
}

function responseError(value: unknown): string | null {
  const response = asRecord(value) as TaskResponse | null;
  const error = asRecord(response?.error);
  return typeof error?.message === "string" && error.message.trim() ? error.message : null;
}

function responseErrorCode(value: unknown): string | null {
  const response = asRecord(value) as TaskResponse | null;
  const error = asRecord(response?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function firstText(record: TaskRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function taskTitle(task: TaskRecord): string {
  return firstText(task, ["title", "name"], "Untitled task");
}

function taskUrl(task: TaskRecord): string | null {
  const value = firstText(task, ["url", "htmlUrl", "webUrl", "html_url"]);
  return /^https?:\/\//.test(value) ? value : null;
}

function taskNumber(task: TaskRecord): string | null {
  const value = task.number ?? task.iid;
  if (typeof value === "number" || typeof value === "string") return `#${value}`;
  return null;
}

function taskState(task: TaskRecord): string {
  const state = firstText(task, ["state", "status", "workflowState", "mergeStatus"]);
  if (state) return state;
  if (task.closed === true) return "Closed";
  if (task.closed === false) return "Open";
  return "Open";
}

function taskTone(task: TaskRecord): "open" | "review" | "done" | "muted" {
  const state = taskState(task).toLowerCase();
  if (task.draft === true || state.includes("draft") || state.includes("review")) return "review";
  if (state.includes("closed") || state.includes("merged") || state.includes("done") || state.includes("complete")) return "done";
  if (state.includes("open") || state.includes("active") || state.includes("created") || state.includes("reopen")) return "open";
  return "muted";
}

function taskSummary(task: TaskRecord): string | null {
  const value = firstText(task, ["shortDescription", "description", "body", "summary"]);
  return value ? value : null;
}

function taskAuthor(task: TaskRecord): string | null {
  const direct = firstText(task, ["author", "assignee", "username"]);
  if (direct) return direct;
  for (const key of ["user", "author", "assignee", "createdBy"]) {
    const value = asRecord(task[key]);
    const name = value ? firstText(value, ["name", "login", "username", "handle"]) : "";
    if (name) return name;
  }
  return null;
}

function taskLabels(task: TaskRecord): string[] {
  const raw = task.labels ?? task.tags ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    const record = asRecord(value);
    const name = record ? firstText(record, ["name", "title", "label"]) : "";
    return name ? [name] : [];
  });
}

function taskUpdatedAt(task: TaskRecord): string | null {
  const value = firstText(task, ["updatedAt", "updated_at", "lastUpdated", "createdAt"]);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function taskIdentity(task: TaskRecord): string {
  const value = task.id ?? task.nodeId ?? task.number ?? task.iid ?? task.url ?? task.webUrl;
  return typeof value === "string" || typeof value === "number" ? String(value) : taskTitle(task);
}

function repositoryName(value: unknown): string | null {
  const repository = asRecord(value);
  if (!repository) return null;
  const fullName = firstText(repository, ["fullName", "nameWithOwner", "projectPath"]);
  if (fullName) return fullName;
  const owner = firstText(repository, ["owner", "namespace"]);
  const name = firstText(repository, ["name"]);
  return owner && name ? `${owner}/${name}` : name || null;
}

function supportedScopes(provider: Provider): ScopeMeta[] {
  return scopes.filter(({ id }) => provider === "github" ? id !== "boards" : id !== "projects");
}

function scopeMeta(scope: TaskScope): ScopeMeta {
  return scopes.find((candidate) => candidate.id === scope) ?? scopes[0];
}

function errorCategory(message: string | null): "auth" | "rate" | "unavailable" | "error" {
  const value = (message ?? "").toLowerCase();
  if (/(auth|credential|token|login|permission|unauthori|forbidden|401|403)/.test(value)) return "auth";
  if (/(rate|limit|429|too many)/.test(value)) return "rate";
  if (/(unavailable|not found|not_git|backend|network|timeout|not installed)/.test(value)) return "unavailable";
  return "error";
}

function errorLabel(message: string | null): string {
  switch (errorCategory(message)) {
    case "auth": return "Sign-in required";
    case "rate": return "Rate limited";
    case "unavailable": return "Unavailable";
    default: return "Could not load";
  }
}

function useTasks(projectId: string | null, provider: Provider, open: boolean) {
  const [items, setItems] = useState<TaskItems>(emptyItems);
  const [repository, setRepository] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeErrors, setScopeErrors] = useState<ScopeErrors>(emptyErrors);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const supported = supportedScopes(provider);
    if (!projectId) {
      setItems(emptyItems());
      setRepository(null);
      setScopeErrors(emptyErrors());
      setError("Select a project or session before opening Task Hub.");
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    setError(null);

    void Promise.all(supported.map(async ({ id }) => {
      try {
        const value = provider === "github"
          ? await api.listGithubTasks(projectId, id as "issues" | "pulls" | "projects")
          : await api.listGitlabTasks(projectId, id as "issues" | "pulls" | "boards");
        return {
          scope: id,
          items: asItems(value),
          repository: repositoryName(asRecord(value)?.repository),
          error: responseError(value),
          errorCode: responseErrorCode(value),
        };
      } catch (reason: unknown) {
        return {
          scope: id,
          items: [] as TaskRecord[],
          repository: null,
          error: errorText(reason),
          errorCode: null,
        };
      }
    })).then((results) => {
      if (cancelled) return;
      const nextItems = emptyItems();
      const nextErrors = emptyErrors();
      let nextRepository: string | null = null;
      for (const result of results) {
        nextItems[result.scope] = result.items;
        nextErrors[result.scope] = result.error
          ? `${result.errorCode ? `${result.errorCode}: ` : ""}${result.error}`
          : null;
        nextRepository = nextRepository ?? result.repository;
      }
      setItems(nextItems);
      setScopeErrors(nextErrors);
      setRepository(nextRepository);
      setError(null);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(errorText(reason));
    }).finally(() => {
      if (cancelled) return;
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [open, projectId, provider, revision]);

  return { items, repository, loading, error, scopeErrors, refresh };
}

function ProviderMark({ provider }: { provider: Provider }) {
  return <span className={`task-center-provider-mark task-center-provider-mark-${provider}`} aria-hidden="true">{provider === "github" ? "GH" : "GL"}</span>;
}

function ScopeGlyph({ scope }: { scope: TaskScope }) {
  return <span className="task-center-scope-glyph" aria-hidden="true">{scopeMeta(scope).icon}</span>;
}

function TaskRow({
  task,
  scope,
  selected,
  onSelect,
}: {
  task: TaskRecord;
  scope: TaskScope;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = taskState(task);
  const number = taskNumber(task);
  const author = taskAuthor(task);
  const labels = taskLabels(task);
  return (
    <li>
      <button
        className={`task-center-row${selected ? " is-selected" : ""}`}
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className={`task-center-status-dot task-center-status-dot-${taskTone(task)}`} aria-hidden="true" />
        <span className="task-center-row-copy">
          <span className="task-center-row-title">{taskTitle(task)}</span>
          <span className="task-center-row-meta">
            <span>{number ?? scopeMeta(scope).shortLabel}</span>
            <span>{state}</span>
            {author ? <span>by {author}</span> : null}
          </span>
          {labels.length > 0 ? <span className="task-center-row-labels">{labels.slice(0, 3).map((label) => <span key={label}>{label}</span>)}</span> : null}
        </span>
        <span className="task-center-row-chevron" aria-hidden="true">›</span>
      </button>
    </li>
  );
}

function TaskDetail({
  task,
  scope,
  provider,
  projectId,
  onClose,
}: {
  task: TaskRecord;
  scope: TaskScope;
  provider: Provider;
  projectId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const numberValue = task.number ?? task.iid;
  const number = typeof numberValue === "number" ? numberValue : Number(numberValue);
  useEffect(() => {
    if (!projectId || !Number.isInteger(number) || (scope !== "issues" && scope !== "pulls")) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    const request = provider === "github"
      ? api.getGithubTask(projectId, scope === "pulls" ? "pull_request" : "issue", number)
      : api.getGitlabTask(projectId, scope === "pulls" ? "merge_request" : "issue", number);
    void request.then((value) => {
      if (cancelled) return;
      const record = asRecord(value);
      const data = asRecord(record?.data);
      const error = asRecord(record?.error);
      setDetail(data);
      setDetailError(typeof error?.message === "string" ? error.message : null);
    }).catch((reason: unknown) => { if (!cancelled) setDetailError(errorText(reason)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, provider, scope, number]);
  const shownTask = detail ?? task;
  const url = taskUrl(shownTask);
  const labels = taskLabels(shownTask);
  const summary = taskSummary(shownTask);
  const author = taskAuthor(shownTask);
  const updatedAt = taskUpdatedAt(shownTask);
  const state = taskState(shownTask);
  const review = firstText(shownTask, ["reviewDecision", "reviewStatus", "pipelineStatus", "checkState"]);
  const branch = firstText(shownTask, ["headRefName", "sourceBranch", "source_branch", "branch"]);
  return (
    <aside className="task-center-detail is-open" aria-label="Task details">
      <header className="task-center-detail-head">
        <div>
          <span className="task-center-eyebrow"><ScopeGlyph scope={scope} /> {providerLabels[provider]} / {scopeMeta(scope).shortLabel}</span>
          <h3>Details</h3>
        </div>
        <button className="task-center-icon-button" type="button" onClick={onClose} aria-label="Close task details">×</button>
      </header>
      <div className="task-center-detail-body">
        <div className="task-center-detail-title-row">
          <span className={`task-center-status-dot task-center-status-dot-${taskTone(task)}`} aria-hidden="true" />
          <span className="task-center-detail-state">{state}</span>
          {taskNumber(task) ? <span className="task-center-detail-number">{taskNumber(task)}</span> : null}
        </div>
        <h4 className="task-center-detail-title">{taskTitle(task)}</h4>
        <div className="task-center-detail-actions">
          {url ? <a className="task-center-open-link" href={url} target="_blank" rel="noreferrer">Open in {providerLabels[provider]} <span aria-hidden="true">↗</span></a> : <span className="task-center-no-link">No provider link</span>}
        </div>
        {detailLoading ? <p className="task-center-detail-muted">Loading provider detail…</p> : null}
        {detailError ? <p className="task-center-detail-error">{detailError}</p> : null}
        {summary ? <p className="task-center-detail-summary">{summary}</p> : <p className="task-center-detail-muted">No description was provided for this task.</p>}
        <section className="task-center-detail-section" aria-labelledby="task-center-facts-heading">
          <h5 id="task-center-facts-heading">Task facts</h5>
          <dl className="task-center-detail-facts">
            <div><dt>Provider</dt><dd>{providerLabels[provider]}</dd></div>
            <div><dt>Type</dt><dd>{scopeMeta(scope).label}</dd></div>
            {author ? <div><dt>Author</dt><dd>{author}</dd></div> : null}
            {updatedAt ? <div><dt>Updated</dt><dd>{updatedAt}</dd></div> : null}
            {branch ? <div><dt>Branch</dt><dd className="mono">{branch}</dd></div> : null}
            {review ? <div><dt>Checks</dt><dd>{review}</dd></div> : null}
          </dl>
        </section>
        {labels.length > 0 ? (
          <section className="task-center-detail-section" aria-labelledby="task-center-labels-heading">
            <h5 id="task-center-labels-heading">Labels</h5>
            <div className="task-center-label-list">{labels.map((label) => <span key={label} className="task-center-label">{label}</span>)}</div>
          </section>
        ) : null}
        <section className="task-center-detail-note">
          <span className="task-center-note-mark" aria-hidden="true">●</span>
          <p>{detail ? "Provider detail loaded. Credentials stay on this device and are never included in task data." : "Detail and mutation capabilities depend on the provider and target device."}</p>
        </section>
      </div>
    </aside>
  );
}

function TaskLoadingState() {
  return (
    <div className="task-center-loading" role="status" aria-label="Loading tasks">
      <span className="task-center-skeleton task-center-skeleton-wide" />
      <span className="task-center-skeleton" />
      <span className="task-center-skeleton task-center-skeleton-short" />
      <span className="task-center-skeleton" />
    </div>
  );
}

export default function TaskCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>("github");
  const activeProjectId = useStore((state) => {
    const session = findSession(state.projects, state.activeSessionId);
    return session?.projectId ?? null;
  });
  const [activeScope, setActiveScope] = useState<TaskScope>("issues");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "board">("list");
  const shellRef = useRef<HTMLElement>(null);
  const { items, repository, loading, error, scopeErrors, refresh } = useTasks(activeProjectId, provider, open);
  const activeItems = items[activeScope];
  const activeScopeMeta = scopeMeta(activeScope);
  const activeError = error ?? scopeErrors[activeScope];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return activeItems;
    return activeItems.filter((task) => {
      const searchable = [taskTitle(task), taskSummary(task) ?? "", taskState(task), ...taskLabels(task)].join(" ").toLowerCase();
      return searchable.includes(normalizedQuery);
    });
  }, [activeItems, normalizedQuery]);
  const selectedTask = useMemo(() => {
    if (selectedId) {
      const match = activeItems.find((task) => taskIdentity(task) === selectedId);
      if (match) return match;
    }
    return filteredItems[0] ?? activeItems[0] ?? null;
  }, [activeItems, filteredItems, selectedId]);
  const boardColumns = useMemo(() => {
    const columns: Array<{ id: "open" | "review" | "done"; label: string; items: TaskRecord[] }> = [
      { id: "open", label: "Open", items: [] },
      { id: "review", label: "In review", items: [] },
      { id: "done", label: "Done", items: [] },
    ];
    for (const task of filteredItems) {
      const tone = taskTone(task);
      const column = columns.find((candidate) => candidate.id === (tone === "done" ? "done" : tone === "review" ? "review" : "open"));
      column?.items.push(task);
    }
    return columns;
  }, [filteredItems]);

  useEffect(() => {
    if (!open) return;
    shellRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const compact = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 980px)").matches;
        if (selectedId && compact) setSelectedId(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, selectedId]);

  useEffect(() => {
    if (!selectedTask) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const identity = taskIdentity(selectedTask);
    if (selectedId !== identity) setSelectedId(identity);
  }, [selectedId, selectedTask]);

  if (!open) return null;
  const supported = supportedScopes(provider);
  const chooseProvider = (nextProvider: Provider) => {
    setProvider(nextProvider);
    setActiveScope("issues");
    setSelectedId(null);
    setQuery("");
    setViewMode("list");
  };
  const chooseScope = (scope: TaskScope) => {
    setActiveScope(scope);
    setSelectedId(null);
    setQuery("");
  };
  const titleRepository = repository ?? "No repository detected";
  const statusText = error
    ? errorLabel(error)
    : activeError
      ? errorLabel(activeError)
      : loading
        ? "Syncing"
        : "Up to date";

  return (
    <div className="task-center-layer">
      <section
        ref={shellRef}
        className="task-center-shell"
        tabIndex={-1}
        aria-label="AgentPort Task Hub"
      >
        <header className="task-center-topbar">
          <div className="task-center-title-group">
            <span className="task-center-title-mark" aria-hidden="true"><span /> <span /> <span /></span>
            <div>
              <span className="task-center-eyebrow">Workspace / Tasks</span>
              <h1>Task Hub</h1>
            </div>
          </div>
          <div className="task-center-topbar-context">
            <span className="task-center-context-repository"><span className="task-center-context-dot" aria-hidden="true" />{titleRepository}</span>
            <span className={`task-center-sync-status task-center-sync-status-${errorCategory(error ?? activeError)}`}><span aria-hidden="true" />{statusText}</span>
          </div>
          <div className="task-center-topbar-actions">
            <button className="task-center-topbar-close" type="button" onClick={onClose}>Close <span aria-hidden="true">Esc</span></button>
          </div>
        </header>

        <div className="task-center-mobile-nav" aria-label="Task Hub navigation">
          {(["github", "gitlab"] as Provider[]).map((candidate) => (
            <button key={candidate} type="button" aria-pressed={provider === candidate} onClick={() => chooseProvider(candidate)}>
              <ProviderMark provider={candidate} /> {providerLabels[candidate]}
            </button>
          ))}
          <span className="task-center-mobile-nav-divider" aria-hidden="true" />
          {supported.map((scope) => (
            <button key={scope.id} type="button" aria-pressed={activeScope === scope.id} onClick={() => chooseScope(scope.id)}>
              <ScopeGlyph scope={scope.id} /> {scope.shortLabel}
            </button>
          ))}
        </div>

        <div className="task-center-layout">
          <aside className="task-center-source-rail" aria-label="Task sources">
            <div className="task-center-source-heading">Sources</div>
            <div className="task-center-source-list">
              {(["github", "gitlab"] as Provider[]).map((candidate) => (
                <button
                  key={candidate}
                  className={`task-center-source-button${provider === candidate ? " is-active" : ""}`}
                  type="button"
                  aria-pressed={provider === candidate}
                  onClick={() => chooseProvider(candidate)}
                >
                  <ProviderMark provider={candidate} />
                  <span className="task-center-source-copy"><strong>{providerLabels[candidate]}</strong><small>{candidate === "github" ? "Issues, PRs & Projects" : "Issues, MRs & Boards"}</small></span>
                  <span className="task-center-source-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="task-center-source-divider" />
            <div className="task-center-source-heading">Views</div>
            <nav className="task-center-scope-list" aria-label={`${providerLabels[provider]} task views`}>
              {supported.map((scope) => {
                const count = items[scope.id].length;
                const scopeError = scopeErrors[scope.id];
                return (
                  <button
                    key={scope.id}
                    className={`task-center-scope-button${activeScope === scope.id ? " is-active" : ""}`}
                    type="button"
                    aria-current={activeScope === scope.id ? "page" : undefined}
                    onClick={() => chooseScope(scope.id)}
                  >
                    <ScopeGlyph scope={scope.id} />
                    <span>{scope.label}</span>
                    {scopeError ? <span className="task-center-scope-alert" aria-label={errorLabel(scopeError)}>!</span> : <span className="task-center-scope-count">{count}</span>}
                  </button>
                );
              })}
            </nav>
            <div className="task-center-source-footer">
              <span className="task-center-local-mark" aria-hidden="true">⌁</span>
              <p><strong>Device-local access</strong><br />Uses the provider CLI already signed in here.</p>
            </div>
          </aside>

          <main className="task-center-list-pane" aria-label={`${providerLabels[provider]} ${activeScopeMeta.label}`}>
            <header className="task-center-list-head">
              <div className="task-center-list-heading">
                <span className="task-center-eyebrow"><ProviderMark provider={provider} /> {providerLabels[provider]} / {activeScopeMeta.shortLabel}</span>
                <h2>{activeScopeMeta.label}</h2>
                <p>{activeScopeMeta.description} <span aria-hidden="true">·</span> {filteredItems.length} of {activeItems.length}</p>
              </div>
              <div className="task-center-list-actions">
                <button className="task-center-refresh-button" type="button" onClick={refresh} disabled={loading} aria-label="Refresh tasks">
                  <span className={loading ? "task-center-refresh-icon is-spinning" : "task-center-refresh-icon"} aria-hidden="true">↻</span>
                  <span>{loading ? "Refreshing" : "Refresh"}</span>
                </button>
              </div>
            </header>
            <div className="task-center-filterbar">
              <label className="task-center-search">
                <span aria-hidden="true">⌕</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${activeScopeMeta.label.toLowerCase()}`} aria-label={`Search ${activeScopeMeta.label}`} />
                {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button> : null}
              </label>
              <div className="task-center-view-toggle" role="group" aria-label="Task view">
                <button type="button" className={viewMode === "list" ? "is-active" : ""} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>List</button>
                <button type="button" className={viewMode === "board" ? "is-active" : ""} aria-pressed={viewMode === "board"} onClick={() => setViewMode("board")}>Board</button>
              </div>
            </div>
            {loading && activeItems.length > 0 ? <div className="task-center-stale-banner" role="status"><span className="task-center-stale-dot" aria-hidden="true" />Showing cached results while this view refreshes.</div> : null}
            <div className="task-center-list-body">
              {loading && activeItems.length === 0 ? <TaskLoadingState /> : null}
              {!loading && activeError ? (
                <div className="task-center-state task-center-state-error" role="alert">
                  <span className="task-center-state-icon" aria-hidden="true">!</span>
                  <h3>{errorLabel(activeError)}</h3>
                  <p>{activeError}</p>
                  <button className="task-center-retry-button" type="button" onClick={refresh}>Try again</button>
                </div>
              ) : null}
              {!loading && !activeError && filteredItems.length === 0 ? (
                <div className="task-center-state">
                  <span className="task-center-state-icon task-center-state-icon-quiet" aria-hidden="true"><ScopeGlyph scope={activeScope} /></span>
                  <h3>{query ? "No matching tasks" : `No ${activeScopeMeta.label.toLowerCase()} yet`}</h3>
                  <p>{query ? "Try a different search or clear the filter." : "When this provider returns work, it will appear here."}</p>
                </div>
              ) : null}
              {filteredItems.length > 0 && viewMode === "list" ? (
                <ul className="task-center-list" aria-label={`${activeScopeMeta.label} list`}>
                  {filteredItems.map((task) => {
                    const identity = taskIdentity(task);
                    return <TaskRow key={identity} task={task} scope={activeScope} selected={selectedTask === task} onSelect={() => setSelectedId(identity)} />;
                  })}
                </ul>
              ) : null}
              {filteredItems.length > 0 && viewMode === "board" ? (
                <div className="task-center-board" aria-label={`${activeScopeMeta.label} board`}>
                  {boardColumns.map((column) => (
                    <section className="task-center-board-column" key={column.id} aria-labelledby={`task-board-${column.id}`}>
                      <header><span className={`task-center-status-dot task-center-status-dot-${column.id}`} aria-hidden="true" /><h3 id={`task-board-${column.id}`}>{column.label}</h3><span>{column.items.length}</span></header>
                      <ul>
                        {column.items.map((task) => {
                          const identity = taskIdentity(task);
                          return <TaskRow key={identity} task={task} scope={activeScope} selected={selectedTask === task} onSelect={() => setSelectedId(identity)} />;
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : null}
            </div>
          </main>

          {selectedTask ? <TaskDetail task={selectedTask} scope={activeScope} provider={provider} projectId={activeProjectId} onClose={() => setSelectedId(null)} /> : <aside className="task-center-detail task-center-detail-empty" aria-label="Task details"><div className="task-center-detail-empty-content"><span aria-hidden="true">↖</span><h3>Select a task</h3><p>Choose an item from the list to inspect its details.</p></div></aside>}
        </div>
      </section>
    </div>
  );
}
