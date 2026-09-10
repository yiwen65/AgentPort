//! System notifications (PRD 3.4, P1). The GUI shell owns macOS native
//! notifications; the headless CLI falls back to `osascript`. Linux uses
//! `notify-send`. Delivery is best effort; the app-internal unread state is the
//! reliable channel, and permission problems surface in Settings with fix
//! instructions (failure C).

use crate::error::{CoreError, Result};
use crate::models::{AgentState, AttentionKind, StateSource, StatusEvent, UiLanguage};
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_TRACKED_NOTIFICATION_EVENTS: usize = 4096;
const APPROVAL_CROSS_SOURCE_DEDUP_WINDOW: Duration = Duration::from_secs(2);
const PTY_APPROVAL_REPEAT_WINDOW: Duration = Duration::from_secs(15);
const TERMINAL_CROSS_SOURCE_DEDUP_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct Notification {
    pub session_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy)]
struct ApprovalDedupState {
    seen_at: Instant,
    notified_at: Instant,
    notified_source: StateSource,
}

#[derive(Debug, Clone, Copy)]
struct TerminalDedupState {
    kind: AttentionKind,
    source: StateSource,
    seen_at: Instant,
}

#[derive(Default)]
pub struct NotificationDeduper {
    exact_events: HashSet<String>,
    approvals: HashMap<String, ApprovalDedupState>,
    terminals: HashMap<String, TerminalDedupState>,
}

impl NotificationDeduper {
    pub fn should_notify(&mut self, event: &StatusEvent) -> bool {
        self.should_notify_at(event, Instant::now())
    }

    fn should_notify_at(&mut self, event: &StatusEvent, now: Instant) -> bool {
        let run_key = format!(
            "{}:{}:{}",
            event.session_id, event.run_id, event.run_ordinal
        );
        // A precise new-turn/tool/approval-resolution signal separates epochs.
        // Never use PTY redraws or silence as proof of a new turn.
        if event.source != StateSource::Pty
            && matches!(event.state, AgentState::Working | AgentState::NeedsInput)
        {
            self.terminals.remove(&run_key);
            if event.state == AgentState::Working {
                self.approvals.remove(&run_key);
            }
        }
        let Some(kind) = event.attention_kind() else {
            return false;
        };
        if self.exact_events.len() >= MAX_TRACKED_NOTIFICATION_EVENTS {
            self.exact_events.clear();
        }
        let exact_key = format!(
            "{}:{}:{}:{}",
            event.session_id, event.run_id, event.run_ordinal, event.sequence
        );
        if !self.exact_events.insert(exact_key) {
            return false;
        }

        match kind {
            AttentionKind::ApprovalRequested => {
                if self.approvals.len() >= MAX_TRACKED_NOTIFICATION_EVENTS {
                    self.approvals.retain(|_, approval| {
                        now.saturating_duration_since(approval.seen_at) < PTY_APPROVAL_REPEAT_WINDOW
                    });
                    if self.approvals.len() >= MAX_TRACKED_NOTIFICATION_EVENTS {
                        self.approvals.clear();
                    }
                }
                let previous = self.approvals.get(&run_key).copied();
                let duplicate = previous.is_some_and(|approval| match event.source {
                    // Interactive prompts redraw periodically. Refreshing seen_at
                    // on every redraw keeps the whole prompt episode quiet.
                    StateSource::Pty => {
                        now.saturating_duration_since(approval.seen_at) < PTY_APPROVAL_REPEAT_WINDOW
                    }
                    // A precise hook commonly follows the first PTY match. Only
                    // coalesce it with a notification actually emitted from PTY;
                    // a later hook is a distinct permission request.
                    StateSource::Hook => {
                        approval.notified_source == StateSource::Pty
                            && now.saturating_duration_since(approval.notified_at)
                                < APPROVAL_CROSS_SOURCE_DEDUP_WINDOW
                    }
                    _ => false,
                });
                if duplicate {
                    if let Some(approval) = self.approvals.get_mut(&run_key) {
                        approval.seen_at = now;
                    }
                    false
                } else {
                    self.approvals.insert(
                        run_key,
                        ApprovalDedupState {
                            seen_at: now,
                            notified_at: now,
                            notified_source: event.source,
                        },
                    );
                    true
                }
            }
            AttentionKind::TurnCompleted | AttentionKind::ExecutionFailed => {
                if self.terminals.len() >= MAX_TRACKED_NOTIFICATION_EVENTS {
                    self.terminals.retain(|_, terminal| {
                        now.saturating_duration_since(terminal.seen_at)
                            < TERMINAL_CROSS_SOURCE_DEDUP_WINDOW
                    });
                    if self.terminals.len() >= MAX_TRACKED_NOTIFICATION_EVENTS {
                        self.terminals.clear();
                    }
                }
                let duplicate = self.terminals.get(&run_key).is_some_and(|last| {
                    last.kind == kind
                        && last.source != event.source
                        && now.saturating_duration_since(last.seen_at)
                            < TERMINAL_CROSS_SOURCE_DEDUP_WINDOW
                });
                if !duplicate {
                    self.terminals.insert(
                        run_key,
                        TerminalDedupState {
                            kind,
                            source: event.source,
                            seen_at: now,
                        },
                    );
                }
                !duplicate
            }
        }
    }
}

