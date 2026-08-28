import type { ProjectLayoutEntry, ProjectView } from "./types";

export interface ProjectDropTarget {
  pinned: boolean;
  /** Zero-based insertion index within the target pin group after removal. */
  index: number;
}

export function projectLayoutEntries(
  projects: ProjectView[],
): ProjectLayoutEntry[] {
  return projects.map(({ id, pinned }) => ({ id, pinned }));
}

export function sameProjectLayout(a: ProjectView[], b: ProjectView[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (project, index) =>
        project.id === b[index]?.id && project.pinned === b[index]?.pinned,
    )
  );
}

/** Move one Project while preserving every other Project's relative order. */
export function moveProjectInLayout(
  projects: ProjectView[],
  projectId: string,
  target: ProjectDropTarget,
): ProjectView[] {
  const moving = projects.find((project) => project.id === projectId);
  if (!moving) return projects;

  const remaining = projects.filter((project) => project.id !== projectId);
  const pinned = remaining.filter((project) => project.pinned);
  const unpinned = remaining.filter((project) => !project.pinned);
  const targetGroup = target.pinned ? pinned : unpinned;
  const insertionIndex = Math.max(
    0,
    Math.min(target.index, targetGroup.length),
  );
  targetGroup.splice(insertionIndex, 0, { ...moving, pinned: target.pinned });
  const next = [...pinned, ...unpinned];
  return sameProjectLayout(projects, next) ? projects : next;
}

/** Menu pinning always places the Project first in its destination group. */
export function setProjectPinnedAtFront(
  projects: ProjectView[],
  projectId: string,
  pinned: boolean,
): ProjectView[] {
  return moveProjectInLayout(projects, projectId, { pinned, index: 0 });
}

/**
 * Resolve a pointer position against Project header midpoints. The closest
 * header owns the drop: its upper half means before, lower half means after.
 * This leaves a usable "end of pinned" target on one side of the group boundary
 * and an "start of unpinned" target on the other.
 */
export function projectDropTarget(
  projects: ProjectView[],
  projectId: string,
  headerMidpoints: ReadonlyMap<string, number>,
  pointerY: number,
): ProjectDropTarget | null {
  const movingIndex = projects.findIndex((project) => project.id === projectId);
  if (movingIndex < 0) {
    return null;
  }

  let nearestIndex = -1;
  let nearestMidpoint = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, project] of projects.entries()) {
    const midpoint = headerMidpoints.get(project.id);
    if (midpoint === undefined) {
      continue;
    }
    const distance = Math.abs(pointerY - midpoint);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestMidpoint = midpoint;
      nearestDistance = distance;
    }
  }
  if (nearestIndex < 0) {
    return null;
  }

  const moving = projects[movingIndex];
  if (nearestIndex === movingIndex) {
    return {
      pinned: moving.pinned,
      index: projects
        .slice(0, movingIndex)
        .filter((project) => project.pinned === moving.pinned).length,
    };
  }

  const nearest = projects[nearestIndex];
  const remaining = projects.filter((project) => project.id !== projectId);
  const nearestRemainingIndex = remaining.findIndex(
    (project) => project.id === nearest.id,
  );
  const sameGroupBefore = remaining
    .slice(0, nearestRemainingIndex)
    .filter((project) => project.pinned === nearest.pinned).length;
  return {
    pinned: nearest.pinned,
    index: sameGroupBefore + (pointerY > nearestMidpoint ? 1 : 0),
  };
}
