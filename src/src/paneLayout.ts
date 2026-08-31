export const MIN_PANE_WIDTH = 320;
export const MIN_PANE_HEIGHT = 180;
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MAX_PANE_LAYOUT_DEPTH = 32;
export const TERMINAL_LAYOUT_VERSION = 1;
export const TERMINAL_LAYOUT_STORAGE_KEY = "agentport-terminal-layout";

export type PaneSplitDirection = "right" | "down";

export interface PaneLeaf {
  type: "leaf";
  sessionId: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: PaneSplitDirection;
  /** Fraction of the split axis assigned to `first`. */
  ratio: number;
  first: PaneLayoutNode;
  second: PaneLayoutNode;
}

export type PaneLayoutNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
  root: PaneLayoutNode | null;
  focusedSessionId: string | null;
}

export interface PaneSize {
  width: number;
  height: number;
}

export type TerminalLayout = PaneLayout;

type LayoutSource = PaneLayout | PaneLayoutNode | null;
type ValidSessionIds = ReadonlySet<string> | readonly string[];

interface RemoveNodeResult {
  node: PaneLayoutNode | null;
  removed: boolean;
  promotedFocusSessionId: string | null;
}

interface SanitizeContext {
  validSessionIds: ReadonlySet<string> | null;
  seenSessionIds: Set<string>;
  seenSplitIds: Set<string>;
  seenNodes: WeakSet<object>;
  recoveredSplitSequence: number;
}

let splitSequence = 0;

function asRoot(source: LayoutSource): PaneLayoutNode | null {
  if (source === null) return null;
  return "root" in source ? source.root : source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function validSessionSet(validSessionIds?: ValidSessionIds): ReadonlySet<string> | null {
  if (!validSessionIds) return null;
  return validSessionIds instanceof Set
    ? validSessionIds
    : new Set(validSessionIds);
}

export function emptyPaneLayout(): PaneLayout {
  return { root: null, focusedSessionId: null };
}

export function paneLeaf(sessionId: string): PaneLeaf {
  return { type: "leaf", sessionId };
}

export function singletonPaneLayout(sessionId: string): PaneLayout {
  if (!sessionId) return emptyPaneLayout();
  return { root: paneLeaf(sessionId), focusedSessionId: sessionId };
}

/**
 * Layout currently shown in the workspace. A Session outside a remembered
 * split is a temporary singleton view; the persisted split remains intact.
 */
export function visiblePaneLayout(
  rememberedLayout: PaneLayout,
  activeSessionId: string | null,
): PaneLayout {
  if (!activeSessionId || layoutContains(rememberedLayout, activeSessionId)) {
    return rememberedLayout;
  }
  return singletonPaneLayout(activeSessionId);
}

/** True when a Session has exactly one leaf in the layout. */
export function layoutContains(source: LayoutSource, sessionId: string): boolean {
  if (!sessionId) return false;
  const root = asRoot(source);
  if (!root) return false;

  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      !current ||
      current.depth > MAX_PANE_LAYOUT_DEPTH ||
      !isRecord(current.node) ||
      seen.has(current.node)
    ) {
      continue;
    }
    seen.add(current.node);
    if (current.node.type === "leaf") {
      if (current.node.sessionId === sessionId) return true;
      continue;
    }
    if (current.node.type === "split") {
      stack.push(
        { node: current.node.second, depth: current.depth + 1 },
        { node: current.node.first, depth: current.depth + 1 },
      );
    }
  }
  return false;
}

/** Leaf Session ids in visual order: left-to-right, then top-to-bottom. */
export function orderedLayoutSessionIds(source: LayoutSource): string[] {
  const root = asRoot(source);
  if (!root) return [];

  const ids: string[] = [];
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      !current ||
      current.depth > MAX_PANE_LAYOUT_DEPTH ||
      !isRecord(current.node) ||
      seen.has(current.node)
    ) {
      continue;
    }
    seen.add(current.node);
    if (current.node.type === "leaf") {
      if (typeof current.node.sessionId === "string") ids.push(current.node.sessionId);
      continue;
    }
    if (current.node.type === "split") {
      stack.push(
        { node: current.node.second, depth: current.depth + 1 },
        { node: current.node.first, depth: current.depth + 1 },
      );
    }
  }
  return ids;
}

