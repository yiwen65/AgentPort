import { useCallback, useEffect, useRef, useState } from "react";
import type { HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import type { ProjectSummary } from "../sessions/types";
import type { GitCheckoutDescriptor, WorktreeSummary } from "./types";

export interface ActiveGitProject {
  name: string;
  branch?: string;
  worktrees: ReadonlyMap<string, string>;
}

interface HostGitProjects {
  at: number;
  projects: ReadonlyMap<string, ActiveGitProject>;
}

const REFRESH_MS = 60_000;

/** Project names and checkout branches for the cross-device Active list. */
export function useActiveGitProjects(
  client: RemoteClient,
  hosts: readonly HostProfileSummary[],
  active: boolean,
): ReadonlyMap<string, ReadonlyMap<string, ActiveGitProject>> {
  const store = useRef({
    client,
    mounted: false,
    known: new Map<string, HostGitProjects>(),
    epochs: new Map<string, number>(),
  });
  const [projects, setProjects] = useState<ReadonlyMap<string, ReadonlyMap<string, ActiveGitProject>>>(new Map());
  const publish = useCallback(() => {
    if (store.current.mounted) {
      setProjects(new Map([...store.current.known].map(([id, value]) => [id, value.projects])));
    }
  }, []);
  const load = useCallback(async (hostId: string) => {
    const epoch = (store.current.epochs.get(hostId) ?? 0) + 1;
    store.current.epochs.set(hostId, epoch);
    try {
      const list = await store.current.client.request<ProjectSummary[]>(hostId, "project.list", {});
      if (!Array.isArray(list)) return;
      const entries = await Promise.all(list.map(async project => {
        const [worktrees, context] = await Promise.all([
          store.current.client.request<WorktreeSummary[]>(hostId, "worktree.list", { projectId: project.id })
            .then(value => Array.isArray(value) ? value : []).catch(() => []),
          store.current.client.request<GitCheckoutDescriptor>(hostId, "git.context.resolve", {
            locator: { kind: "projectMain", projectId: project.id },
          }).catch(() => undefined),
        ]);
        return [project.id, {
          name: project.name,
          branch: context?.actualBranch ?? undefined,
          worktrees: new Map(worktrees.map(worktree => [worktree.id, worktree.branch])),
        }] as const;
      }));
      if (!store.current.mounted || store.current.epochs.get(hostId) !== epoch) return;
      store.current.known.set(hostId, { at: Date.now(), projects: new Map(entries) });
      publish();
    } catch {
      // Project context is supplemental; session rows stay usable without it.
    }
  }, [publish]);

  const connectedKey = JSON.stringify(hosts.filter(host => host.connectionState === "connected").map(host => host.id).sort());

  useEffect(() => {
    store.current.mounted = true;
    return () => { store.current.mounted = false; };
  }, []);

  useEffect(() => {
    store.current.client = client;
    if (!active) return;
    for (const hostId of JSON.parse(connectedKey) as string[]) {
      if (!store.current.known.has(hostId)) void load(hostId);
    }
  }, [client, active, connectedKey, load]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const connected = new Set<string>(JSON.parse(connectedKey));
      for (const [hostId, value] of store.current.known) {
        if (connected.has(hostId) && Date.now() - value.at >= REFRESH_MS) void load(hostId);
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, connectedKey, load]);

  return projects;
}
