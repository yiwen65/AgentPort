import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import {
  isTaskProvider,
  isTaskScope,
  readTaskDetail,
  readTaskList,
  scopesForProvider,
  taskDetail,
  taskErrorFromUnknown,
  taskSummary,
  type TaskDetail,
  type TaskError,
  type TaskProvider,
  type TaskReadParams,
  type TaskScope,
  type TaskSummary,
} from "./taskApi";
import { readTaskCache, taskCacheKey, writeTaskCache, type CachedTaskList } from "./taskCache";
import { createTaskDeepLink, type TaskDeepLink } from "./taskDeepLinks";
import "./tasks.css";

const SELECTED_PROFILE_KEY = "agentport-mobile-v2:tasks-device";

type Project = { id: string; name: string };
type ListState = "idle" | "loading" | "ready" | "cached" | "error" | "auth" | "unavailable";
type DetailState = "idle" | "loading" | "ready" | "error" | "auth" | "unavailable";

type TaskResponseState = {
  response?: Awaited<ReturnType<typeof readTaskList>>;
  error?: TaskError;
  state: ListState;
  cachedAt?: number;
};

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function projectsFrom(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const id = text(item.id);
    if (!id) return [];
    return [{ id, name: text(item.name) ?? text(item.rootPath) ?? id }];
  });
}

function repositoryName(repository: Record<string, unknown> | null | undefined): string | undefined {
  if (!repository) return undefined;
  const owner = text(repository.owner) ?? text(repository.namespace);
  const name = text(repository.name) ?? text(repository.projectPath);
  if (owner && name) return `${owner}/${name}`;
  return name ?? text(repository.remoteUrl) ?? text(repository.host);
}

function classifyError(error: TaskError | undefined): "auth" | "unavailable" | "error" {
  const code = (error?.code ?? "").toLowerCase();
  if (code.includes("auth") || code.includes("login") || code.includes("credential") || code === "unauthorized" || code === "forbidden") return "auth";
  if (code.includes("unavailable") || code.includes("unsupported") || code.includes("unknown_method") || code.includes("capability") || code.includes("not_connected") || code.includes("not_found")) return "unavailable";
  return "error";
}

function projectLabel(projectId: string, projects: Project[]): string {
  return projects.find(project => project.id === projectId)?.name ?? projectId;
}