function safeSeparatorSize(separatorSize: number): number {
  return Number.isFinite(separatorSize) ? Math.max(0, separatorSize) : 0;
}

/** Aggregate minimum dimensions required by every leaf in a subtree. */
export function paneMinimumSize(
  node: PaneLayoutNode,
  separatorSize = 0,
  depth = 0,
): PaneSize {
  if (node.type === "leaf" || depth >= MAX_PANE_LAYOUT_DEPTH) {
    return { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT };
  }
  const separator = safeSeparatorSize(separatorSize);
  const first = paneMinimumSize(node.first, separator, depth + 1);
  const second = paneMinimumSize(node.second, separator, depth + 1);
  const ratio = isValidRatio(node.ratio) ? node.ratio : DEFAULT_SPLIT_RATIO;
  return node.direction === "right"
    ? {
        width: separator + Math.max(
          first.width / ratio,
          second.width / (1 - ratio),
        ),
        height: Math.max(first.height, second.height),
      }
    : {
        width: Math.max(first.width, second.width),
        height: separator + Math.max(
          first.height / ratio,
          second.height / (1 - ratio),
        ),
      };
}

/** Logical leaf size in the restored (non-maximized) layout. */
export function paneSessionSize(
  node: PaneLayoutNode,
  sessionId: string,
  width: number,
  height: number,
  separatorSize = 0,
  depth = 0,
): PaneSize | null {
  if (depth > MAX_PANE_LAYOUT_DEPTH) return null;
  const boundedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const boundedHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  if (node.type === "leaf") {
    return node.sessionId === sessionId
      ? { width: boundedWidth, height: boundedHeight }
      : null;
  }

  const separator = safeSeparatorSize(separatorSize);
  const ratio = isValidRatio(node.ratio) ? node.ratio : DEFAULT_SPLIT_RATIO;
  if (node.direction === "right") {
    const available = Math.max(0, boundedWidth - separator);
    const firstWidth = available * ratio;
    return (
      paneSessionSize(
        node.first,
        sessionId,
        firstWidth,
        boundedHeight,
        separator,
        depth + 1,
      ) ??
      paneSessionSize(
        node.second,
        sessionId,
        available - firstWidth,
        boundedHeight,
        separator,
        depth + 1,
      )
    );
  }

  const available = Math.max(0, boundedHeight - separator);
  const firstHeight = available * ratio;
  return (
    paneSessionSize(
      node.first,
      sessionId,
      boundedWidth,
      firstHeight,
      separator,
      depth + 1,
    ) ??
    paneSessionSize(
      node.second,
      sessionId,
      boundedWidth,
      available - firstHeight,
      separator,
      depth + 1,
    )
  );
}

/** True when the current ratios give every descendant leaf its minimum size. */
export function paneLayoutFitsSize(
  node: PaneLayoutNode,
  width: number,
  height: number,
  separatorSize = 0,
  depth = 0,
): boolean {
  if (depth > MAX_PANE_LAYOUT_DEPTH) return false;
  const boundedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const boundedHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  if (node.type === "leaf") {
    return boundedWidth >= MIN_PANE_WIDTH - 1e-6 &&
      boundedHeight >= MIN_PANE_HEIGHT - 1e-6;
  }

  const separator = safeSeparatorSize(separatorSize);
  const ratio = isValidRatio(node.ratio) ? node.ratio : DEFAULT_SPLIT_RATIO;
  if (node.direction === "right") {
    const available = Math.max(0, boundedWidth - separator);
    const firstWidth = available * ratio;
    return paneLayoutFitsSize(
      node.first,
      firstWidth,
      boundedHeight,
      separator,
      depth + 1,
    ) && paneLayoutFitsSize(
      node.second,
      available - firstWidth,
      boundedHeight,
      separator,
      depth + 1,
    );
  }

  const available = Math.max(0, boundedHeight - separator);
  const firstHeight = available * ratio;
  return paneLayoutFitsSize(
    node.first,
    boundedWidth,
    firstHeight,
    separator,
    depth + 1,
  ) && paneLayoutFitsSize(
    node.second,
    boundedWidth,
    available - firstHeight,
    separator,
    depth + 1,
  );
}

