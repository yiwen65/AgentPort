import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorText, readClipboardImageFile } from "../api";
import { activeDeviceContext } from "../deviceContext";
import { MarkdownImageSession, imageTransport } from "../markdownImages";
import { MarkdownView } from "../markdown";
import { findSession, useStore } from "../store";
import { TaskOptionPicker } from "./TaskOptionPicker";
import { safeTaskImageUrl, TaskRichEditor, type TaskRichEditorHandle } from "./TaskRichEditor";
import type { TaskOption, TaskProviderDetection } from "../types";

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

type ComposerKind = "issue" | "pull_request" | "merge_request";
type ReviewFilter = "all" | "no_reviews" | "review_required" | "approved" | "changes_requested" | "reviewed_by_you" | "not_reviewed_by_you" | "awaiting_review_from_you" | "awaiting_review_from_you_or_team";

const reviewFilterOptions: Array<{ value: Exclude<ReviewFilter, "all">; label: string }> = [
  { value: "no_reviews", label: "No reviews" },
  { value: "review_required", label: "Review required" },
  { value: "approved", label: "Approved review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "reviewed_by_you", label: "Reviewed by you" },
  { value: "not_reviewed_by_you", label: "Not reviewed by you" },
  { value: "awaiting_review_from_you", label: "Awaiting review from you" },
  { value: "awaiting_review_from_you_or_team", label: "Awaiting review from you or your team" },
];

type TaskMutationFields = {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  reviewers?: string[];
  state?: string;
  head?: string;
  base?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft?: boolean;
  reviewEvent?: string;
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

function taskTone(task: TaskRecord, _scope: TaskScope): "open" | "review" | "done" | "muted" {
  const state = taskState(task).toLowerCase();
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

function taskAssignees(task: TaskRecord): string[] {
  const raw = task.assignees ?? task.assignee ?? [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    const record = asRecord(value);
    const name = record ? firstText(record, ["login", "username", "name", "handle"]) : "";
    return name ? [name] : [];
  });
}

function taskReviewStatuses(task: TaskRecord): string[] {
  const raw = task.reviewStatuses ?? task.reviewStatus ?? task.reviewDecision ?? task.approvalStatus;
  const statuses = typeof raw === "string" && raw.trim()
    ? [raw.trim().toLowerCase()]
    : Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim().toLowerCase())
      : [];
  if (statuses.length > 0) return statuses;
  const state = taskState(task).toLowerCase();
  return state.includes("open") || state.includes("active") || state.includes("created") || state.includes("reopen")
    ? task.draft === true ? ["no_reviews"] : ["review_required"]
    : ["no_reviews"];
}

function taskDiscussionItems(task: TaskRecord, key: "comments" | "reviews"): TaskRecord[] {
  const raw = task[key];
  return Array.isArray(raw) ? raw.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  }) : [];
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

