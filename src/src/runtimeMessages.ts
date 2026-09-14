import { i18n } from "./i18n";
import { formatBytes } from "./format";
import type { RuntimeMessageEnvelope, RuntimeMessageParams } from "./types";

/** Preserve a structured Tauri rejection so already-rendered errors can be
 * localized again when the user changes languages. Git command errors use a
 * different shape and are deliberately excluded by the params/detail guard. */
export function runtimeMessageEnvelope(value: unknown): RuntimeMessageEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== "string" ||
    !("technicalDetail" in record || "params" in record)
  ) return null;
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
    ? record.params as RuntimeMessageParams
    : undefined;
  return {
    code: record.code,
    params,
    technicalDetail: typeof record.technicalDetail === "string"
      ? record.technicalDetail
      : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

/**
 * Resolve application-owned runtime messages locally while retaining support
 * for old Hosts that only send a human-readable `message` string.
 */
export function runtimeMessageText(envelope: RuntimeMessageEnvelope): string {
  const detail = envelope.technicalDetail?.trim() || envelope.message?.trim() || "";
  const agent = String(envelope.params?.agent ?? "Agent");
  const count = Number(envelope.params?.count ?? 0);
  const path = String(envelope.params?.path ?? "");
  switch (envelope.code) {
    case "document_path_relative":
      return i18n.t("runtime:errors.documentPathRelative", { path });
    case "document_not_found":
      return i18n.t("runtime:errors.documentNotFound", { path });
    case "document_not_file":
      return i18n.t("runtime:errors.documentNotFile", { path });
    case "document_read_failed":
      return i18n.t("runtime:errors.documentReadFailed", { detail });
    case "document_binary":
      return i18n.t("runtime:errors.documentBinary", { path });
    case "document_too_large":
      return i18n.t("runtime:errors.documentTooLarge", { path });
    case "document_write_failed":
      return i18n.t("runtime:errors.documentWriteFailed", { detail });
    case "document_not_directory":
      return i18n.t("runtime:errors.documentNotDirectory", { path });
    case "document_entry_exists":
      return i18n.t("runtime:errors.documentEntryExists", { path });
    case "document_create_failed":
      return i18n.t("runtime:errors.documentCreateFailed", { detail });
    case "watch_database_open_failed":
      return i18n.t("runtime:errors.watchDatabaseOpenFailed", { detail });
    case "status_persistence_failed":
      return i18n.t("runtime:errors.statusPersistenceFailed", { detail });
    case "agent_session_persistence_failed":
      return i18n.t("runtime:errors.agentSessionPersistenceFailed", { detail });
    case "host_replaced":
      return i18n.t("runtime:errors.hostReplaced");
    case "host_connection_failed":
      return i18n.t("runtime:errors.host.connectionFailed", { detail });
    case "host_changed_during_attach":
      return i18n.t("runtime:errors.host.changedDuringAttach");
    case "timeline_load_failed":
      return i18n.t("session:flow.timelineLoadFailed", { detail });
    case "probe_executable_not_found":
      return i18n.t("runtime:messages.probe.executableNotFound");
    case "probe_failed":
      return i18n.t("runtime:messages.probe.failed", { detail });
    case "probe_auto_selected":
      return i18n.t("runtime:messages.probe.autoSelected", { count });
    case "probe_candidates_failed":
      return i18n.t("runtime:messages.probe.candidatesFailed", { count, detail });
    case "hook_settings_unavailable":
      return i18n.t("runtime:messages.adapter.hookSettingsUnavailable", { agent });
    case "kimi_hook_unavailable":
      return i18n.t("runtime:messages.adapter.kimiHookUnavailable");
    case "codex_hook_unverified":
      return i18n.t("runtime:messages.adapter.codexHookUnverified");
    case "codex_session_id_unverified":
      return i18n.t("runtime:messages.adapter.codexSessionIdUnverified");
    case "codex_resume_id_unavailable":
      return i18n.t("runtime:messages.adapter.codexResumeIdUnavailable");
    case "native_session_id_unavailable":
      return i18n.t("runtime:messages.adapter.nativeSessionIdUnavailable", { agent });
    case "resume_latest_only":
      return i18n.t("runtime:messages.adapter.resumeLatestOnly");
    case "pi_local_permissions":
      return i18n.t("runtime:messages.adapter.piLocalPermissions");
    case "claude_conversation_missing":
      return i18n.t("runtime:messages.adapter.claudeConversationMissing");
    case "shell_resume_unavailable":
      return i18n.t("runtime:messages.adapter.shellResumeUnavailable");
    case "extended_hooks_degraded":
      return i18n.t("runtime:messages.adapter.extendedHooksDegraded", { agent });
    case "extended_resume_unavailable":
      return i18n.t("runtime:messages.adapter.extendedResumeUnavailable");
    case "amp_native_no_approval":
      return i18n.t("runtime:messages.adapter.ampNativeNoApproval");
    case "cline_native_auto_approve":
      return i18n.t("runtime:messages.adapter.clineNativeAutoApprove");
    case "omp_native_permission_defaults":
      return i18n.t("runtime:messages.adapter.ompNativePermissionDefaults");
    case "easy_pi_native_permission_defaults":
      return i18n.t("runtime:messages.adapter.easyPiNativePermissionDefaults");
    case "notification_setup_degraded":
      return i18n.t("runtime:messages.adapter.notificationSetupDegraded", { detail });
    case "adapter_notice":
      return i18n.t("runtime:messages.adapter.generic", { detail });
    case "terminal_history_tail":
      return i18n.t("session:terminal.historyTail", {
        shown: formatBytes(Number(envelope.params?.shown ?? 0)),
        total: formatBytes(Number(envelope.params?.total ?? 0)),
      });
    case "terminal_log_read_failed":
      return i18n.t("session:terminal.logReadFailed", { detail });
    case "terminal_resynced":
      return i18n.t("session:terminal.resynced", {
        reason: String(envelope.params?.reason ?? detail),
      });
    case "terminal_output_gap":
      return i18n.t("session:terminal.outputGap");
    case "host_status_journal_failed":
      return i18n.t("runtime:errors.host.statusJournalFailed");
    case "host_output_log_failed":
      return i18n.t("runtime:errors.host.outputLogFailed");
    case "host_session_id_mismatch":
      return i18n.t("runtime:errors.host.sessionIdMismatch");
    case "host_terminal_input_unavailable":
      return i18n.t("runtime:errors.host.terminalInputUnavailable");
    case "host_structured_prompt_transport_required":
      return i18n.t("runtime:errors.host.structuredPromptTransportRequired");
    case "host_structured_prompt_empty":
      return i18n.t("runtime:errors.host.structuredPromptEmpty");
    case "host_structured_abort_transport_required":
      return i18n.t("runtime:errors.host.structuredAbortTransportRequired");
    case "host_duplicate_hello":
      return i18n.t("runtime:errors.host.duplicateHello");
    case "host_handshake_rejected":
      return i18n.t("runtime:errors.host.handshakeRejected");
    case "host_error":
      return i18n.t("runtime:errors.host.generic", { detail });
    case "project_path_missing":
      return i18n.t("runtime:errors.projectPathMissing", {
        path: String(envelope.params?.path ?? ""),
      });
    case "file_manager_failed":
      return i18n.t("runtime:errors.fileManagerFailed", { detail });
    default:
      // A legacy or newer Host may not share this renderer's code catalog.
      // Prefer its compatible display text, then raw diagnostic detail, and
      // finally a safe localized fallback that exposes only the stable code.
      if (envelope.code) {
        return i18n.t("runtime:errors.unknownCode", { code: envelope.code });
      }
      if (envelope.message?.trim()) return envelope.message.trim();
      if (envelope.technicalDetail?.trim()) return envelope.technicalDetail.trim();
      return i18n.t("runtime:errors.unknown");
  }
}

/** Prefer stable notices from a current backend, but keep old binaries usable. */
export function localizedNotices(result: {
  notices?: RuntimeMessageEnvelope[];
  notes?: string[];
}): string[] {
  if (result.notices && result.notices.length > 0) {
    return result.notices.map(runtimeMessageText);
  }
  return result.notes ?? [];
}