/** Clamp a divider without shrinking any descendant leaf below its minimum. */
export function clampPaneSplitRatio(
  split: PaneSplit,
  axisLength: number,
  desiredRatio: number,
  separatorSize = 0,
): number {
  const separator = safeSeparatorSize(separatorSize);
  const available = Math.max(
    0,
    (Number.isFinite(axisLength) ? Math.max(0, axisLength) : 0) - separator,
  );
  const firstSize = paneMinimumSize(split.first, separator);
  const secondSize = paneMinimumSize(split.second, separator);
  const firstMinimum = split.direction === "right" ? firstSize.width : firstSize.height;
  const secondMinimum = split.direction === "right" ? secondSize.width : secondSize.height;
  const totalMinimum = firstMinimum + secondMinimum;

  if (available < totalMinimum || available === 0) {
    return firstMinimum / totalMinimum;
  }
  const ratio = Number.isFinite(desiredRatio) ? desiredRatio : split.ratio;
  return Math.max(
    firstMinimum / available,
    Math.min(1 - secondMinimum / available, ratio),
  );
}

export function createPaneSplitId(): string {
  splitSequence += 1;
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `pane-split-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // A monotonic fallback is sufficient; insertion also resolves collisions.
  }
  return `pane-split-${Date.now().toString(36)}-${splitSequence.toString(36)}`;
}

function splitIds(root: PaneLayoutNode | null): Set<string> {
  if (!root) return new Set();
  const ids = new Set<string>();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      !current ||
      current.depth > MAX_PANE_LAYOUT_DEPTH ||
      !isRecord(current.node) ||
      seen.has(current.node)
    ) {
      continue;
    }
    seen.add(current.node);
    if (current.node.type === "split") {
      if (typeof current.node.id === "string") ids.add(current.node.id);
      stack.push(
        { node: current.node.second, depth: current.depth + 1 },
        { node: current.node.first, depth: current.depth + 1 },
      );
    }
  }
  return ids;
}

function uniqueSplitId(root: PaneLayoutNode | null, requested?: string): string {
  const used = splitIds(root);
  const base = requested?.trim() || createPaneSplitId();
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function splitNodeAt(
  node: PaneLayoutNode,
  targetSessionId: string,
  newSessionId: string,
  direction: PaneSplitDirection,
  splitId: string,
  depth: number,
): PaneLayoutNode {
  if (node.type === "leaf") {
    if (node.sessionId !== targetSessionId || depth >= MAX_PANE_LAYOUT_DEPTH) return node;
    return {
      type: "split",
      id: splitId,
      direction,
      ratio: DEFAULT_SPLIT_RATIO,
      first: node,
      second: paneLeaf(newSessionId),
    };
  }
  if (depth >= MAX_PANE_LAYOUT_DEPTH) return node;
  const first = splitNodeAt(
    node.first,
    targetSessionId,
    newSessionId,
    direction,
    splitId,
    depth + 1,
  );
  if (first !== node.first) return { ...node, first };
  const second = splitNodeAt(
    node.second,
    targetSessionId,
    newSessionId,
    direction,
    splitId,
    depth + 1,
  );
  return second === node.second ? node : { ...node, second };
}

/** Add a new Session immediately right of or below a target leaf. */
export function splitPane(
  layout: PaneLayout,
  targetSessionId: string,
  newSessionId: string,
  direction: PaneSplitDirection,
  requestedSplitId?: string,
): PaneLayout {
  if (
    !layout.root ||
    !targetSessionId ||
    !newSessionId ||
    targetSessionId === newSessionId ||
    layoutContains(layout, newSessionId) ||
    !layoutContains(layout, targetSessionId)
  ) {
    return layout;
  }
  const root = splitNodeAt(
    layout.root,
    targetSessionId,
    newSessionId,
    direction,
    uniqueSplitId(layout.root, requestedSplitId),
    0,
  );
  if (root === layout.root) return layout;
  return { root, focusedSessionId: newSessionId };
}

function directPlacementExists(
  node: PaneLayoutNode,
  targetSessionId: string,
  movingSessionId: string,
  direction: PaneSplitDirection,
  depth = 0,
): boolean {
  if (node.type === "leaf" || depth >= MAX_PANE_LAYOUT_DEPTH) return false;
  if (
    node.direction === direction &&
    node.first.type === "leaf" &&
    node.first.sessionId === targetSessionId &&
    node.second.type === "leaf" &&
    node.second.sessionId === movingSessionId
  ) {
    return true;
  }
  return (
    directPlacementExists(
      node.first,
      targetSessionId,
      movingSessionId,
      direction,
      depth + 1,
    ) ||
    directPlacementExists(
      node.second,
      targetSessionId,
      movingSessionId,
      direction,
      depth + 1,
    )
  );
}

function firstSessionId(node: PaneLayoutNode): string | null {
  return orderedLayoutSessionIds(node)[0] ?? null;
}

function lastSessionId(node: PaneLayoutNode): string | null {
  const ids = orderedLayoutSessionIds(node);
  return ids[ids.length - 1] ?? null;
}

function removeNode(
  node: PaneLayoutNode,
  sessionId: string,
  depth = 0,
): RemoveNodeResult {
  if (node.type === "leaf") {
    return node.sessionId === sessionId
      ? { node: null, removed: true, promotedFocusSessionId: null }
      : { node, removed: false, promotedFocusSessionId: null };
  }
  if (depth >= MAX_PANE_LAYOUT_DEPTH) {
    return { node, removed: false, promotedFocusSessionId: null };
  }

  const first = removeNode(node.first, sessionId, depth + 1);
  if (first.removed) {
    if (!first.node) {
      return {
        node: node.second,
        removed: true,
        promotedFocusSessionId: firstSessionId(node.second),
      };
    }
    return {
      node: { ...node, first: first.node },
      removed: true,
      promotedFocusSessionId: first.promotedFocusSessionId,
    };
  }

  const second = removeNode(node.second, sessionId, depth + 1);
  if (!second.removed) return { node, removed: false, promotedFocusSessionId: null };
  if (!second.node) {
    return {
      node: node.first,
      removed: true,
      promotedFocusSessionId: lastSessionId(node.first),
    };
  }
  return {
    node: { ...node, second: second.node },
    removed: true,
    promotedFocusSessionId: second.promotedFocusSessionId,
  };
}

/**
 * Move an existing leaf beside a target. Removal happens first, so the moving
 * Session can never be duplicated. Existing unaffected split ids stay stable.
 */
export function movePane(
  layout: PaneLayout,
  movingSessionId: string,
  targetSessionId: string,
  direction: PaneSplitDirection,
  requestedSplitId?: string,
): PaneLayout {
  if (
    !layout.root ||
    !movingSessionId ||
    !targetSessionId ||
    !layoutContains(layout, movingSessionId) ||
    !layoutContains(layout, targetSessionId)
  ) {
    return layout;
  }
  if (
    movingSessionId === targetSessionId ||
    directPlacementExists(layout.root, targetSessionId, movingSessionId, direction)
  ) {
    return layout.focusedSessionId === movingSessionId
      ? layout
      : { ...layout, focusedSessionId: movingSessionId };
  }

  const removed = removeNode(layout.root, movingSessionId);
  if (!removed.removed || !removed.node) return layout;
  const root = splitNodeAt(
    removed.node,
    targetSessionId,
    movingSessionId,
    direction,
    uniqueSplitId(removed.node, requestedSplitId),
    0,
  );
  // A depth-bounded target cannot be split; keep the move transactional.
  if (root === removed.node) return layout;
  return { root, focusedSessionId: movingSessionId };
}

/** Remove a leaf and focus the closest edge of its promoted sibling. */
export function removePane(layout: PaneLayout, sessionId: string): PaneLayout {
  if (!layout.root || !sessionId) return layout;
  const result = removeNode(layout.root, sessionId);
  if (!result.removed) return layout;
  if (!result.node) return emptyPaneLayout();

  const focusedSessionId =
    layout.focusedSessionId &&
    layout.focusedSessionId !== sessionId &&
    layoutContains(result.node, layout.focusedSessionId)
      ? layout.focusedSessionId
      : result.promotedFocusSessionId ?? firstSessionId(result.node);
  return { root: result.node, focusedSessionId };
}

function updateNodeRatio(
  node: PaneLayoutNode,
  splitId: string,
  ratio: number,
  depth = 0,
): PaneLayoutNode {
  if (node.type === "leaf" || depth > MAX_PANE_LAYOUT_DEPTH) return node;
  if (node.id === splitId) return node.ratio === ratio ? node : { ...node, ratio };
  const first = updateNodeRatio(node.first, splitId, ratio, depth + 1);
  if (first !== node.first) return { ...node, first };
  const second = updateNodeRatio(node.second, splitId, ratio, depth + 1);
  return second === node.second ? node : { ...node, second };
}

/** Update one stable split id. Invalid ratios are ignored. */
export function updateSplitRatio(
  layout: PaneLayout,
  splitId: string,
  ratio: number,
): PaneLayout {
  if (!layout.root || !splitId || !isValidRatio(ratio)) return layout;
  const root = updateNodeRatio(layout.root, splitId, ratio);
  return root === layout.root ? layout : { ...layout, root };
}

export function focusPane(layout: PaneLayout, sessionId: string): PaneLayout {
  if (!layoutContains(layout, sessionId) || layout.focusedSessionId === sessionId) return layout;
  return { ...layout, focusedSessionId: sessionId };
}

function recoveredSplitId(rawId: unknown, context: SanitizeContext): string {
  const requested = typeof rawId === "string" ? rawId.trim() : "";
  let base = requested;
  if (!base) {
    context.recoveredSplitSequence += 1;
    base = `pane-split-recovered-${context.recoveredSplitSequence}`;
  }
  if (!context.seenSplitIds.has(base)) {
    context.seenSplitIds.add(base);
    return base;
  }
  let suffix = 2;
  while (context.seenSplitIds.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  context.seenSplitIds.add(id);
  return id;
}

function sanitizeNode(
  value: unknown,
  context: SanitizeContext,
  depth: number,
): PaneLayoutNode | null {
  if (depth > MAX_PANE_LAYOUT_DEPTH || !isRecord(value)) return null;
  if (context.seenNodes.has(value)) return null;
  context.seenNodes.add(value);

  if (value.type === "leaf") {
    const sessionId = value.sessionId;
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      context.seenSessionIds.has(sessionId) ||
      (context.validSessionIds && !context.validSessionIds.has(sessionId))
    ) {
      return null;
    }
    context.seenSessionIds.add(sessionId);
    return paneLeaf(sessionId);
  }

  if (value.type !== "split" || depth >= MAX_PANE_LAYOUT_DEPTH) return null;
  const first = sanitizeNode(value.first, context, depth + 1);
  const second = sanitizeNode(value.second, context, depth + 1);
  if (!first) return second;
  if (!second) return first;
  return {
    type: "split",
    id: recoveredSplitId(value.id, context),
    direction: value.direction === "down" ? "down" : "right",
    ratio: isValidRatio(value.ratio) ? value.ratio : DEFAULT_SPLIT_RATIO,
    first,
    second,
  };
}

function nearestSurvivingFocus(
  originalIds: string[],
  focusedSessionId: string | null,
  remainingIds: string[],
): string | null {
  if (remainingIds.length === 0) return null;
  if (!focusedSessionId) return remainingIds[0];
  const remaining = new Set(remainingIds);
  if (remaining.has(focusedSessionId)) return focusedSessionId;
  const index = originalIds.indexOf(focusedSessionId);
  if (index < 0) return remainingIds[0];
  for (let distance = 1; distance < originalIds.length; distance += 1) {
    const after = originalIds[index + distance];
    if (after && remaining.has(after)) return after;
    const before = originalIds[index - distance];
    if (before && remaining.has(before)) return before;
  }
  return remainingIds[0];
}

function sameNode(a: PaneLayoutNode | null, b: PaneLayoutNode | null, depth = 0): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type || depth > MAX_PANE_LAYOUT_DEPTH) return false;
  if (a.type === "leaf" && b.type === "leaf") return a.sessionId === b.sessionId;
  if (a.type === "split" && b.type === "split") {
    return (
      a.id === b.id &&
      a.direction === b.direction &&
      a.ratio === b.ratio &&
      sameNode(a.first, b.first, depth + 1) &&
      sameNode(a.second, b.second, depth + 1)
    );
  }
  return false;
}

export function samePaneLayout(a: PaneLayout, b: PaneLayout): boolean {
  return a.focusedSessionId === b.focusedSessionId && sameNode(a.root, b.root);
}

/**
 * Validate an unknown tree, discard duplicate/invalid leaves, repair split
 * metadata, and collapse every split that has only one surviving child.
 */
export function sanitizePaneLayout(
  value: unknown,
  validSessionIds?: ValidSessionIds,
): PaneLayout {
  const wrapper = isRecord(value) && "root" in value;
  const rawRoot = wrapper ? value.root : value;
  const rawFocus = wrapper && typeof value.focusedSessionId === "string"
    ? value.focusedSessionId
    : null;
  const originalIds = isRecord(rawRoot)
    ? orderedLayoutSessionIds(rawRoot as unknown as PaneLayoutNode)
    : [];
  const context: SanitizeContext = {
    validSessionIds: validSessionSet(validSessionIds),
    seenSessionIds: new Set(),
    seenSplitIds: new Set(),
    seenNodes: new WeakSet(),
    recoveredSplitSequence: 0,
  };
  const root = sanitizeNode(rawRoot, context, 0);
  const ids = orderedLayoutSessionIds(root);
  return {
    root,
    focusedSessionId: nearestSurvivingFocus(originalIds, rawFocus, ids),
  };
}

export function prunePaneLayout(
  layout: PaneLayout,
  validSessionIds: ValidSessionIds,
): PaneLayout {
  const valid = validSessionSet(validSessionIds) ?? new Set<string>();
  let next = sanitizePaneLayout(layout);
  for (const sessionId of orderedLayoutSessionIds(next)) {
    if (!valid.has(sessionId)) next = removePane(next, sessionId);
  }
  return samePaneLayout(layout, next) ? layout : next;
}

interface PersistedTerminalLayoutV1 {
  version: typeof TERMINAL_LAYOUT_VERSION;
  root: PaneLayoutNode | null;
  focusedSessionId: string | null;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPersistedTerminalLayout(
  storage: Storage | null = browserStorage(),
): PaneLayout {
  if (!storage) return emptyPaneLayout();
  const discardInvalidValue = () => {
    try {
      storage.removeItem(TERMINAL_LAYOUT_STORAGE_KEY);
    } catch {
      // Storage can become unavailable between getItem and cleanup.
    }
  };
  try {
    const encoded = storage.getItem(TERMINAL_LAYOUT_STORAGE_KEY);
    if (!encoded) return emptyPaneLayout();
    const parsed: unknown = JSON.parse(encoded);
    if (!isRecord(parsed) || parsed.version !== TERMINAL_LAYOUT_VERSION) {
      discardInvalidValue();
      return emptyPaneLayout();
    }
    const sanitized = sanitizePaneLayout(parsed);
    const explicitEmpty = parsed.root === null && parsed.focusedSessionId === null;
    if (!explicitEmpty && !sanitized.root) discardInvalidValue();
    return sanitized;
  } catch {
    discardInvalidValue();
    return emptyPaneLayout();
  }
}

export function persistTerminalLayout(
  layout: PaneLayout,
  storage: Storage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  const sanitized = sanitizePaneLayout(layout);
  const value: PersistedTerminalLayoutV1 = {
    version: TERMINAL_LAYOUT_VERSION,
    root: sanitized.root,
    focusedSessionId: sanitized.focusedSessionId,
  };
  try {
    storage.setItem(TERMINAL_LAYOUT_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    // Pane operations remain usable when WebView storage is unavailable.
    return false;
  }
}
