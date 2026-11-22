import type { TaskProvider, TaskScope } from "./taskApi";
import { isTaskProvider, isTaskScope } from "./taskApi";

export interface TaskDeepLink {
  profileId?: string;
  provider: TaskProvider;
  projectId: string;
  scope: TaskScope;
  itemId?: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return nonEmpty(decodeURIComponent(value)); } catch { return undefined; }
}

/**
 * Accept both custom-scheme links from native share sheets and HTTPS links
 * useful in a browser preview:
 *
 *   agentport://tasks?provider=github&projectId=42&scope=issues&itemId=7
 *   agentport://tasks/github/42/issues/7
 *   https://agentport.app/tasks/github/42/issues/7
 */
export function parseTaskDeepLink(value: string | URL): TaskDeepLink | undefined {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return undefined;
  }

  const query = url.searchParams;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter(Boolean).map(decode).filter((entry): entry is string => Boolean(entry));
  const taskPath = host === "tasks" ? path : path[0]?.toLowerCase() === "tasks" ? path.slice(1) : [];
  const providerValue = nonEmpty(query.get("provider")) ?? taskPath[0];
  const projectId = nonEmpty(query.get("projectId") ?? query.get("project")) ?? taskPath[1];
  const scopeValue = nonEmpty(query.get("scope")) ?? taskPath[2];
  const itemId = nonEmpty(query.get("itemId") ?? query.get("item")) ?? taskPath[3];
  if (!isTaskProvider(providerValue) || !projectId || !isTaskScope(providerValue, scopeValue)) return undefined;
  return {
    profileId: nonEmpty(query.get("profileId") ?? query.get("deviceId") ?? query.get("device")),
    provider: providerValue,
    projectId,
    scope: scopeValue,
    itemId,
  };
}

export function createTaskDeepLink(link: TaskDeepLink, scheme = "agentport:"): string {
  const params = new URLSearchParams({
    provider: link.provider,
    projectId: link.projectId,
    scope: link.scope,
  });
  if (link.profileId) params.set("profileId", link.profileId);
  if (link.itemId) params.set("itemId", link.itemId);
  return `${scheme}//tasks?${params.toString()}`;
}