/// Localized payload shared by the GUI and headless diagnostic command.
pub fn test_notification(language: UiLanguage) -> Notification {
    let (title, body) = match language {
        UiLanguage::ZhCn => ("AgentPort 测试通知", "通知通道工作正常。"),
        UiLanguage::EnUs => ("AgentPort test notification", "Notifications are working."),
    };
    Notification {
        session_id: "diag".into(),
        title: title.into(),
        body: body.into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyPermission {
    Granted,
    Denied,
    Unknown,
}

pub struct Notifier {
    enabled: bool,
    language: UiLanguage,
    /// Test mode: record instead of executing OS commands.
    dry_run: bool,
    sent: Mutex<Vec<Notification>>,
}

impl Default for Notifier {
    fn default() -> Self {
        Self::new(true)
    }
}

impl Notifier {
    pub fn new(enabled: bool) -> Self {
        Notifier {
            enabled,
            language: UiLanguage::ZhCn,
            dry_run: false,
            sent: Mutex::new(vec![]),
        }
    }

    pub fn dry_run() -> Self {
        Notifier {
            enabled: true,
            language: UiLanguage::ZhCn,
            dry_run: true,
            sent: Mutex::new(vec![]),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn configure(&mut self, enabled: bool, language: UiLanguage) {
        self.enabled = enabled;
        self.language = language;
    }

    pub fn language(&self) -> UiLanguage {
        self.language
    }

    pub fn check_permission(&self) -> NotifyPermission {
        #[cfg(target_os = "macos")]
        {
            // The headless fallback has no permission-query API; a denial only
            // surfaces as a delivery error, which `send` reports.
            NotifyPermission::Unknown
        }
        #[cfg(target_os = "linux")]
        {
            // Without notify-send on PATH nothing can be delivered.
            if on_path("notify-send") {
                NotifyPermission::Unknown
            } else {
                NotifyPermission::Denied
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            NotifyPermission::Unknown
        }
    }

    /// Send; respects the enabled flag. Delivery failures come back as Err —
    /// callers log them, nothing panics. Successful sends are recorded.
    pub fn send(&self, n: Notification) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        if self.dry_run {
            self.record(n);
            return Ok(());
        }
        deliver_notification(&n)?;
        self.record(n);
        Ok(())
    }

    fn record(&self, n: Notification) {
        if let Ok(mut sent) = self.sent.lock() {
            sent.push(n);
        }
    }

    pub fn sent_count(&self) -> usize {
        self.sent.lock().map(|s| s.len()).unwrap_or(0)
    }

    pub fn sent(&self) -> Vec<Notification> {
        self.sent.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// Deliver one already-authorized notification. Preference checks belong to
/// the caller; this function is only the platform transport used by the GUI's
/// non-macOS fallback and by `Notifier`.
pub fn deliver_notification(notification: &Notification) -> Result<()> {
    deliver(notification)
}

/// Fire-and-forget platform delivery.
#[cfg(target_os = "macos")]
fn deliver(n: &Notification) -> Result<()> {
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"Glass\"",
        escape_applescript(&n.body),
        escape_applescript(&n.title)
    );
    let out = Command::new("osascript").args(["-e", &script]).output()?;
    if !out.status.success() {
        return Err(CoreError::Internal(format!(
            "osascript exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn deliver(n: &Notification) -> Result<()> {
    // argv array, no shell — title/body need no escaping.
    let out = Command::new("notify-send")
        .args([&n.title, &n.body])
        .output()?;
    if !out.status.success() {
        return Err(CoreError::Internal(format!(
            "notify-send exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn deliver(_n: &Notification) -> Result<()> {
    Err(CoreError::Internal(
        "system notifications unsupported on this platform".into(),
    ))
}

/// Escape a value for inclusion inside a double-quoted AppleScript string:
/// `\` and `"` are escaped (in that order); newlines, which cannot appear in
/// the literal, become spaces. The script itself travels as one argv element,
/// so no shell metacharacter (`$`, backtick, …) is special.
#[cfg(target_os = "macos")]
fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\n', '\r'], " ")
}

#[cfg(target_os = "linux")]
fn on_path(exe: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        std::fs::metadata(dir.join(exe))
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

/// Map a status event to a user-facing notification. The Session title is the
/// notification title and the body is a short localized status preview;
/// evidence source and confidence stay in the diagnostics/timeline surfaces.
pub fn notification_for_state_change(
    language: UiLanguage,
    session_title: &str,
    event: &StatusEvent,
) -> Option<Notification> {
    let kind = event.attention_kind()?;
    let body = if kind == AttentionKind::ExecutionFailed {
        match language {
            UiLanguage::ZhCn => "执行失败",
            UiLanguage::EnUs => "Execution failed",
        }
    } else if event.evidence.as_deref() == Some("hook:AgentPortNotification:needs_input")
        || event.evidence.as_deref() == Some("hook:AskUserQuestion")
    {
        match language {
            UiLanguage::ZhCn => "等待处理",
            UiLanguage::EnUs => "Waiting for input",
        }
    } else {
        match (language, event.state) {
            (UiLanguage::ZhCn, AgentState::NeedsInput) => "等待批准",
            (UiLanguage::ZhCn, AgentState::Idle) => "已完成",
            (UiLanguage::EnUs, AgentState::NeedsInput) => "Waiting for approval",
            (UiLanguage::EnUs, AgentState::Idle) => "Completed",
            _ => return None,
        }
    };
    Some(Notification {
        session_id: event.session_id.clone(),
        title: session_title.into(),
        body: body.into(),
    })
}

/// Map and deliver a status notification through the configured headless
/// backend. Returns true when a notification was emitted (recorded in dry-run).
/// Send failures are logged, never fatal.
pub fn notify_state_change(notifier: &Notifier, session_title: &str, event: &StatusEvent) -> bool {
    if !notifier.enabled {
        return false;
    }
    let Some(n) = notification_for_state_change(notifier.language, session_title, event) else {
        return false;
    };
    match notifier.send(n) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(error = %e, "system notification failed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Confidence, LEGACY_RUN_ID, LEGACY_RUN_ORDINAL};
    use chrono::Utc;
    use std::time::{Duration, Instant};

    fn event(
        state: AgentState,
        source: StateSource,
        confidence: Confidence,
        ev: &str,
    ) -> StatusEvent {
        StatusEvent {
            session_id: "ses_1".into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: 1,
            state,
            source,
            confidence,
            evidence: Some(ev.into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        }
    }

    #[test]
    fn dry_run_maps_state_changes() {
        let n = Notifier::dry_run();
        assert!(notify_state_change(
            &n,
            "更新部署文档",
            &event(
                AgentState::NeedsInput,
                StateSource::Hook,
                Confidence::High,
                "hook:PermissionRequest"
            )
        ));
        assert!(notify_state_change(
            &n,
            "构建前端",
            &event(
                AgentState::Idle,
                StateSource::Hook,
                Confidence::High,
                "hook:Stop"
            )
        ));
        assert!(!notify_state_change(
            &n,
            "构建前端",
            &event(
                AgentState::Exited,
                StateSource::Process,
                Confidence::High,
                "process:exit:0"
            )
        ));
        assert!(notify_state_change(
            &n,
            "跑测试",
            &event(
                AgentState::Exited,
                StateSource::Process,
                Confidence::High,
                "process:exit:1"
            )
        ));
        // Anything else never notifies.
        assert!(!notify_state_change(
            &n,
            "摸鱼",
            &event(
                AgentState::Working,
                StateSource::Hook,
                Confidence::High,
                "hook:PreToolUse"
            )
        ));
        assert!(!notify_state_change(
            &n,
            "摸鱼",
            &event(
                AgentState::Idle,
                StateSource::Pty,
                Confidence::Medium,
                "pty:silence:5000ms"
            )
        ));
        assert!(!notify_state_change(
            &n,
            "摸鱼",
            &event(
                AgentState::Unknown,
                StateSource::Adapter,
                Confidence::Low,
                "adapter:lost"
            )
        ));

        let sent = n.sent();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].title, "更新部署文档");
        assert_eq!(sent[0].body, "等待批准");
        assert_eq!(sent[0].session_id, "ses_1");
        assert_eq!(sent[1].title, "构建前端");
        assert_eq!(sent[1].body, "已完成");
        assert_eq!(sent[2].body, "执行失败");
    }

    #[test]
    fn session_end_and_process_exit_are_not_user_notifications() {
        assert!(notification_for_state_change(
            UiLanguage::ZhCn,
            "完成任务",
            &event(
                AgentState::Exited,
                StateSource::Hook,
                Confidence::High,
                "hook:SessionEnd"
            )
        )
        .is_none());
        assert!(notification_for_state_change(
            UiLanguage::ZhCn,
            "完成任务",
            &event(
                AgentState::Exited,
                StateSource::Process,
                Confidence::High,
                "process:exit:0"
            )
        )
        .is_none());
    }

    #[test]
    fn only_unexpected_process_failures_notify() {
        for (evidence, expected) in [
            ("process:exit:0", false),
            ("process:exit:1", true),
            ("process:signal:9", true),
            ("process:signal:11", true),
            ("process:signal:2", false),
            ("process:signal:15", false),
            ("process:exit:130", false),
            ("process:exit:143", false),
            ("process:exit:unknown", false),
            ("process:stopped:code=None:signal=Some(9)", false),
        ] {
            let process_exit = event(
                AgentState::Exited,
                StateSource::Process,
                Confidence::High,
                evidence,
            );
            assert_eq!(
                notification_for_state_change(UiLanguage::ZhCn, "完成任务", &process_exit)
                    .is_some(),
                expected,
                "{evidence}"
            );

            let mut deduper = NotificationDeduper::default();
            assert_eq!(deduper.should_notify(&process_exit), expected);
        }
    }

    #[test]
    fn only_approval_requests_notify_from_needs_input_events() {
        for (source, evidence) in [
            (StateSource::Hook, "hook:PermissionRequest"),
            (StateSource::Hook, "hook:AskUserQuestion"),
            (StateSource::Hook, "hook:AgentPortNotification:needs_input"),
            (StateSource::Pty, "pty:pattern:approve?"),
        ] {
            assert!(notification_for_state_change(
                UiLanguage::ZhCn,
                "等待批准",
                &event(AgentState::NeedsInput, source, Confidence::High, evidence),
            )
            .is_some());
        }

        for (source, evidence) in [
            (StateSource::Hook, "hook:Notification"),
            (StateSource::Process, "process:waiting"),
        ] {
            assert!(notification_for_state_change(
                UiLanguage::ZhCn,
                "普通输入",
                &event(AgentState::NeedsInput, source, Confidence::High, evidence),
            )
            .is_none());
        }
    }

    #[test]
    fn hook_stop_reports_single_turn_completion() {
        let notification = notification_for_state_change(
            UiLanguage::ZhCn,
            "数到 10 通知我",
            &event(
                AgentState::Idle,
                StateSource::Hook,
                Confidence::High,
                "hook:Stop",
            ),
        )
        .expect("a completed turn should notify even while the agent process stays alive");

        assert_eq!(notification.title, "数到 10 通知我");
        assert_eq!(notification.body, "已完成");
    }

    #[test]
    fn semantic_adapter_turn_end_reports_single_turn_completion() {
        for evidence in ["adapter:kimi:TurnEnd", "adapter:pi:TurnEnd"] {
            let notification = notification_for_state_change(
                UiLanguage::ZhCn,
                "语义完成",
                &event(
                    AgentState::Idle,
                    StateSource::Adapter,
                    Confidence::High,
                    evidence,
                ),
            )
            .expect("a semantic adapter turn end should notify");
            assert_eq!(notification.body, "已完成");
        }
    }

    #[test]
    fn notification_deduper_keeps_turns_and_ignores_process_exits() {
        let mut deduper = NotificationDeduper::default();
        let first_turn = event(
            AgentState::Idle,
            StateSource::Hook,
            Confidence::High,
            "hook:Stop",
        );
        let mut second_turn = first_turn.clone();
        second_turn.sequence = 2;
        let mut process_exit = event(
            AgentState::Exited,
            StateSource::Process,
            Confidence::High,
            "process:exit:0",
        );
        process_exit.sequence = 3;

        assert!(deduper.should_notify(&first_turn));
        assert!(deduper.should_notify(&second_turn));
        assert!(!deduper.should_notify(&process_exit));
        assert!(!deduper.should_notify(&first_turn));

        let mut failed_exit = process_exit.clone();
        failed_exit.sequence = 4;
        failed_exit.evidence = Some("process:exit:1".into());
        assert!(deduper.should_notify(&failed_exit));

        process_exit.run_id = "run_without_hooks".into();
        assert!(!deduper.should_notify(&process_exit));
    }

    #[test]
    fn completion_cross_source_duplicates_are_suppressed_but_next_turn_is_not() {
        let mut deduper = NotificationDeduper::default();
        let started = Instant::now();
        let hook = event(
            AgentState::Idle,
            StateSource::Hook,
            Confidence::High,
            "hook:AgentPortNotification:completed",
        );
        let mut native = event(
            AgentState::Idle,
            StateSource::Adapter,
            Confidence::High,
            "adapter:omp:TurnEnd",
        );
        native.sequence = 2;
        assert!(deduper.should_notify_at(&hook, started));
        assert!(!deduper.should_notify_at(&native, started + Duration::from_millis(100)));
        let mut work = event(
            AgentState::Working,
            StateSource::Adapter,
            Confidence::High,
            "adapter:omp:TurnStart",
        );
        work.sequence = 3;
        assert!(!deduper.should_notify_at(&work, started + Duration::from_millis(150)));
        native.sequence = 4;
        assert!(deduper.should_notify_at(&native, started + Duration::from_millis(200)));
        let mut late_hook = hook.clone();
        late_hook.sequence = 5;
        assert!(!deduper.should_notify_at(&late_hook, started + Duration::from_millis(250)));
        native.run_id = "next_run".into();
        assert!(deduper.should_notify_at(&native, started + Duration::from_millis(300)));
    }

    #[test]
    fn hook_failure_and_process_failure_are_one_attention_episode() {
        let mut deduper = NotificationDeduper::default();
        let started = Instant::now();
        let failed = event(
            AgentState::Idle,
            StateSource::Hook,
            Confidence::High,
            "hook:AgentPortNotification:failed",
        );
        let mut exited = event(
            AgentState::Exited,
            StateSource::Process,
            Confidence::High,
            "process:exit:1",
        );
        exited.sequence = 2;
        assert!(deduper.should_notify_at(&failed, started));
        assert!(!deduper.should_notify_at(&exited, started + Duration::from_millis(10)));
        assert_eq!(
            notification_for_state_change(UiLanguage::EnUs, "Build", &failed)
                .unwrap()
                .body,
            "Execution failed"
        );
    }

    #[test]
    fn precise_resolution_allows_a_second_approval_without_a_time_window() {
        let mut deduper = NotificationDeduper::default();
        let started = Instant::now();
        let first = event(
            AgentState::NeedsInput,
            StateSource::Hook,
            Confidence::High,
            "hook:AgentPortNotification:needs_input",
        );
        let mut resolved = event(
            AgentState::Working,
            StateSource::Hook,
            Confidence::High,
            "hook:AgentPortNotification:working",
        );
        resolved.sequence = 2;
        let mut second = first.clone();
        second.sequence = 3;
        assert!(deduper.should_notify_at(&first, started));
        assert!(!deduper.should_notify_at(&resolved, started));
        assert!(deduper.should_notify_at(&second, started));
        assert_eq!(
            notification_for_state_change(UiLanguage::EnUs, "Question", &first)
                .unwrap()
                .body,
            "Waiting for input"
        );
    }

    #[test]
    fn notification_deduper_coalesces_cross_source_approval_bursts() {
        let mut deduper = NotificationDeduper::default();
        let started = Instant::now();
        let pty = event(
            AgentState::NeedsInput,
            StateSource::Pty,
            Confidence::Medium,
            "pty:pattern:approve?",
        );
        let mut hook = event(
            AgentState::NeedsInput,
            StateSource::Hook,
            Confidence::High,
            "hook:PermissionRequest",
        );
        hook.sequence = 2;

        assert!(deduper.should_notify_at(&pty, started));
        assert!(!deduper.should_notify_at(&hook, started + Duration::from_millis(100)));

        let mut next_run = hook.clone();
        next_run.run_id = "run_next".into();
        assert!(deduper.should_notify_at(&next_run, started + Duration::from_millis(100)));

        hook.sequence = 3;
        assert!(deduper.should_notify_at(&hook, started + Duration::from_secs(3)));
        assert!(!deduper.should_notify_at(&hook, started + Duration::from_secs(6)));
    }

    #[test]
    fn notification_deduper_suppresses_periodic_pty_prompt_redraws() {
        let mut deduper = NotificationDeduper::default();
        let started = Instant::now();
        let mut pty = event(
            AgentState::NeedsInput,
            StateSource::Pty,
            Confidence::Medium,
            "pty:pattern:Do you want to proceed",
        );

        assert!(deduper.should_notify_at(&pty, started));
        let mut hook = event(
            AgentState::NeedsInput,
            StateSource::Hook,
            Confidence::High,
            "hook:PermissionRequest",
        );
        hook.sequence = 2;
        assert!(!deduper.should_notify_at(&hook, started + Duration::from_millis(100)));

        for (sequence, seconds) in [(3, 10), (4, 20), (5, 30)] {
            pty.sequence = sequence;
            assert!(!deduper.should_notify_at(&pty, started + Duration::from_secs(seconds)));
        }

        // A later authoritative hook represents a new approval even though the
        // PTY text is identical to the prompt that was just being redrawn.
        hook.sequence = 6;
        assert!(deduper.should_notify_at(&hook, started + Duration::from_secs(31)));
    }

    #[test]
    fn disabled_notifier_sends_and_records_nothing() {
        let n = Notifier::new(false);
        n.send(Notification {
            session_id: "s".into(),
            title: "t".into(),
            body: "b".into(),
        })
        .unwrap();
        assert_eq!(n.sent_count(), 0);
        assert!(!notify_state_change(
            &n,
            "t",
            &event(
                AgentState::NeedsInput,
                StateSource::Hook,
                Confidence::High,
                "hook:Notification"
            )
        ));
        assert_eq!(n.sent_count(), 0);
    }

    #[test]
    fn configured_language_localizes_notification_copy() {
        let mut n = Notifier::dry_run();
        n.configure(true, UiLanguage::EnUs);
        assert!(notify_state_change(
            &n,
            "Build frontend",
            &event(
                AgentState::NeedsInput,
                StateSource::Hook,
                Confidence::High,
                "hook:PermissionRequest"
            )
        ));
        let sent = n.sent();
        assert_eq!(sent[0].title, "Build frontend");
        assert_eq!(sent[0].body, "Waiting for approval");
    }

    #[test]
    fn diagnostic_notification_uses_the_configured_language() {
        let zh = test_notification(UiLanguage::ZhCn);
        let en = test_notification(UiLanguage::EnUs);
        assert_eq!(zh.title, "AgentPort 测试通知");
        assert_eq!(zh.body, "通知通道工作正常。");
        assert_eq!(en.title, "AgentPort test notification");
        assert_eq!(en.body, "Notifications are working.");
    }

    #[test]
    fn permission_check_is_best_effort() {
        let n = Notifier::dry_run();
        #[cfg(target_os = "macos")]
        assert_eq!(n.check_permission(), NotifyPermission::Unknown);
        #[cfg(target_os = "linux")]
        assert!(matches!(
            n.check_permission(),
            NotifyPermission::Unknown | NotifyPermission::Denied
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_escaping_blocks_injection() {
        // `$` needs no escaping (no shell involved); `\` and `"` do.
        assert_eq!(escape_applescript("\"$\\"), "\\\"$\\\\");
        assert_eq!(escape_applescript("line1\nline2"), "line1 line2");
        // No unescaped quote survives: a `"` must follow an odd run of `\`.
        let escaped = escape_applescript("say \"hi\" \\ then \"bye\"");
        let mut preceded_by_backslash = false;
        for c in escaped.chars() {
            if c == '"' {
                assert!(preceded_by_backslash, "unescaped quote in {escaped:?}");
            }
            preceded_by_backslash = !preceded_by_backslash && c == '\\';
        }
    }
}
