// Locale-aware display labels and formatting utilities.

import type {
  AgentStateStr,
  ConfidenceStr,
  ResumePrecisionStr,
  StateSourceStr,
  WorktreeHealthStr,
  Preset,
  AdapterInstall,
  RepositoryOperationProgress,
} from "./types";
import { currentUiLanguage, i18n } from "./i18n";

export function agentDisplay(adapter: string): string {
  switch (adapter) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "kimi":
      return "Kimi Code";
    case "qoder":
      return "Qoder";
    case "pi":
      return "Pi";
    case "shell":
      return "Shell";
    default:
      return adapter;
  }
}

export function presetDisplayName(preset: Pick<Preset, "id" | "name" | "builtIn">): string {
  if (!preset.builtIn) return preset.name;
  switch (preset.id) {
    case "pre_claude_safe":
      return i18n.t("session:builtInPreset.pre_claude_safe");
    case "pre_codex_safe":
      return i18n.t("session:builtInPreset.pre_codex_safe");
    case "pre_kimi_safe":
      return i18n.t("session:builtInPreset.pre_kimi_safe");
    case "pre_qoder_safe":
      return i18n.t("session:builtInPreset.pre_qoder_safe");
    case "pre_pi_safe":
      return i18n.t("session:builtInPreset.pre_pi_safe");
    case "pre_shell_safe":
      return i18n.t("session:builtInPreset.pre_shell_safe");
    default:
      return preset.name;
  }
}

export function stateLabel(state: AgentStateStr): string {
  switch (state) {
    case "working":
      return i18n.t("session:state.working");
    case "needs_input":
      return i18n.t("session:state.needsInput");
    case "idle":
      return i18n.t("session:state.idle");
    case "exited":
      return i18n.t("session:state.exited");
    case "unknown":
      return i18n.t("session:state.unknown");
  }
}

export function sourceLabel(source: StateSourceStr): string {
  switch (source) {
    case "hook":
      return i18n.t("session:source.hook");
    case "pty":
      return i18n.t("session:source.pty");
    case "process":
      return i18n.t("session:source.process");
    case "adapter":
      return i18n.t("session:source.adapter");
  }
}

export function confidenceLabel(c: ConfidenceStr): string {
  switch (c) {
    case "high":
      return i18n.t("session:confidence.high");
    case "medium":
      return i18n.t("session:confidence.medium");
    case "low":
      return i18n.t("session:confidence.low");
  }
}

export function precisionLabel(p: ResumePrecisionStr): string {
  switch (p) {
    case "exact":
      return i18n.t("session:precision.exact");
    case "latest":
      return i18n.t("session:precision.latest");
    case "unavailable":
      return i18n.t("session:precision.unavailable");
  }
}

export function healthLabel(h: WorktreeHealthStr): string {
  switch (h) {
    case "clean":
      return i18n.t("worktree:health.clean");
    case "dirty":
      return i18n.t("worktree:health.dirty");
    case "missing":
      return i18n.t("worktree:health.missing");
    case "locked":
      return i18n.t("worktree:health.locked");
  }
}

export function permissionLabel(p: "native" | "auto" | "bypass"): string {
  switch (p) {
    case "native":
      return i18n.t("session:permission.native");
    case "auto":
      return i18n.t("session:permission.auto");
    case "bypass":
      return i18n.t("session:permission.bypass");
  }
}

export function hookStatusLabel(status: AdapterInstall["hookStatus"]): string {
  switch (status) {
    case "supported":
      return i18n.t("common:hookStatus.supported");
    case "degraded":
      return i18n.t("common:hookStatus.degraded");
    case "unavailable":
      return i18n.t("common:hookStatus.unavailable");
  }
}

export function probeSourceLabel(source: string): string {
  switch (source) {
    case "system_path":
      return i18n.t("common:probeSource.systemPath");
    case "login_shell_path":
      return i18n.t("common:probeSource.loginShellPath");
    case "version_manager":
      return i18n.t("common:probeSource.versionManager");
    case "well_known_dir":
      return i18n.t("common:probeSource.wellKnownDirectory");
    case "manual":
      return i18n.t("common:probeSource.manual");
    default:
      return source;
  }
}

export function branchOperationPhaseLabel(phase: string): string {
  switch (phase) {
    case "started":
      return i18n.t("worktree:ui.branchPicker.progress.phase.started");
    case "prepared":
      return i18n.t("worktree:ui.branchPicker.progress.phase.prepared");
    case "stashed":
      return i18n.t("worktree:ui.branchPicker.progress.phase.stashed");
    case "switched":
      return i18n.t("worktree:ui.branchPicker.progress.phase.switched");
    case "applying":
      return i18n.t("worktree:ui.branchPicker.progress.phase.applying");
    case "restored_verified":
      return i18n.t("worktree:ui.branchPicker.progress.phase.restoredVerified");
    case "cleaning":
      return i18n.t("worktree:ui.branchPicker.progress.phase.cleaning");
    case "completed":
      return i18n.t("worktree:ui.branchPicker.progress.phase.completed");
    case "pending_restore":
    case "recovery_required":
      return i18n.t("worktree:ui.branchPicker.progress.phase.recoveryRequired");
    case "failed":
      return i18n.t("worktree:ui.branchPicker.progress.phase.failed");
    default:
      return i18n.t("worktree:ui.branchPicker.progress.phase.unknown", { phase });
  }
}

