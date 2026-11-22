export type TaskProvider = "github" | "gitlab";
export type TaskScope = "issues" | "pulls" | "projects" | "boards";
export type TaskItemKind = "issue" | "pull_request" | "merge_request";

export interface TaskRepositoryRef {
  provider: TaskProvider;
  host: string;
  owner: string;
  name: string;
  remoteUrl: string;
  projectId?: string;
}

export interface TaskCapabilitySet {
  comments: boolean;
  status: boolean;
  labels: boolean;
  assignees: boolean;
  reviews: boolean;
  checks: boolean;
  projects: boolean;
  projectWrites: boolean;
  merge: boolean;
}

export interface TaskItemSummary {
  id: string;
  kind: TaskItemKind;
  number: number;
  title: string;
  state: string;
  url: string | null;
  author: string | null;
  updatedAt: string | null;
  draft?: boolean;
  labels: string[];
  assignees: string[];
  repository: TaskRepositoryRef;
}

export interface TaskComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
}

export interface TaskItemDetail extends TaskItemSummary {
  body: string;
  comments: TaskComment[];
  checks: { name: string; state: string; url: string | null }[];
  sourceRevision: string | null;
}

export interface TaskProjectSummary {
  id: string;
  number: number;
  title: string;
  url: string | null;
  closed: boolean;
  repository: TaskRepositoryRef;
}

export interface TaskError {
  code: string;
  message: string;
  provider: TaskProvider;
  retryable: boolean;
}

export interface TaskEnvelope<T> {
  provider: TaskProvider;
  scope: TaskScope;
  repository: TaskRepositoryRef | null;
  capabilities: TaskCapabilitySet;
  data: T | null;
  error: TaskError | null;
}

export type TaskMutationOutcome =
  | { status: "succeeded"; data: TaskItemDetail | null }
  | { status: "failed"; error: TaskError }
  | { status: "unknown"; error: TaskError; readBackRequired: true };

export function taskRepositoryKey(ref: Pick<TaskRepositoryRef, "provider" | "host" | "owner" | "name" | "projectId">): string {
  return [ref.provider, ref.host.toLowerCase(), ref.owner.toLowerCase(), ref.name.toLowerCase(), ref.projectId ?? ""].join("\0");
}

export function taskCacheKey(args: {
  provider: TaskProvider;
  host: string;
  repository: string;
  scope: TaskScope;
  query?: string;
  device?: string;
}): string {
  return [args.device ?? "local", args.provider, args.host.toLowerCase(), args.repository, args.scope, args.query?.trim() ?? ""].join("\0");
}
