// Central UI state. A single observable store read via useSyncExternalStore;
// xterm instances themselves live outside React in terminals.ts (they are
// imperative, non-serializable and must survive tab switches).

import { useSyncExternalStore } from "react";
import type {
  AdapterInstall,
  PlatformInfo,
  ProjectView,
  SessionView,
  Settings,
  StatusEventView,
  TimelineData,
  WorktreeStatus,
} from "./types";

export interface SessionRuntime {
  attached: boolean;
  attaching: boolean;
  replayDone: boolean;
  detached: boolean;
  status: StatusEventView | null;
  logBytes: number;
  exit: { code: number | null; signal: number | null; groupCleaned: boolean } | null;
  error: string | null;
  hostPid: number | null;
  scrolledUp: boolean;
  /** Set when the read-only history terminal shows a truncated log tail. */
  historyNote: string | null;
}

export function emptyRuntime(): SessionRuntime {
  return {
    attached: false,
    attaching: false,
    replayDone: false,
    detached: false,
    status: null,
    logBytes: 0,
    exit: null,
    error: null,
    hostPid: null,
    scrolledUp: false,
    historyNote: null,
  };
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  tip?: string;
  separator?: boolean;
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
}

export interface PromptState extends PromptOptions {
  resolve: (v: string | null) => void;
}

export type DialogState =
  | { kind: "newSession"; projectId?: string; worktreeId?: string; agent?: string }
  | { kind: "newWorktree"; projectId: string }
  | { kind: "settings" }
  | { kind: "diagnostics" }
  | { kind: "timeline" }
  | { kind: "palette" }
  | { kind: "search" }
  | { kind: "addProject" }
  | { kind: "export"; sessionId: string; exportKind: "md" | "log" }
  | null;

export type EffectiveTheme = "dark" | "light";

export interface AppState {
  ready: boolean;
  bootError: string | null;
  platform: PlatformInfo | null;
  settings: Settings | null;
  adapters: AdapterInstall[];
  projects: ProjectView[];
  timeline: TimelineData;
  secretBackend: string;
  indexState: string;
  activeSessionId: string | null;
  /** Sessions with a live terminal pane (kept mounted, display:none toggling). */
  attachedIds: string[];
  runtime: Record<string, SessionRuntime>;
  rendererMode: "canvas" | "dom";
  rendererFallbackReason: string | null;
  dialog: DialogState;
  confirm: ConfirmState | null;
  prompt: PromptState | null;
  contextMenu: ContextMenuState | null;
  toasts: Toast[];
  showOnboarding: boolean;
  expandedProjects: Record<string, boolean>;
  activeWorktreeStatus: WorktreeStatus | null;
  /** Dismissed "结果尚未提交" notices (sessionId -> status sequence). */
  noticeDismissed: Record<string, number>;
  announcement: string;
  themeEffective: EffectiveTheme;
  reducedMotion: boolean;
  /** Whether the project/session sidebar is hidden for terminal focus. */
  sidebarCollapsed: boolean;
  /** Ephemeral width of the project/session split view in CSS pixels. */
  sidebarWidth: number;
  /** Session IDs mapped to their pin timestamp for this app run. */
  pinnedSessionAt: Record<string, number>;
  /** Terminal search bar visibility for the active session. */
  termSearchOpen: boolean;
}

const initialState: AppState = {
  ready: false,
  bootError: null,
  platform: null,
  settings: null,
  adapters: [],
  projects: [],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [] },
  secretBackend: "unknown",
  indexState: "unknown",
  activeSessionId: null,
  attachedIds: [],
  runtime: {},
  rendererMode: "canvas",
  rendererFallbackReason: null,
  dialog: null,
  confirm: null,
  prompt: null,
  contextMenu: null,
  toasts: [],
  showOnboarding: false,
  expandedProjects: {},
  activeWorktreeStatus: null,
  noticeDismissed: {},
  announcement: "",
  themeEffective: "dark",
  reducedMotion: false,
  sidebarCollapsed: false,
  sidebarWidth: 296,
  pinnedSessionAt: {},
  termSearchOpen: false,
};

let state = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  emit();
}

export function update(fn: (s: AppState) => Partial<AppState>) {
  setState(fn(state));
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

// ---------------------------------------------------------------------------
// convenience helpers used across components
// ---------------------------------------------------------------------------

let toastSeq = 1;

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = toastSeq++;
  update((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  window.setTimeout(() => {
    update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, 5200);
}

export function announce(text: string) {
  setState({ announcement: text });
}

export function openDialog(dialog: DialogState) {
  setState({ dialog, contextMenu: null });
}

export function closeDialog() {
  setState({ dialog: null });
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setState({ confirm: { ...opts, resolve } });
  });
}

export function resolveConfirm(ok: boolean) {
  const c = state.confirm;
  setState({ confirm: null });
  c?.resolve(ok);
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    setState({ prompt: { ...opts, resolve } });
  });
}

export function resolvePrompt(value: string | null) {
  const p = state.prompt;
  setState({ prompt: null });
  p?.resolve(value);
}

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  setState({ contextMenu: { x, y, items } });
}

export function closeContextMenu() {
  if (state.contextMenu) setState({ contextMenu: null });
}

export function patchRuntime(sessionId: string, patch: Partial<SessionRuntime>) {
  update((s) => ({
    runtime: {
      ...s.runtime,
      [sessionId]: { ...emptyRuntime(), ...s.runtime[sessionId], ...patch },
    },
  }));
}

export function getRuntime(sessionId: string): SessionRuntime {
  return { ...emptyRuntime(), ...state.runtime[sessionId] };
}

/** Patch one session inside the project tree (keeps unread/ordering intact). */
export function patchSession(sessionId: string, patch: Partial<SessionView>) {
  update((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      sessions: p.sessions.map((ses) => (ses.id === sessionId ? { ...ses, ...patch } : ses)),
    })),
  }));
}

/** All sessions in sidebar display order — drives ⌘1…9 switching. */
export function flattenSessions(projects: ProjectView[]): SessionView[] {
  const out: SessionView[] = [];
  for (const p of projects) {
    for (const ses of p.sessions) {
      if (!ses.worktreeId) out.push(ses);
    }
    for (const w of p.worktrees) {
      for (const ses of p.sessions) {
        if (ses.worktreeId === w.id) out.push(ses);
      }
    }
  }
  return out;
}

export function findSession(projects: ProjectView[], sessionId: string | null): SessionView | null {
  if (!sessionId) return null;
  for (const p of projects) {
    const hit = p.sessions.find((s) => s.id === sessionId);
    if (hit) return hit;
  }
  return null;
}

export function findProjectOf(projects: ProjectView[], sessionId: string | null) {
  if (!sessionId) return null;
  return projects.find((p) => p.sessions.some((s) => s.id === sessionId)) ?? null;
}