function sortTasks(items: TaskSummary[]): TaskSummary[] {
  return [...items].sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function statusLabel(state: ListState | DetailState, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (state === "loading") return t("tasks.loading", { defaultValue: "Reading tasks…" });
  if (state === "cached") return t("tasks.cached", { defaultValue: "Showing cached tasks; the computer has not confirmed current data." });
  if (state === "auth") return t("tasks.authRequired", { defaultValue: "Sign in to GitHub or GitLab on the selected computer, then retry." });
  if (state === "unavailable") return t("tasks.unavailable", { defaultValue: "Task reading is unavailable on this computer or connection." });
  if (state === "error") return t("tasks.requestFailed", { defaultValue: "Could not read tasks. Check the connection and retry." });
  return "";
}

function repositoryToRecord(repository: unknown): Record<string, unknown> | null {
  return repository && typeof repository === "object" ? repository as Record<string, unknown> : null;
}

export interface TaskHubProps {
  client: RemoteClient;
  initialLink?: TaskDeepLink;
  onBack?: () => void;
}

export function TaskHub({ client, initialLink, onBack }: TaskHubProps) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostProfileSummary[]>([]);
  const [hostsState, setHostsState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedProfileId, setSelectedProfileId] = useState(initialLink?.profileId ?? "");
  const [provider, setProvider] = useState<TaskProvider>(initialLink?.provider ?? "github");
  const [scope, setScope] = useState<TaskScope>(initialLink?.scope ?? "issues");
  const [projectId, setProjectId] = useState(initialLink?.projectId ?? "");
  const [itemId, setItemId] = useState(initialLink?.itemId);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsState, setProjectsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [list, setList] = useState<TaskResponseState>({ state: "idle" });
  const [detail, setDetail] = useState<{ state: DetailState; value?: TaskDetail; error?: TaskError }>({ state: "idle" });
  const [selectedTask, setSelectedTask] = useState<TaskSummary>();
  const listRequest = useRef<AbortController>();
  const detailRequest = useRef<AbortController>();
  const loadedDeepLink = useRef<string>();

  const selectedHost = hosts.find(host => host.id === selectedProfileId);
  const connectedHosts = hosts.filter(host => host.connectionState === "connected");
  const items = useMemo(() => sortTasks((list.response?.items ?? []).map(taskSummary)), [list.response?.items]);
  const repository = repositoryToRecord(list.response?.repository ?? detail.value);
  const deepLink = selectedTask
    ? createTaskDeepLink({ profileId: selectedProfileId, provider, projectId, scope, itemId: selectedTask.id })
    : createTaskDeepLink({ profileId: selectedProfileId, provider, projectId, scope, itemId });

  const loadHosts = useCallback(async () => {
    setHostsState("loading");
    try {
      const next = await client.listHostProfiles();
      setHosts(next);
      setHostsState("ready");
      setSelectedProfileId(current => {
        const preferred = current || (() => {
          try { return localStorage.getItem(SELECTED_PROFILE_KEY) ?? ""; } catch { return ""; }
        })();
        return next.some(host => host.id === preferred) ? preferred : next[0]?.id ?? "";
      });
    } catch {
      setHostsState("error");
    }
  }, [client]);

  useEffect(() => { void loadHosts(); }, [loadHosts]);

  useEffect(() => {
    if (!selectedProfileId) return;
    try { localStorage.setItem(SELECTED_PROFILE_KEY, selectedProfileId); } catch { /* best effort */ }
  }, [selectedProfileId]);

  useEffect(() => {
    if (!selectedProfileId || selectedHost?.connectionState !== "connected") {
      setProjects([]);
      setProjectsState("idle");
      return;
    }
    let active = true;
    setProjectsState("loading");
    void client.request<unknown>(selectedProfileId, "project.list", {}).then(value => {
      if (!active) return;
      const next = projectsFrom(value);
      setProjects(next);
      setProjectsState("ready");
      setProjectId(current => current || next[0]?.id || "");
    }).catch(() => {
      if (active) setProjectsState("error");
    });
    return () => { active = false; };
  }, [client, selectedHost?.connectionState, selectedProfileId]);

  useEffect(() => {
    const available = scopesForProvider(provider);
    if (!available.includes(scope)) setScope(available[0]);
    setList({ state: "idle" });
    setSelectedTask(undefined);
    setDetail({ state: "idle" });
  }, [provider]);

  useEffect(() => {
    if (initialLink?.provider !== provider || initialLink.scope !== scope || initialLink.projectId !== projectId || !initialLink.itemId) return;
    setItemId(initialLink.itemId);
  }, [initialLink, projectId, provider, scope]);

  const params = useMemo<TaskReadParams | undefined>(() => {
    if (!selectedProfileId || !projectId || !isTaskProvider(provider) || !isTaskScope(provider, scope)) return undefined;
    return { provider, projectId, scope };
  }, [projectId, provider, scope, selectedProfileId]);

  const loadList = useCallback(async (force = false) => {
    if (!params || selectedHost?.connectionState !== "connected") {
      setList({ state: selectedHost ? "unavailable" : "idle" });
      return;
    }
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const cached = readTaskCache(selectedProfileId, params);
    if (cached && !force) setList({ response: cached.response, state: "cached", cachedAt: cached.savedAt });
    else setList({ response: cached?.response, state: "loading", cachedAt: cached?.savedAt });
    try {
      const response = await readTaskList(client, selectedProfileId, params, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.error) {
        const state = classifyError(response.error);
        setList({ response: cached?.response, state: cached ? "cached" : state, error: response.error, cachedAt: cached?.savedAt });
        return;
      }
      writeTaskCache(selectedProfileId, params, response);
      setList({ response, state: "ready" });
    } catch (error) {
      if (controller.signal.aborted) return;
      const readError = taskErrorFromUnknown(error);
      const state = classifyError(readError);
      setList({ response: cached?.response, state: cached ? "cached" : state, error: readError, cachedAt: cached?.savedAt });
    }
  }, [client, params, selectedHost, selectedProfileId]);

  useEffect(() => () => {
    listRequest.current?.abort();
    detailRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (!initialLink?.projectId || !params || selectedHost?.connectionState !== "connected" || list.state !== "idle") return;
    void loadList(false);
  }, [initialLink?.projectId, list.state, loadList, params, selectedHost?.connectionState]);

  useEffect(() => {
    if (!initialLink?.itemId || !params || !items.length) return;
    const key = taskCacheKey(selectedProfileId, params) + `:${initialLink.itemId}`;
    if (loadedDeepLink.current === key) return;
    const match = items.find(item => item.id === initialLink.itemId || String(item.number ?? "") === initialLink.itemId);
    if (!match) return;
    loadedDeepLink.current = key;
    void openDetail(match);
    // The list and detail requests intentionally have independent cancellation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLink?.itemId, items, params, selectedProfileId]);

  const openDetail = useCallback(async (summary: TaskSummary) => {
    if (!params) return;
    setSelectedTask(summary);
    setItemId(summary.id);
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetail({ state: "loading" });
    try {
      const response = await readTaskDetail(client, selectedProfileId, { ...params, itemId: summary.id }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.error) {
        setDetail({ state: classifyError(response.error), error: response.error });
      } else if (response.item) {
        setDetail({ state: "ready", value: taskDetail(response.item) });
      } else {
        setDetail({ state: "error", error: { code: "empty_response", message: "The task detail was empty." } });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const readError = taskErrorFromUnknown(error);
      setDetail({ state: classifyError(readError), error: readError });
    }
  }, [client, params, selectedProfileId]);

  const resetSelection = () => {
    setSelectedTask(undefined);
    setItemId(undefined);
    setDetail({ state: "idle" });
  };

  return (
    <section className="task-hub" aria-labelledby="task-hub-title">
      <header className="task-hub-toolbar">
        {onBack ? <button type="button" className="task-hub-back" onClick={onBack} aria-label={t("tasks.back", { defaultValue: "Back to sessions" })}>‹</button> : null}
        <div className="task-hub-heading">
          <span className="task-hub-eyebrow">AgentPort</span>
          <h1 id="task-hub-title">{t("tasks.title", { defaultValue: "Tasks" })}</h1>
        </div>
        <span className="task-hub-readonly">{t("tasks.readOnly", { defaultValue: "Read only" })}</span>
        <button type="button" className="task-hub-refresh" onClick={() => void loadHosts()} aria-label={t("tasks.refresh", { defaultValue: "Refresh" })}>↻</button>
      </header>

      <div className="task-hub-controls" aria-label={t("tasks.filters", { defaultValue: "Task filters" })}>
        <label>
          <span>{t("tasks.device", { defaultValue: "Computer" })}</span>
          <select value={selectedProfileId} onChange={event => { setSelectedProfileId(event.target.value); resetSelection(); }} disabled={hostsState !== "ready" || hosts.length === 0}>
            <option value="">{hostsState === "loading" ? t("tasks.loadingDevices", { defaultValue: "Loading computers…" }) : t("tasks.chooseDevice", { defaultValue: "Choose a computer" })}</option>
            {hosts.map(host => <option key={host.id} value={host.id}>{host.name}{host.connectionState !== "connected" ? ` · ${host.connectionState}` : ""}</option>)}
          </select>
        </label>
        <label>
          <span>{t("tasks.provider", { defaultValue: "Provider" })}</span>
          <select value={provider} onChange={event => { if (isTaskProvider(event.target.value)) setProvider(event.target.value); }}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label>
          <span>{t("tasks.repository", { defaultValue: "Repository / project" })}</span>
          <select value={projectId} onChange={event => { setProjectId(event.target.value); resetSelection(); }} disabled={projectsState === "loading" || projects.length === 0}>
            <option value="">{projects.length ? t("tasks.chooseRepository", { defaultValue: "Choose a project" }) : t("tasks.projectId", { defaultValue: "Enter project ID" })}</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          {projects.length === 0 ? <input value={projectId} onChange={event => { setProjectId(event.target.value); resetSelection(); }} placeholder={t("tasks.projectIdPlaceholder", { defaultValue: "AgentPort project ID" })} aria-label={t("tasks.projectId", { defaultValue: "Project ID" })} /> : null}
        </label>
        <label>
          <span>{t("tasks.kind", { defaultValue: "View" })}</span>
          <select value={scope} onChange={event => { if (isTaskScope(provider, event.target.value)) { setScope(event.target.value); resetSelection(); } }}>
            {scopesForProvider(provider).map(option => <option key={option} value={option}>{t(`tasks.scopes.${option}`, { defaultValue: option })}</option>)}
          </select>
        </label>
        <button type="button" className="task-hub-load" disabled={!params || selectedHost?.connectionState !== "connected" || list.state === "loading"} onClick={() => void loadList(true)}>
          {list.state === "loading" ? t("tasks.loading", { defaultValue: "Reading…" }) : t("tasks.read", { defaultValue: "Read tasks" })}
        </button>
      </div>

      {hostsState === "error" ? <div className="task-hub-state task-hub-error" role="alert">{t("tasks.devicesFailed", { defaultValue: "Could not read computers. Retry to continue." })}</div> : null}
      {hostsState === "ready" && hosts.length === 0 ? <div className="task-hub-state" role="status">{t("tasks.noDevices", { defaultValue: "Pair or connect a computer to read its tasks." })}</div> : null}
      {selectedHost && selectedHost.connectionState !== "connected" ? <div className="task-hub-state" role="status">{t("tasks.deviceOffline", { defaultValue: "The selected computer is not connected. Cached task data remains read-only." })}</div> : null}
      {list.state !== "idle" && list.state !== "ready" && list.state !== "cached" ? <div className={`task-hub-state task-hub-${list.state}`} role={list.state === "error" ? "alert" : "status"}>{statusLabel(list.state, t)} {list.error?.message ? <small>{list.error.message}</small> : null}</div> : null}
      {list.state === "cached" ? <div className="task-hub-state task-hub-cached" role="status">{statusLabel("cached", t)}{list.cachedAt ? <small>{new Date(list.cachedAt).toLocaleString()}</small> : null}</div> : null}
      {params && list.state === "idle" ? <div className="task-hub-state" role="status">{t("tasks.ready", { defaultValue: "Choose Read tasks to load the selected view." })}</div> : null}

      <div className="task-hub-body">
        <div className="task-hub-list" aria-label={t("tasks.list", { defaultValue: "Task list" })}>
          <header><h2>{t(`tasks.scopes.${scope}`, { defaultValue: scope })}</h2><span>{items.length}</span></header>
          {list.response?.repository ? <p className="task-hub-repository">{repositoryName(repository)}</p> : null}
          {items.length === 0 && (list.state === "ready" || list.state === "cached") ? <p className="task-hub-empty" role="status">{t("tasks.empty", { defaultValue: "No tasks in this view." })}</p> : null}
          <ul>
            {items.map(item => <li key={item.id}>
              <button type="button" className={`task-row${selectedTask?.id === item.id ? " is-selected" : ""}`} onClick={() => void openDetail(item)} aria-pressed={selectedTask?.id === item.id}>
                <span className="task-row-marker" aria-hidden="true" />
                <span className="task-row-copy"><strong>{item.title}</strong><small>{item.type ?? scope} · {item.state}{item.draft ? " · draft" : ""}</small></span>
                <span className="task-row-number">{item.number ? `#${item.number}` : "›"}</span>
              </button>
            </li>)}
          </ul>
        </div>

        <article className="task-hub-detail" aria-label={t("tasks.detail", { defaultValue: "Task detail" })}>
          {!selectedTask ? <div className="task-hub-detail-empty" role="status">{t("tasks.selectTask", { defaultValue: "Select a task to read its details." })}</div> : <>
            <header>
              <div><span className="task-detail-kicker">{selectedTask.type ?? scope}{selectedTask.number ? ` · #${selectedTask.number}` : ""}</span><h2>{detail.value?.title ?? selectedTask.title}</h2></div>
              <button type="button" className="task-detail-close" onClick={resetSelection} aria-label={t("tasks.closeDetail", { defaultValue: "Close task detail" })}>×</button>
            </header>
            {detail.state !== "ready" ? <div className={`task-hub-state task-hub-${detail.state}`} role={detail.state === "error" ? "alert" : "status"}>{detail.state === "loading" ? statusLabel("loading", t) : statusLabel(detail.state, t)}{detail.error?.message ? <small>{detail.error.message}</small> : null}</div> : null}
            <div className="task-detail-meta"><span>{detail.value?.state ?? selectedTask.state}</span>{(detail.value?.labels ?? selectedTask.labels).map(label => <span key={label}>{label}</span>)}{detail.value?.author ?? selectedTask.author ? <span>{detail.value?.author ?? selectedTask.author}</span> : null}</div>
            {(detail.value?.body ?? detail.value?.comments.length) ? <>
              {detail.value?.body ? <p className="task-detail-body">{detail.value.body}</p> : null}
              {detail.value?.comments.length ? <section className="task-detail-comments"><h3>{t("tasks.comments", { defaultValue: "Comments" })}</h3>{detail.value.comments.map(comment => <div className="task-comment" key={comment.id}><strong>{comment.author ?? t("tasks.unknownAuthor", { defaultValue: "Unknown author" })}</strong><p>{comment.body}</p></div>)}</section> : null}
            </> : null}
            {detail.value?.assignees.length ? <p className="task-detail-line"><strong>{t("tasks.assignees", { defaultValue: "Assignees" })}</strong> {detail.value.assignees.join(", ")}</p> : null}
            {detail.value?.reviewers.length ? <p className="task-detail-line"><strong>{t("tasks.reviewers", { defaultValue: "Reviewers" })}</strong> {detail.value.reviewers.join(", ")}</p> : null}
            {detail.value?.checks.length ? <p className="task-detail-line"><strong>{t("tasks.checks", { defaultValue: "Checks" })}</strong> {detail.value.checks.join(", ")}</p> : null}
            {selectedTask.url ? <a className="task-detail-link" href={selectedTask.url} target="_blank" rel="noreferrer">{t("tasks.openProvider", { defaultValue: "Open in provider" })}</a> : null}
            {projectId ? <p className="task-detail-deep-link"><span>{t("tasks.deepLink", { defaultValue: "Deep link" })}</span><code>{deepLink}</code></p> : null}
            <p className="task-detail-readonly">{t("tasks.readOnlyHint", { defaultValue: "Mobile can read task data only. Changes must be made on the computer." })}</p>
          </>}
        </article>
      </div>
      {projectsState === "error" ? <p className="task-hub-footnote" role="status">{t("tasks.projectsUnavailable", { defaultValue: "Project names are unavailable; enter an AgentPort project ID to read tasks." })}</p> : null}
      {repository ? <span className="visually-hidden">{projectLabel(projectId, projects)}</span> : null}
    </section>
  );
}
