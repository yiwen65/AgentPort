import type { RemoteClient, RemoteRequestOptions } from "../../protocol/remoteClient";

/** Providers exposed by the read-only mobile task surface. */
export type TaskProvider = "github" | "gitlab";

export type GithubTaskScope = "issues" | "pulls" | "projects";
export type GitlabTaskScope = "issues" | "pulls" | "boards";
export type TaskScope = GithubTaskScope | GitlabTaskScope;

export interface TaskReadParams {
  provider: TaskProvider;
  projectId: string;
  scope: TaskScope;
}

export interface TaskDetailReadParams extends TaskReadParams {
  itemId: string;
}

export interface TaskRepository {
  host?: string;
  owner?: string;
  namespace?: string;
  name?: string;
  remoteUrl?: string;
  projectPath?: string;
  [key: string]: unknown;
}

export interface TaskError {
  code: string;
  message: string;
}

/**
 * The remote response is intentionally provider-neutral. `items` and `item`
 * remain unknown at the protocol boundary because GitHub and GitLab return
 * different fields. Display code uses the safe adapters below and never sends
 * a mutation method from this module.
 */
export interface TaskListResponse {
  provider: TaskProvider;
  scope: TaskScope;
  repository: TaskRepository | null;
  items: unknown[];
  error: TaskError | null;
}

export interface TaskDetailResponse {
  provider: TaskProvider;
  scope: TaskScope;
  repository: TaskRepository | null;
  item: unknown | null;
  error: TaskError | null;
}

export interface TaskSummary {
  id: string;
  number?: number;
  title: string;
  state: string;
  url: string | null;
  author: string | null;
  updatedAt: string | null;
  labels: string[];
  draft: boolean;
  type: string | null;
}

export interface TaskComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TaskDetail extends TaskSummary {
  body: string | null;
  comments: TaskComment[];
  assignees: string[];
  reviewers: string[];
  checks: string[];
}

export class TaskReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskReadError";
    this.code = code;
  }
}

const scopesByProvider: Record<TaskProvider, readonly TaskScope[]> = {
  github: ["issues", "pulls", "projects"],
  gitlab: ["issues", "pulls", "boards"],
};

export function scopesForProvider(provider: TaskProvider): readonly TaskScope[] {
  return scopesByProvider[provider];
}

export function isTaskProvider(value: unknown): value is TaskProvider {
  return value === "github" || value === "gitlab";
}

export function isTaskScope(provider: TaskProvider, value: unknown): value is TaskScope {
  return typeof value === "string" && scopesByProvider[provider].includes(value as TaskScope);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : undefined;
}

function parseError(value: unknown): TaskError | null {
  const item = record(value);
  if (!item) return null;
  const code = stringValue(item.code);
  const message = stringValue(item.message);
  return code && message ? { code, message } : null;
}

function parseRepository(value: unknown): TaskRepository | null {
  const item = record(value);
  if (!item) return null;
  const repository: TaskRepository = {};
  for (const [key, entry] of Object.entries(item)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      repository[key] = entry;
    }
  }
  return repository;
}

function parseProvider(value: unknown, fallback: TaskProvider): TaskProvider {
  return isTaskProvider(value) ? value : fallback;
}

function parseScope(value: unknown, fallback: TaskScope): TaskScope {
  return typeof value === "string" ? value as TaskScope : fallback;
}

function parseEnvelope(value: unknown, fallback: TaskReadParams): Record<string, unknown> {
  const envelope = record(value);
  if (!envelope) throw new TaskReadError("invalid_response", "The task service returned an invalid response.");
  const provider = parseProvider(envelope.provider, fallback.provider);
  const scope = parseScope(envelope.scope, fallback.scope);
  if (provider !== fallback.provider || scope !== fallback.scope) {
    throw new TaskReadError("invalid_response", "The task response did not match the requested provider or scope.");
  }
  return envelope;
}

export function parseTaskListResponse(value: unknown, fallback: TaskReadParams): TaskListResponse {
  const envelope = parseEnvelope(value, fallback);
  const items = Array.isArray(envelope.items)
    ? envelope.items
    : envelope.items == null
      ? []
      : [envelope.items];
  return {
    provider: fallback.provider,
    scope: fallback.scope,
    repository: parseRepository(envelope.repository),
    items,
    error: parseError(envelope.error),
  };
}

