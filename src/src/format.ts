// Display helpers: Chinese labels per PRD vocabulary + formatting utils.

import type {
  AgentStateStr,
  ConfidenceStr,
  ResumePrecisionStr,
  StateSourceStr,
  WorktreeHealthStr,
} from "./types";

export function agentDisplay(adapter: string): string {
  switch (adapter) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "kimi":
      return "Kimi Code";
    case "shell":
      return "Shell";
    default:
      return adapter;
  }
}

export function stateZh(state: AgentStateStr): string {
  switch (state) {
    case "working":
      return "工作中";
    case "needs_input":
      return "等待输入";
    case "idle":
      return "空闲";
    case "exited":
      return "已退出";
    case "unknown":
      return "状态未知";
  }
}

export function sourceZh(source: StateSourceStr): string {
  switch (source) {
    case "hook":
      return "Hook";
    case "pty":
      return "PTY";
    case "process":
      return "进程";
    case "adapter":
      return "适配器";
  }
}

export function confidenceZh(c: ConfidenceStr): string {
  switch (c) {
    case "high":
      return "高置信度";
    case "medium":
      return "中置信度";
    case "low":
      return "低置信度";
  }
}

export function precisionZh(p: ResumePrecisionStr): string {
  switch (p) {
    case "exact":
      return "精确恢复（原生 Session ID）";
    case "latest":
      return "最近会话恢复";
    case "unavailable":
      return "无法自动恢复上下文";
  }
}

export function healthZh(h: WorktreeHealthStr): string {
  switch (h) {
    case "clean":
      return "clean";
    case "dirty":
      return "dirty";
    case "missing":
      return "missing";
    case "locked":
      return "locked";
  }
}

export function permissionZh(p: "native" | "auto" | "bypass"): string {
  switch (p) {
    case "native":
      return "原生审批";
    case "auto":
      return "自动批准";
    case "bypass":
      return "绕过权限";
  }
}

export function secretBackendZh(backend: string): string {
  if (backend === "macos_keychain" || backend.includes("MacosKeychain")) return "macOS Keychain";
  if (backend === "linux_secret_service" || backend.includes("LinuxSecretService"))
    return "Linux Secret Service";
  return backend;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}:${ss}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** Compact relative age for the project sidebar. */
export function relativeAge(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** Turn a task name into a branch-safe slug: "Fix Login!" -> "fix-login". */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}