export function repositoryProgressMessage(
  progress: Pick<RepositoryOperationProgress, "command" | "phase" | "message">,
): string {
  if (progress.phase === "failed") {
    if ([
      "create_local_branch",
      "create_and_switch_local_branch",
      "delete_local_branch",
      "switch_local_branch",
    ].includes(progress.command)) {
      return i18n.t("worktree:ui.branchPicker.progress.message.branchOperationFailed");
    }
    return i18n.t("worktree:ui.branchPicker.progress.message.failed", {
      detail: progress.message,
    });
  }
  switch (`${progress.command}:${progress.phase}`) {
    case "create_local_branch:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.createStarted");
    case "create_local_branch:completed":
      return i18n.t("worktree:ui.branchPicker.progress.message.createCompleted");
    case "create_and_switch_local_branch:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.createAndSwitchStarted");
    case "create_and_switch_local_branch:completed":
      return i18n.t("worktree:ui.branchPicker.progress.message.createAndSwitchCompleted");
    case "create_and_switch_local_branch:pending_restore":
      return i18n.t("worktree:ui.branchPicker.progress.message.switchPendingRestore");
    case "delete_local_branch:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.deleteStarted");
    case "delete_local_branch:completed":
      return i18n.t("worktree:ui.branchPicker.progress.message.deleteCompleted");
    case "switch_local_branch:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.switchStarted");
    case "switch_local_branch:pending_restore":
      return i18n.t("worktree:ui.branchPicker.progress.message.switchPendingRestore");
    case "switch_local_branch:completed":
      return i18n.t("worktree:ui.branchPicker.progress.message.switchCompleted");
    case "restore_auto_stash:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.restoreStarted");
    case "cleanup_auto_stash:started":
      return i18n.t("worktree:ui.branchPicker.progress.message.cleanupStarted");
    case "cleanup_auto_stash:completed":
      return i18n.t("worktree:ui.branchPicker.progress.message.cleanupCompleted");
    default:
      if (progress.command === "restore_auto_stash") {
        return i18n.t("worktree:ui.branchPicker.progress.message.restoreFinished");
      }
      return i18n.t("worktree:ui.branchPicker.progress.message.unknown", {
        command: progress.command,
        phase: progress.phase,
      });
  }
}

/** Localize stable recovery action IDs while continuing to display the
 * human-readable strings returned by older Tauri backends. */
export function recoveryActionLabel(action: string): string {
  const known = {
    check_diagnostics_and_retry: "worktree:ui.branchPicker.error.recoveryAction.checkDiagnosticsAndRetry",
    refresh_and_choose_available_branch: "worktree:ui.branchPicker.error.recoveryAction.refreshAndChooseAvailableBranch",
    refresh_and_reselect_branch: "worktree:ui.branchPicker.error.recoveryAction.refreshAndReselectBranch",
    resolve_repository_blockers: "worktree:ui.branchPicker.error.recoveryAction.resolveRepositoryBlockers",
    inspect_retained_auto_stash: "worktree:ui.branchPicker.error.recoveryAction.inspectRetainedAutoStash",
    restore_when_checkout_safe: "worktree:ui.branchPicker.error.recoveryAction.restoreWhenCheckoutSafe",
    choose_nonconflicting_action: "worktree:ui.branchPicker.error.recoveryAction.chooseNonconflictingAction",
    refresh_repository_before_retry: "worktree:ui.branchPicker.error.recoveryAction.refreshRepositoryBeforeRetry",
    inspect_diagnostics_if_git_unavailable: "worktree:ui.branchPicker.error.recoveryAction.inspectDiagnosticsIfGitUnavailable",
    refresh_repository_and_retry: "worktree:ui.branchPicker.error.recoveryAction.refreshRepositoryAndRetry",
    retry_after_checking_diagnostics: "worktree:ui.branchPicker.error.recoveryAction.retryAfterCheckingDiagnostics",
    force_delete_branch: "worktree:ui.branchPicker.error.recoveryAction.forceDeleteBranch",
  } as const;
  const stableAction = action as keyof typeof known;
  const key = known[stableAction];
  return key
    ? i18n.t(key)
    : action;
}

export function secretBackendZh(backend: string): string {
  if (backend === "macos_keychain" || backend.includes("MacosKeychain")) return "macOS Keychain";
  if (backend === "linux_secret_service" || backend.includes("LinuxSecretService"))
    return "Linux Secret Service";
  return backend;
}

export function formatBytes(n: number): string {
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat(currentUiLanguage(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (n < 1024) return `${format(n, 0)} B`;
  if (n < 1024 * 1024) return `${format(n / 1024, 1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${format(n / (1024 * 1024), 1)} MiB`;
  return `${format(n / (1024 * 1024 * 1024), 2)} GiB`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(currentUiLanguage(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** Recovery events that cross midnight need local calendar and timezone
 * context; otherwise a remote Host's UTC source time is too easy to misread. */
export function formatTimelineTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const language = currentUiLanguage();
  const time = new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  if (d.toDateString() === now.toDateString()) return time;
  const dateTime = new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || i18n.t("common:time.localZone");
  return language === "zh-CN" ? `${dateTime}（${zone}）` : `${dateTime} (${zone})`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(currentUiLanguage(), {
    month: sameDay ? undefined : "numeric",
    day: sameDay ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** Compact relative age for the project sidebar. */
export function relativeAge(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