export function parseTaskDetailResponse(value: unknown, fallback: TaskDetailReadParams): TaskDetailResponse {
  const envelope = parseEnvelope(value, fallback);
  return {
    provider: fallback.provider,
    scope: fallback.scope,
    repository: parseRepository(envelope.repository),
    item: envelope.item ?? null,
    error: parseError(envelope.error),
  };
}

export async function readTaskList(
  client: RemoteClient,
  profileId: string,
  params: TaskReadParams,
  options?: RemoteRequestOptions,
): Promise<TaskListResponse> {
  return parseTaskListResponse(await client.request<unknown>(profileId, "task.list", params, options), params);
}

export async function readTaskDetail(
  client: RemoteClient,
  profileId: string,
  params: TaskDetailReadParams,
  options?: RemoteRequestOptions,
): Promise<TaskDetailResponse> {
  return parseTaskDetailResponse(await client.request<unknown>(profileId, "task.detail", params, options), params);
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const item = record(value);
  if (!item) return null;
  return stringValue(item.login) ?? stringValue(item.username) ?? stringValue(item.name) ?? stringValue(item.email);
}

function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => textFrom(entry)).filter((entry): entry is string => Boolean(entry));
}

function usersFrom(value: unknown): string[] {
  return labelsFrom(value);
}

function idFrom(item: Record<string, unknown>): { id: string; number?: number } {
  const number = numberValue(item.number ?? item.iid);
  const id = stringValue(item.id) ?? (number === undefined ? null : String(number))
    ?? stringValue(item.webUrl) ?? stringValue(item.url) ?? stringValue(item.name);
  return { id: id ?? "unknown", number };
}

/** Convert provider-shaped issue/PR/MR/project values into safe list rows. */
export function taskSummary(value: unknown): TaskSummary {
  const item = record(value) ?? {};
  const identity = idFrom(item);
  return {
    id: identity.id,
    number: identity.number,
    title: stringValue(item.title) ?? stringValue(item.name) ?? stringValue(item.subject) ?? `Task ${identity.id}`,
    state: stringValue(item.state) ?? stringValue(item.status) ?? "unknown",
    url: stringValue(item.url) ?? stringValue(item.webUrl) ?? stringValue(item.web_url),
    author: textFrom(item.author ?? item.user ?? item.assignee),
    updatedAt: stringValue(item.updatedAt) ?? stringValue(item.updated_at) ?? stringValue(item.updatedAtIso),
    labels: labelsFrom(item.labels ?? item.label),
    draft: item.draft === true,
    type: stringValue(item.type) ?? stringValue(item.kind),
  };
}

function commentFrom(value: unknown, index: number): TaskComment {
  const item = record(value) ?? {};
  return {
    id: stringValue(item.id) ?? String(index),
    author: textFrom(item.author ?? item.user),
    body: stringValue(item.body) ?? stringValue(item.note) ?? stringValue(item.text) ?? "",
    createdAt: stringValue(item.createdAt) ?? stringValue(item.created_at),
    updatedAt: stringValue(item.updatedAt) ?? stringValue(item.updated_at),
  };
}

/** Convert a provider-shaped detail value while preserving only display fields. */
export function taskDetail(value: unknown): TaskDetail {
  const item = record(value) ?? {};
  const summary = taskSummary(item);
  const comments = Array.isArray(item.comments)
    ? item.comments.map(commentFrom)
    : Array.isArray(item.notes) ? item.notes.map(commentFrom) : [];
  return {
    ...summary,
    body: stringValue(item.body) ?? stringValue(item.description) ?? stringValue(item.content),
    comments,
    assignees: usersFrom(item.assignees ?? item.assigned_to),
    reviewers: usersFrom(item.reviewers ?? item.reviewedBy),
    checks: labelsFrom(item.checks ?? item.statuses),
  };
}

export function taskErrorFromUnknown(error: unknown): TaskError {
  const item = record(error);
  const code = stringValue(item?.code) ?? "request_failed";
  const message = stringValue(item?.message) ?? "Could not read tasks from this computer.";
  return { code, message };
}

/** The mobile surface intentionally exposes only these two remote operations. */
export const MOBILE_TASK_READ_METHODS = ["task.list", "task.detail"] as const;