function useTasks(projectId: string | null, provider: Provider | null, open: boolean) {
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
    if (!provider) {
      setItems(emptyItems());
      setRepository(null);
      setScopeErrors(emptyErrors());
      setError(null);
      setLoading(false);
      return () => { cancelled = true; };
    }
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

type TaskOptionState = {
  labels: TaskOption[];
  assignees: TaskOption[];
  branches: TaskOption[];
  reviewers: TaskOption[];
  loading: boolean;
  error: string | null;
};

function emptyTaskOptions(): TaskOptionState {
  return { labels: [], assignees: [], branches: [], reviewers: [], loading: false, error: null };
}

function useTaskOptions(projectId: string | null, provider: Provider | null, open: boolean): TaskOptionState {
  const [state, setState] = useState<TaskOptionState>(emptyTaskOptions);
  useEffect(() => {
    if (!open || !projectId || !provider) {
      setState(emptyTaskOptions());
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    const request = provider === "github"
      ? api.getGithubTaskOptions(projectId)
      : api.getGitlabTaskOptions(projectId);
    void request.then((value) => {
      if (cancelled) return;
      const record = asRecord(value);
      const labels = Array.isArray(record?.labels)
        ? [...new Set(record.labels.filter((label): label is string => typeof label === "string" && Boolean(label.trim())).map((label) => label.trim()))].map((label) => ({ id: label, name: label }))
        : [];
      const parseOptions = (raw: unknown): TaskOption[] => Array.isArray(raw)
        ? raw.flatMap((item) => {
          const option = asRecord(item);
          const id = option && (typeof option.id === "string" || typeof option.id === "number") ? String(option.id) : "";
          const name = option && typeof option.name === "string" ? option.name.trim() : "";
          return id && name ? [{ id, name }] : [];
        })
        : [];
      const assignees = parseOptions(record?.assignees);
      const branches = parseOptions(record?.branches);
      const reviewers = parseOptions(record?.reviewers);
      setState({ labels, assignees, branches, reviewers, loading: false, error: responseError(value) });
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setState({ labels: [], assignees: [], branches: [], reviewers: [], loading: false, error: errorText(reason) });
    });
    return () => { cancelled = true; };
  }, [open, projectId, provider]);
  return state;
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
        <span className={`task-center-status-dot task-center-status-dot-${taskTone(task, scope)}`} aria-hidden="true" />
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
  onMutate,
  mutationBusy,
}: {
  task: TaskRecord;
  scope: TaskScope;
  provider: Provider;
  projectId: string | null;
  onClose: () => void;
  onMutate: (operation: string, fields?: TaskMutationFields) => void;
  mutationBusy: boolean;
}) {
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const detailImageSession = useMemo(() => {
    const device = activeDeviceContext();
    return new MarkdownImageSession(
      { path: "task-detail.md", rootPath: "/", device },
      imageTransport(device),
    );
  }, []);
  useEffect(() => () => detailImageSession.dispose(), [detailImageSession]);
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
  const comments = taskDiscussionItems(shownTask, "comments");
  const reviews = taskDiscussionItems(shownTask, "reviews");
  const author = taskAuthor(shownTask);
  const updatedAt = taskUpdatedAt(shownTask);
  const state = taskState(shownTask);
  const review = firstText(shownTask, ["reviewDecision", "reviewStatus", "pipelineStatus", "checkState"]);
  const branch = firstText(shownTask, ["headRefName", "sourceBranch", "source_branch", "branch"]);
  const isPull = scope === "pulls";
  const isClosed = /closed|merged|done|complete/i.test(state);
  const canChangeState = !/merged/i.test(state);
  const reviewDisabled = /merged/i.test(state);
  const stateValue = provider === "gitlab" ? (isClosed ? "reopen" : "close") : (isClosed ? "open" : "closed");
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
          <span className={`task-center-status-dot task-center-status-dot-${taskTone(shownTask, scope)}`} aria-hidden="true" />
          <span className="task-center-detail-state">{state}</span>
          {taskNumber(shownTask) ? <span className="task-center-detail-number">{taskNumber(shownTask)}</span> : null}
        </div>
        <h4 className="task-center-detail-title">{taskTitle(shownTask)}</h4>
        <div className="task-center-detail-actions">
          {url ? <a className="task-center-open-link" href={url} target="_blank" rel="noreferrer">Open in {providerLabels[provider]} <span aria-hidden="true">↗</span></a> : <span className="task-center-no-link">No provider link</span>}
        </div>
        <section className="task-center-management-actions" aria-label="Task management">
          {canChangeState ? (
            <button type="button" disabled={mutationBusy} onClick={() => onMutate("state", { state: stateValue })}>
              {isClosed ? "Reopen" : "Close"} {scopeMeta(scope).shortLabel.slice(0, -1)}
            </button>
          ) : null}
          {isPull ? (
            <>
              <button type="button" disabled={mutationBusy || reviewDisabled} onClick={() => onMutate("review", { reviewEvent: "APPROVE" })}>Approve</button>
              {provider === "github" ? <button type="button" disabled={mutationBusy || reviewDisabled} onClick={() => onMutate("review", { reviewEvent: "REQUEST_CHANGES", body: reviewBody })}>Request changes</button> : null}
            </>
          ) : null}
        </section>
        {isPull ? (
          <div className="task-center-management-form">
            <textarea value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="Review note (optional)" aria-label="Review note" />
            <button type="button" disabled={mutationBusy || !reviewBody.trim()} onClick={() => { onMutate("review", { reviewEvent: "COMMENT", body: reviewBody }); setReviewBody(""); }}>Comment review</button>
          </div>
        ) : null}
        {!isPull ? (
          <div className="task-center-management-form">
            <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Add a comment" aria-label="Task comment" />
            <button type="button" disabled={mutationBusy || !commentBody.trim()} onClick={() => { onMutate("comment", { body: commentBody }); setCommentBody(""); }}>Comment</button>
          </div>
        ) : null}
        {detailLoading ? <p className="task-center-detail-muted">Loading provider detail…</p> : null}
        {detailError ? <p className="task-center-detail-error">{detailError}</p> : null}
        <section className="task-center-detail-section task-center-detail-content-section" aria-labelledby="task-center-description-heading">
          <h5 id="task-center-description-heading">Description</h5>
          {summary ? <div className="task-center-detail-markdown"><MarkdownView source={summary} imageSession={detailImageSession} /></div> : <p className="task-center-detail-muted">No description was provided for this task.</p>}
        </section>
        {comments.length > 0 ? <section className="task-center-detail-section" aria-labelledby="task-center-comments-heading">
          <h5 id="task-center-comments-heading">Comments ({comments.length})</h5>
          <div className="task-center-discussion-list">{comments.map((comment, index) => {
            const body = firstText(comment, ["body", "text", "note"], "");
            const commentAuthor = firstText(comment, ["author", "username", "login"], "Unknown author");
            const createdAt = firstText(comment, ["createdAt", "created_at", "submittedAt", "submitted_at"]);
            return <article className="task-center-discussion-item" key={String(comment.id ?? index)}><header><strong>{commentAuthor}</strong>{createdAt ? <time>{taskUpdatedAt({ createdAt })}</time> : null}</header>{body ? <div className="task-center-detail-markdown"><MarkdownView source={body} imageSession={detailImageSession} /></div> : null}</article>;
          })}</div>
        </section> : null}
        {reviews.length > 0 ? <section className="task-center-detail-section" aria-labelledby="task-center-reviews-heading">
          <h5 id="task-center-reviews-heading">Reviews ({reviews.length})</h5>
          <div className="task-center-discussion-list">{reviews.map((reviewItem, index) => {
            const body = firstText(reviewItem, ["body", "text", "note"], "");
            const reviewAuthor = firstText(reviewItem, ["author", "username", "login"], "Unknown reviewer");
            const reviewState = firstText(reviewItem, ["state", "status"]);
            return <article className="task-center-discussion-item" key={String(reviewItem.id ?? index)}><header><strong>{reviewAuthor}</strong>{reviewState ? <span className="task-center-discussion-state">{reviewState}</span> : null}</header>{body ? <div className="task-center-detail-markdown"><MarkdownView source={body} imageSession={detailImageSession} /></div> : null}</article>;
          })}</div>
        </section> : null}
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

function TaskDetectionState({ loading, detection }: { loading: boolean; detection: TaskProviderDetection | null }) {
  const title = loading ? "Finding provider" : detection?.errorCode === "unsupported_provider" ? "Unsupported provider" : "No repository detected";
  const message = loading
    ? "Reading the origin/main upstream for this project…"
    : detection?.error ?? "Select a project with a supported GitHub or GitLab origin/main remote.";
  return (
    <div className="task-center-state" role={loading ? "status" : "alert"}>
      <span className="task-center-state-icon task-center-state-icon-quiet" aria-hidden="true">{loading ? "⌁" : "!"}</span>
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

export default function TaskCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [providerProjectId, setProviderProjectId] = useState<string | null>(null);
  const [detectionReady, setDetectionReady] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<TaskProviderDetection | null>(null);
  const activeProjectId = useStore((state) => {
    const session = findSession(state.projects, state.activeSessionId);
    return session?.projectId ?? null;
  });
  const [activeScope, setActiveScope] = useState<TaskScope>("issues");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "board">("list");
  const [composerKind, setComposerKind] = useState<ComposerKind | null>(null);
  const [composerTitle, setComposerTitle] = useState("");
  const [composerBody, setComposerBody] = useState("");
  const [composerHead, setComposerHead] = useState("");
  const [composerBase, setComposerBase] = useState("main");
  const [composerLabels, setComposerLabels] = useState<string[]>([]);
  const [composerAssignees, setComposerAssignees] = useState<string[]>([]);
  const [composerReviewers, setComposerReviewers] = useState<string[]>([]);
  const [composerImageOpen, setComposerImageOpen] = useState(false);
  const [composerImageUrl, setComposerImageUrl] = useState("");
  const [composerImageAlt, setComposerImageAlt] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerUploadCount, setComposerUploadCount] = useState(0);
  const composerUploading = composerUploadCount > 0;
  const composerEditorRef = useRef<TaskRichEditorHandle>(null);
  const composerFileRef = useRef<HTMLInputElement>(null);
  const [filterStatus, setFilterStatus] = useState<"all" | "open" | "closed">("all");
  const [assignedOnly, setAssignedOnly] = useState(false);
  const [filterLabel, setFilterLabel] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterAuthor, setFilterAuthor] = useState("");
  const [filterReview, setFilterReview] = useState<ReviewFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "unknown"; text: string } | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const resolvedProvider = detectionReady && providerProjectId === activeProjectId ? provider : null;
  const { items, repository, loading, error, scopeErrors, refresh } = useTasks(activeProjectId, resolvedProvider, open);
  useEffect(() => {
    if (!open) {
      setDetectionReady(false);
      return;
    }
    let cancelled = false;
    setDetectionReady(false);
    setProvider(null);
    setProviderProjectId(null);
    setDetection(null);
    if (!activeProjectId) {
      setDetecting(false);
      return () => { cancelled = true; };
    }
    setDetecting(true);
    void api.detectTaskProvider(activeProjectId).then((detected) => {
      if (cancelled) return;
      setDetection(detected);
      setProvider(detected.provider);
      setProviderProjectId(detected.provider ? activeProjectId : null);
      setDetectionReady(Boolean(detected.provider));
      setActiveScope("issues");
      setSelectedId(null);
      setDetecting(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setDetectionReady(false);
      setDetection({
        provider: null,
        host: null,
        remoteUrl: null,
        repository: null,
        errorCode: "detection_failed",
        error: errorText(reason),
      });
      setDetecting(false);
    });
    return () => { cancelled = true; };
  }, [activeProjectId, open]);
  const visibleProvider = resolvedProvider;
  const taskOptions = useTaskOptions(activeProjectId, visibleProvider, open);
  useEffect(() => {
    if (!composerKind || (composerKind !== "pull_request" && composerKind !== "merge_request") || taskOptions.branches.length === 0) return;
    setComposerBase((current) => taskOptions.branches.some((option) => option.id === current)
      ? current
      : taskOptions.branches.find((option) => option.id === "main")?.id ?? taskOptions.branches[0].id);
    setComposerHead((current) => taskOptions.branches.some((option) => option.id === current) ? current : "");
  }, [composerKind, taskOptions.branches]);
  const activeItems = visibleProvider ? items[activeScope] : [];
  const activeScopeMeta = scopeMeta(activeScope);
  const activeError = error ?? scopeErrors[activeScope];
  const detectionError = detection?.error ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedLabel = filterLabel.trim().toLowerCase();
  const selectedAssigneeOption = taskOptions.assignees.find((option) => option.id === filterAssignee);
  const normalizedAssignee = (selectedAssigneeOption?.name ?? filterAssignee).trim().toLowerCase();
  const authorOptions = useMemo(() => {
    const unique = new Map<string, TaskOption>();
    for (const task of activeItems) {
      const author = taskAuthor(task);
      if (author) unique.set(author, { id: author, name: author });
    }
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [activeItems]);
  const filterLabelOptions = useMemo(() => {
    const unique = new Set(activeItems.flatMap(taskLabels));
    return [...unique].sort((left, right) => left.localeCompare(right)).map((name) => ({ id: name, name }));
  }, [activeItems]);
  const filterAssigneeOptions = useMemo(() => {
    const unique = new Set(activeItems.flatMap(taskAssignees));
    return [...unique].sort((left, right) => left.localeCompare(right)).map((name) => ({ id: name, name }));
  }, [activeItems]);
  const normalizedAuthor = filterAuthor.trim().toLowerCase();
  const filteredItems = useMemo(() => activeItems.filter((task) => {
    const state = taskState(task).toLowerCase();
    const closed = state.includes("closed") || state.includes("merged") || state.includes("done") || state.includes("complete");
    const labels = taskLabels(task);
    const assignees = taskAssignees(task);
    const author = taskAuthor(task) ?? "";
    const reviewStatuses = taskReviewStatuses(task);
    const searchable = [taskTitle(task), taskSummary(task) ?? "", taskState(task), author, ...labels, ...assignees].join(" ").toLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
    if (filterStatus === "open" && closed) return false;
    if (filterStatus === "closed" && !closed) return false;
    if (assignedOnly && assignees.length === 0) return false;
    if (normalizedLabel && !labels.some((label) => label.toLowerCase().includes(normalizedLabel))) return false;
    if (normalizedAssignee && !assignees.some((assignee) => assignee.toLowerCase().includes(normalizedAssignee))) return false;
    if (normalizedAuthor && !author.toLowerCase().includes(normalizedAuthor)) return false;
    if (activeScope === "pulls" && filterReview !== "all" && !reviewStatuses.includes(filterReview)) return false;
    return true;
  }), [activeItems, activeScope, assignedOnly, filterAssignee, filterAuthor, filterLabel, filterReview, filterStatus, normalizedAssignee, normalizedAuthor, normalizedLabel, normalizedQuery, taskOptions.assignees]);
  const selectedTask = useMemo(() => {
    if (selectedId) {
      const match = filteredItems.find((task) => taskIdentity(task) === selectedId);
      if (match) return match;
    }
    return filteredItems[0] ?? null;
  }, [filteredItems, selectedId]);
  const performMutation = async (kind: string, number: number, operation: string, fields: TaskMutationFields = {}) => {
    if (!activeProjectId || !visibleProvider || mutationBusy) return;
    setMutationBusy(true);
    setMutationNotice(null);
    try {
      const outcome = visibleProvider === "github"
        ? await api.mutateGithubTask(activeProjectId, {
          kind,
          number,
          operation,
          title: fields.title,
          head: fields.head,
          base: fields.base,
          draft: fields.draft,
          body: fields.body,
          state: fields.state,
          labels: fields.labels,
          assignees: fields.assignees,
          reviewers: fields.reviewers,
          reviewEvent: fields.reviewEvent,
        })
        : await api.mutateGitlabTask(activeProjectId, {
          kind,
          number,
          operation,
          title: fields.title,
          sourceBranch: fields.sourceBranch,
          targetBranch: fields.targetBranch,
          body: fields.body,
          state: fields.state,
          labels: fields.labels,
          assignees: fields.assignees,
          reviewers: fields.reviewers,
          reviewEvent: fields.reviewEvent,
        });
      if (outcome.status === "succeeded") {
        setMutationNotice({ tone: "success", text: "Provider confirmed the change." });
        refresh();
        setSelectedId(null);
        if (operation.startsWith("create_")) {
          setComposerKind(null);
          setComposerTitle("");
          setComposerBody("");
          setComposerHead("");
          setComposerBase("main");
          setComposerLabels([]);
          setComposerAssignees([]);
          setComposerReviewers([]);
          setComposerImageOpen(false);
          setComposerImageUrl("");
          setComposerImageAlt("");
          setComposerError(null);
        }
      } else {
        setMutationNotice({
          tone: outcome.status === "unknown" ? "unknown" : "error",
          text: outcome.error?.message ?? "The provider did not confirm this change.",
        });
      }
    } catch (reason: unknown) {
      setMutationNotice({ tone: "error", text: errorText(reason) });
    } finally {
      setMutationBusy(false);
    }
  };
  const mutateSelectedTask = (operation: string, fields: TaskMutationFields = {}) => {
    if (!selectedTask || !visibleProvider) return;
    const value = selectedTask.number ?? selectedTask.iid;
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(number) || number <= 0) return;
    const kind = activeScope === "pulls" ? (visibleProvider === "github" ? "pull_request" : "merge_request") : "issue";
    void performMutation(kind, number, operation, fields);
  };
  const formatComposer = (format: Parameters<TaskRichEditorHandle["format"]>[0]) => {
    composerEditorRef.current?.format(format);
  };
  const insertComposerImage = () => {
    const url = composerImageUrl.trim();
    if (!safeTaskImageUrl(url)) {
      setComposerError("Use an anonymous HTTPS image URL.");
      return;
    }
    const alt = composerImageAlt.trim() || "image";
    composerEditorRef.current?.insertImage(url, alt);
    setComposerImageOpen(false);
    setComposerImageUrl("");
    setComposerImageAlt("");
    setComposerError(null);
  };
  const uploadComposerImage = async (file: File) => {
    const projectId = activeProjectId;
    if (!projectId || visibleProvider !== "github") {
      setComposerError("Image upload is currently supported for GitHub issues and pull requests.");
      return;
    }
    const contentType = file.type.trim().toLowerCase();
    if (!(contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/gif" || contentType === "image/webp") || file.size > 10 * 1024 * 1024) {
      setComposerError("Choose a PNG, JPEG, GIF, or WebP image up to 10 MiB.");
      return;
    }
    const editor = composerEditorRef.current;
    const pendingId = editor?.insertPendingImage(file.name) ?? null;
    setComposerUploadCount((value) => value + 1);
    setComposerError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image"));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(",");
      if (comma < 0) throw new Error("Invalid image data");
      const url = await api.uploadGithubTaskImage(projectId, file.name, contentType, dataUrl.slice(comma + 1));
      if (editor && pendingId) {
        const previewUrl = URL.createObjectURL(file);
        editor.resolvePendingImage(pendingId, url, file.name, previewUrl);
      }
    } catch (reason: unknown) {
      if (editor && pendingId) editor.failPendingImage(pendingId);
      setComposerError(errorText(reason));
    } finally {
      setComposerUploadCount((value) => Math.max(0, value - 1));
      if (composerFileRef.current) composerFileRef.current.value = "";
    }
  };
  const handleNativeImagePaste = async () => {
    try {
      const file = await readClipboardImageFile();
      await uploadComposerImage(file);
    } catch (reason: unknown) {
      setComposerError(errorText(reason));
    }
  };
  const submitComposer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!composerKind || !visibleProvider || !composerTitle.trim()) return;
    if (composerBody.length > 20_000) {
      setComposerError("Description is limited to 20,000 characters.");
      return;
    }
    const operation = composerKind === "issue" ? "create_issue" : visibleProvider === "github" ? "create_pull_request" : "create_merge_request";
    const fields: TaskMutationFields = {
      title: composerTitle.trim(),
      body: composerBody,
      labels: composerLabels,
      assignees: composerAssignees,
      reviewers: composerReviewers,
    };
    if (composerKind === "pull_request") {
      fields.head = composerHead.trim();
      fields.base = composerBase.trim();
    }
    if (composerKind === "merge_request") {
      fields.sourceBranch = composerHead.trim();
      fields.targetBranch = composerBase.trim();
    }
    void performMutation(composerKind, 0, operation, fields);
  };
  const boardColumns = useMemo(() => {
    const columns: Array<{ id: "open" | "review" | "done"; label: string; items: TaskRecord[] }> = [
      { id: "open", label: "Open", items: [] },
      { id: "done", label: "Closed", items: [] },
    ];
    for (const task of filteredItems) {
      const tone = taskTone(task, activeScope);
      const column = columns.find((candidate) => candidate.id === (tone === "done" ? "done" : tone === "review" ? "review" : "open"));
      column?.items.push(task);
    }
    return columns;
  }, [activeScope, filteredItems]);

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
  const supported = visibleProvider ? supportedScopes(visibleProvider) : [];
  const providerName = visibleProvider ? providerLabels[visibleProvider] : "Task provider";
  const chooseScope = (scope: TaskScope) => {
    setActiveScope(scope);
    setSelectedId(null);
    setQuery("");
    setFilterReview("all");
    setMutationNotice(null);
  };
  const openComposer = () => {
    if (!visibleProvider || (activeScope !== "issues" && activeScope !== "pulls")) return;
    setComposerKind(activeScope === "issues" ? "issue" : visibleProvider === "github" ? "pull_request" : "merge_request");
    setComposerTitle("");
    setComposerBody("");
    setComposerHead("");
    setComposerBase("main");
    setComposerLabels([]);
    setComposerAssignees([]);
    setComposerReviewers([]);
    setComposerImageOpen(false);
    setComposerImageUrl("");
    setComposerImageAlt("");
    setComposerError(null);
    setMutationNotice(null);
  };
  const titleRepository = repository ?? detection?.repository ?? "No repository detected";
  const statusText = detecting
    ? "Detecting source"
    : detectionError && !visibleProvider
      ? errorLabel(detectionError)
      : error
        ? errorLabel(error)
        : activeError
          ? errorLabel(activeError)
          : loading
            ? "Syncing"
            : "Up to date";
  const statusMessage = detectionError ?? error ?? activeError;

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
            <span className={`task-center-sync-status task-center-sync-status-${errorCategory(statusMessage)}`}><span aria-hidden="true" />{statusText}</span>
          </div>
          <div className="task-center-topbar-actions">
            <button className="task-center-topbar-close" type="button" onClick={onClose}>Close <span aria-hidden="true">Esc</span></button>
          </div>
        </header>

        <div className="task-center-mobile-nav" aria-label="Task Hub navigation">
          <span className="task-center-detected-provider">{visibleProvider ? <><ProviderMark provider={visibleProvider} /> {providerName}</> : detecting ? "Detecting source…" : "Unsupported source"}</span>
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
              <div className="task-center-source-button is-active" aria-label={visibleProvider ? `Detected ${providerName} source` : "Task provider detection"}>
                {visibleProvider ? <ProviderMark provider={visibleProvider} /> : <span className="task-center-provider-mark task-center-provider-mark-unknown" aria-hidden="true">?</span>}
                <span className="task-center-source-copy"><strong>{visibleProvider ? providerName : detecting ? "Detecting…" : "Unsupported remote"}</strong><small>{visibleProvider ? "Detected from origin/main" : detection?.host ?? "GitHub or GitLab only"}</small></span>
                {visibleProvider ? <span className="task-center-source-chevron" aria-hidden="true">✓</span> : null}
              </div>
            </div>
            <div className="task-center-source-divider" />
            <div className="task-center-source-heading">Views</div>
            <nav className="task-center-scope-list" aria-label={`${providerName} task views`}>
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

          <main className="task-center-list-pane" aria-label={`${providerName} ${activeScopeMeta.label}`}>
            <header className="task-center-list-head">
              <div className="task-center-list-heading">
                <span className="task-center-eyebrow">{visibleProvider ? <><ProviderMark provider={visibleProvider} /> {providerName} / {activeScopeMeta.shortLabel}</> : detecting ? "Detecting source" : "Unsupported source"}</span>
                <h2>{activeScopeMeta.label}</h2>
                <p>{activeScopeMeta.description} <span aria-hidden="true">·</span> {filteredItems.length} of {activeItems.length}</p>
              </div>
              <div className="task-center-list-actions">
                {visibleProvider && (activeScope === "issues" || activeScope === "pulls") ? <button className="task-center-create-button" type="button" onClick={openComposer} disabled={mutationBusy}>New {activeScope === "issues" ? "issue" : visibleProvider === "github" ? "pull request" : "merge request"}</button> : null}
                <button className="task-center-refresh-button" type="button" onClick={refresh} disabled={loading || mutationBusy} aria-label="Refresh tasks">
                  <span className={loading ? "task-center-refresh-icon is-spinning" : "task-center-refresh-icon"} aria-hidden="true">↻</span>
                  <span>{loading ? "Refreshing" : "Refresh"}</span>
                </button>
              </div>
            </header>
            <div className="task-center-filterbar">
              <div className="task-center-filter-chips" role="group" aria-label="Quick filters">
                <button type="button" className={filterStatus === "open" ? "is-active" : ""} aria-pressed={filterStatus === "open"} onClick={() => setFilterStatus(filterStatus === "open" ? "all" : "open")}>Open</button>
                <button type="button" className={assignedOnly ? "is-active" : ""} aria-pressed={assignedOnly} onClick={() => setAssignedOnly(!assignedOnly)}>Assigned</button>
                <button type="button" className={filtersOpen ? "is-active" : ""} aria-pressed={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filterLabel || filterAssignee || filterAuthor || filterReview !== "all" || filterStatus === "closed" ? " ·" : ""}</button>
              </div>
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
            {filtersOpen ? <div className="task-center-filter-popover" role="dialog" aria-label="Task filters">
              <div className="task-center-filter-popover-head"><strong>Filter tasks</strong><button type="button" onClick={() => { setFilterStatus("all"); setAssignedOnly(false); setFilterLabel(""); setFilterAssignee(""); setFilterAuthor(""); setFilterReview("all"); setQuery(""); }}>Clear all</button></div>
              <div className="task-center-filter-grid">
                <label>Status<select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as "all" | "open" | "closed")}><option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
                <TaskOptionPicker label="Author" options={authorOptions} selected={filterAuthor ? [filterAuthor] : []} onChange={(values) => setFilterAuthor(values[0] ?? "")} placeholder="All authors" multiple={false} />
                <TaskOptionPicker label="Label" options={filterLabelOptions} selected={filterLabel ? [filterLabel] : []} onChange={(values) => setFilterLabel(values[0] ?? "")} placeholder="All labels" />
                <TaskOptionPicker label="Assignee" options={filterAssigneeOptions} selected={filterAssignee ? [filterAssignee] : []} onChange={(values) => setFilterAssignee(values[0] ?? "")} placeholder="All assignees" multiple={false} />
                {activeScope === "pulls" ? <label>Reviews<select value={filterReview} onChange={(event) => setFilterReview(event.target.value as ReviewFilter)}><option value="all">All reviews</option>{reviewFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
              </div>
            </div> : null}
            {mutationNotice ? <div className={`task-center-mutation-notice is-${mutationNotice.tone}`} role={mutationNotice.tone === "success" ? "status" : "alert"}>{mutationNotice.text}</div> : null}
            {loading && activeItems.length > 0 ? <div className="task-center-stale-banner" role="status"><span className="task-center-stale-dot" aria-hidden="true" />Showing cached results while this view refreshes.</div> : null}
            <div className="task-center-list-body">
              {!visibleProvider ? <TaskDetectionState loading={detecting} detection={detection} /> : <>
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
              </>}
            </div>
          </main>

          {selectedTask && visibleProvider ? <TaskDetail task={selectedTask} scope={activeScope} provider={visibleProvider} projectId={activeProjectId} onClose={() => setSelectedId(null)} onMutate={mutateSelectedTask} mutationBusy={mutationBusy} /> : <aside className="task-center-detail task-center-detail-empty" aria-label="Task details"><div className="task-center-detail-empty-content"><span aria-hidden="true">↖</span><h3>{visibleProvider ? "Select a task" : "Task details unavailable"}</h3><p>{visibleProvider ? "Choose an item from the list to inspect its details." : "A supported provider must be detected first."}</p></div></aside>}
        </div>
      </section>
      {composerKind && visibleProvider ? (
        <div className="task-center-composer-layer" role="presentation">
          <form className="task-center-composer" onSubmit={submitComposer} role="dialog" aria-modal="true" aria-label={`New ${composerKind.replace("_", " ")}`}>
            <header className="task-center-composer-head">
              <div>
                <span className="task-center-eyebrow">{providerName} / Create</span>
                <h2>New {composerKind === "issue" ? "issue" : composerKind === "pull_request" ? "pull request" : "merge request"}</h2>
                <p>Filing in {titleRepository}</p>
              </div>
              <button type="button" className="task-center-icon-button" onClick={() => setComposerKind(null)} disabled={mutationBusy || composerUploading} aria-label="Close create form">×</button>
            </header>
            <div className="task-center-composer-body">
              <label>Title<input value={composerTitle} onChange={(event) => setComposerTitle(event.target.value)} placeholder="Short summary" maxLength={256} required autoFocus /></label>
              {(composerKind === "pull_request" || composerKind === "merge_request") ? <div className="task-center-composer-grid"><TaskOptionPicker label={composerKind === "pull_request" ? "Head branch" : "Source branch"} options={taskOptions.branches} selected={composerHead ? [composerHead] : []} onChange={(values) => setComposerHead(values[0] ?? "")} loading={taskOptions.loading} placeholder="Choose origin branch" multiple={false} /><TaskOptionPicker label={composerKind === "pull_request" ? "Base branch" : "Target branch"} options={taskOptions.branches} selected={composerBase ? [composerBase] : []} onChange={(values) => setComposerBase(values[0] ?? "")} loading={taskOptions.loading} placeholder="Choose origin branch" multiple={false} /></div> : null}
              <div className="task-center-composer-field"><div>Description <span className="task-center-composer-hint">optional, rendered Markdown</span></div>
                <div className="task-center-markdown-editor">
                  <div className="task-center-markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
                    <button type="button" aria-label="Heading" onClick={() => formatComposer("heading")}>H1</button><button type="button" aria-label="Bold" onClick={() => formatComposer("bold")}>B</button><button type="button" aria-label="Italic" onClick={() => formatComposer("italic")}>I</button><button type="button" aria-label="Strikethrough" onClick={() => formatComposer("strike")}>S</button><span />
                    <button type="button" aria-label="Bulleted list" onClick={() => formatComposer("unordered-list")}>☷</button><button type="button" aria-label="Task list" onClick={() => formatComposer("task-list")}>☑</button><button type="button" aria-label="Quote" onClick={() => formatComposer("quote")}>❯</button><button type="button" aria-label="Code block" onClick={() => formatComposer("code")}>Code</button><span />
                    <button type="button" aria-label="Insert link" onClick={() => formatComposer("link")}>↗</button><button type="button" className={composerImageOpen ? "is-active" : ""} onClick={() => setComposerImageOpen(!composerImageOpen)} aria-pressed={composerImageOpen} aria-label="Insert image URL">URL▧</button><button type="button" onClick={() => composerFileRef.current?.click()} disabled={composerUploading || visibleProvider !== "github"} title={visibleProvider === "github" ? "Upload image" : "GitLab image upload unavailable"} aria-label="Upload image">⇧▧</button>
                    <input ref={composerFileRef} className="task-center-hidden-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadComposerImage(file); }} />
                  </div>
                  <TaskRichEditor
                    key={`${composerKind}-${titleRepository}`}
                    ref={composerEditorRef}
                    initialValue={composerBody}
                    onChange={setComposerBody}
                    onImageFile={(file) => void uploadComposerImage(file)}
                    onNativeImagePaste={() => void handleNativeImagePaste()}
                    onError={setComposerError}
                  />
                </div>
              </div>
              {composerImageOpen ? <div className="task-center-image-insert"><input value={composerImageAlt} onChange={(event) => setComposerImageAlt(event.target.value)} placeholder="Image alt text" aria-label="Image alt text" /><input value={composerImageUrl} onChange={(event) => setComposerImageUrl(event.target.value)} placeholder="https://… image URL" aria-label="Image URL" /><button type="button" onClick={insertComposerImage}>Insert image</button></div> : null}
              {composerUploading ? <p className="task-center-composer-status" role="status">Uploading image… it will appear in the editor when ready.</p> : null}
              {composerError ? <p className="task-center-composer-error" role="alert">{composerError}</p> : null}
              {taskOptions.error ? <p className="task-center-composer-status" role="status">Repository labels, branches, assignees, and reviewers are unavailable: {taskOptions.error}</p> : null}
              <div className="task-center-composer-grid"><TaskOptionPicker label="Labels" options={taskOptions.labels} selected={composerLabels} onChange={setComposerLabels} loading={taskOptions.loading} placeholder="Choose repository labels" /><TaskOptionPicker label="Assignees" options={taskOptions.assignees} selected={composerAssignees} onChange={setComposerAssignees} loading={taskOptions.loading} placeholder="Choose repository assignees" /></div>
              {(composerKind === "pull_request" || composerKind === "merge_request") ? <div className="task-center-composer-grid"><TaskOptionPicker label="Reviewers" options={taskOptions.reviewers} selected={composerReviewers} onChange={setComposerReviewers} loading={taskOptions.loading} placeholder="Choose repository reviewers" /></div> : null}
            </div>
            <footer className="task-center-composer-foot"><button type="button" className="task-center-composer-cancel" onClick={() => setComposerKind(null)} disabled={mutationBusy || composerUploading}>Cancel</button><button type="submit" className="task-center-composer-submit" disabled={mutationBusy || composerUploading || composerBody.length > 20_000 || !composerTitle.trim() || ((composerKind === "pull_request" || composerKind === "merge_request") && (!composerHead.trim() || !composerBase.trim()))}>{mutationBusy ? "Creating…" : composerUploading ? "Uploading…" : "Create"}</button></footer>
          </form>
        </div>
      ) : null}
    </div>
  );
}
