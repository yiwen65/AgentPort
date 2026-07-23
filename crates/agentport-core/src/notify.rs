//! System notifications (PRD 3.4, P1). The GUI shell owns macOS native
//! notifications; the headless CLI falls back to `osascript`. Linux uses
//! `notify-send`. Delivery is best effort; the app-internal unread state is the
//! reliable channel, and permission problems surface in Settings with fix
//! instructions (failure C).

use crate::error::{CoreError, Result};
use crate::models::{AgentState, Confidence, StateSource, StatusEvent, UiLanguage};
use std::process::Command;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct Notification {
    pub session_id: String,
    pub title: String,
    pub body: String,
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

/// Map a status event to its localized notification payload. Delivery remains
/// the caller's responsibility so the GUI can use its app-owned native backend.
pub fn notification_for_state_change(
    language: UiLanguage,
    session_title: &str,
    event: &StatusEvent,
) -> Option<Notification> {
    let ev = event.evidence.as_deref().unwrap_or("");
    let title = match (language, event.state) {
        (UiLanguage::ZhCn, AgentState::NeedsInput) => "等待输入",
        (UiLanguage::ZhCn, AgentState::Exited) if ev == "process:exit:0" => "已完成",
        (UiLanguage::ZhCn, AgentState::Exited) => "异常退出",
        (UiLanguage::EnUs, AgentState::NeedsInput) => "Needs input",
        (UiLanguage::EnUs, AgentState::Exited) if ev == "process:exit:0" => "Completed",
        (UiLanguage::EnUs, AgentState::Exited) => "Exited with an error",
        _ => return None,
    };
    let body = format!(
        "{session_title} · {} · {}",
        source_label(language, event.source),
        confidence_label(language, event.confidence)
    );
    Some(Notification {
        session_id: event.session_id.clone(),
        title: title.into(),
        body,
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

fn source_label(language: UiLanguage, source: StateSource) -> &'static str {
    match (language, source) {
        (_, StateSource::Hook) => "Hook",
        (_, StateSource::Pty) => "PTY",
        (UiLanguage::ZhCn, StateSource::Process) => "进程",
        (UiLanguage::ZhCn, StateSource::Adapter) => "适配器",
        (UiLanguage::EnUs, StateSource::Process) => "Process",
        (UiLanguage::EnUs, StateSource::Adapter) => "Adapter",
    }
}

fn confidence_label(language: UiLanguage, confidence: Confidence) -> &'static str {
    match (language, confidence) {
        (UiLanguage::ZhCn, Confidence::High) => "高置信度",
        (UiLanguage::ZhCn, Confidence::Medium) => "中置信度",
        (UiLanguage::ZhCn, Confidence::Low) => "低置信度",
        (UiLanguage::EnUs, Confidence::High) => "High confidence",
        (UiLanguage::EnUs, Confidence::Medium) => "Medium confidence",
        (UiLanguage::EnUs, Confidence::Low) => "Low confidence",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LEGACY_RUN_ID, LEGACY_RUN_ORDINAL};
    use chrono::Utc;

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
                "hook:Notification"
            )
        ));
        assert!(notify_state_change(
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
        // Signal exit is also an abnormal exit.
        assert!(notify_state_change(
            &n,
            "跑测试",
            &event(
                AgentState::Exited,
                StateSource::Process,
                Confidence::High,
                "process:signal:9"
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
        assert_eq!(sent.len(), 4);
        assert_eq!(sent[0].title, "等待输入");
        assert!(sent[0].body.contains("更新部署文档"));
        assert!(sent[0].body.contains("Hook · 高置信度"));
        assert_eq!(sent[0].session_id, "ses_1");
        assert_eq!(sent[1].title, "已完成");
        assert!(sent[1].body.contains("构建前端"));
        assert!(sent[1].body.contains("进程 · 高置信度"));
        assert_eq!(sent[2].title, "异常退出");
        assert_eq!(sent[3].title, "异常退出");
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
                StateSource::Process,
                Confidence::Medium,
                "process:waiting"
            )
        ));
        let sent = n.sent();
        assert_eq!(sent[0].title, "Needs input");
        assert_eq!(sent[0].body, "Build frontend · Process · Medium confidence");
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
