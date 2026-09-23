//! Local macOS notifications for remote-device attention events.
//!
//! Remote state events only stream over per-attachment subscriptions, so
//! background Sessions never reach the wire. The desktop therefore polls
//! `attention.poll` (frontend sync engine) and hands each fresh attention
//! item to this module, which fires a LOCAL notification through the same
//! formatting/dedup pipeline as local Sessions (`notification_for_state_change`,
//! `NotificationDeduper`, focus gating). Synthesizing the `StatusEvent` from
//! the attention kind keeps `attention_kind()` and
//! `notification_for_state_change` semantics identical to locally-observed
//! events.
//!
//! Everything here is AppHandle-free; the Tauri command wrapper lives in
//! `commands.rs`.

use agentport_core::models::{AgentState, Confidence, StateSource, StatusEvent};
use agentport_core::notify::NotificationDeduper;
use chrono::{DateTime, Utc};
use serde::Deserialize;

/// One attention item from the frontend's `attention.poll` cycle.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttentionNotificationInput {
    /// Connection gate: notifications fire only while this device is connected.
    pub device_id: String,
    /// Display name of the source device, prepended to the notification title.
    pub device_name: String,
    pub session_id: String,
    /// Resolved from the frontend's project snapshot; falls back to the id.
    pub session_title: String,
    pub run_id: String,
    pub run_ordinal: i64,
    pub sequence: i64,
    /// `approval_requested` | `turn_completed` | `execution_failed`.
    pub kind: String,
    /// RFC3339 timestamp from the attention cursor.
    pub occurred_at: String,
}

/// Freshness window mirrored from `notify_status_once`: replayed history is
/// durable/unread but never a fresh OS alert.
pub const REMOTE_ATTENTION_FRESHNESS: chrono::Duration = chrono::Duration::seconds(30);

/// Synthesize the StatusEvent that the same attention would have produced
/// locally. The (state, source, evidence) triples are chosen so
/// `StatusEvent::attention_kind()` returns the polled kind and
/// `notification_for_state_change` yields its usual body text. Unknown future
/// kinds are ignored (forward-compatible) instead of misfiring.
pub fn synthesize_attention_event(input: &RemoteAttentionNotificationInput) -> Option<StatusEvent> {
    let (state, evidence) = match input.kind.as_str() {
        "approval_requested" => (
            AgentState::NeedsInput,
            "hook:AgentPortNotification:needs_input",
        ),
        "turn_completed" => (AgentState::Idle, "hook:AgentPortNotification:completed"),
        "execution_failed" => (AgentState::Idle, "hook:AgentPortNotification:failed"),
        _ => return None,
    };
    let occurred_at = DateTime::parse_from_rfc3339(&input.occurred_at)
        .ok()?
        .with_timezone(&Utc);
    Some(StatusEvent {
        session_id: input.session_id.clone(),
        run_id: input.run_id.clone(),
        run_ordinal: input.run_ordinal,
        sequence: input.sequence,
        state,
        source: StateSource::Hook,
        confidence: Confidence::High,
        evidence: Some(evidence.to_string()),
        log_cursor: None,
        occurred_at,
    })
}

/// Gate shared by the command wrapper: the event must carry an actionable
/// attention kind, be fresh, and survive the SAME deduper local events use
/// (exact session/run/ordinal/sequence identity plus approval/terminal
/// windows). Distinct remote Session ids keep remote/local baselines apart.
pub fn attention_notify_allowed(
    deduper: &mut NotificationDeduper,
    notifier_enabled: bool,
    event: &StatusEvent,
    now: DateTime<Utc>,
) -> bool {
    if event.attention_kind().is_none() {
        return false;
    }
    if !notifier_enabled {
        return false;
    }
    if now.signed_duration_since(event.occurred_at) > REMOTE_ATTENTION_FRESHNESS {
        return false;
    }
    deduper.should_notify(event)
}

/// Notification title with an explicit source-device prefix.
pub fn attention_notification_title(input: &RemoteAttentionNotificationInput) -> String {
    format!("[{}] {}", input.device_name, input.session_title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: &str) -> RemoteAttentionNotificationInput {
        RemoteAttentionNotificationInput {
            device_id: "dev-1".into(),
            device_name: "buildbox".into(),
            session_id: "ses_remote".into(),
            session_title: "Refactor".into(),
            run_id: "run-1".into(),
            run_ordinal: 2,
            sequence: 7,
            kind: kind.into(),
            occurred_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn synthesizes_each_known_kind_with_matching_attention() {
        use agentport_core::models::AttentionKind;
        let cases = [
            (
                "approval_requested",
                AgentState::NeedsInput,
                AttentionKind::ApprovalRequested,
            ),
            (
                "turn_completed",
                AgentState::Idle,
                AttentionKind::TurnCompleted,
            ),
            (
                "execution_failed",
                AgentState::Idle,
                AttentionKind::ExecutionFailed,
            ),
        ];
        for (kind, state, attention) in cases {
            let event = synthesize_attention_event(&input(kind)).expect(kind);
            assert_eq!(event.state, state);
            assert_eq!(event.source, StateSource::Hook);
            assert_eq!(event.attention_kind(), Some(attention));
            assert_eq!(event.session_id, "ses_remote");
            assert_eq!(event.run_ordinal, 2);
            assert_eq!(event.sequence, 7);
        }
    }

    #[test]
    fn unknown_kind_and_bad_timestamp_are_ignored() {
        assert!(synthesize_attention_event(&input("future_kind")).is_none());
        let mut broken = input("turn_completed");
        broken.occurred_at = "not-a-date".into();
        assert!(synthesize_attention_event(&broken).is_none());
    }

    #[test]
    fn stale_events_are_not_fresh_alerts() {
        let mut stale = input("turn_completed");
        stale.occurred_at = (Utc::now() - chrono::Duration::seconds(31)).to_rfc3339();
        let event = synthesize_attention_event(&stale).unwrap();
        let mut deduper = NotificationDeduper::default();
        assert!(!attention_notify_allowed(
            &mut deduper,
            true,
            &event,
            Utc::now()
        ));
    }

    #[test]
    fn disabled_notifier_and_dedup_both_block() {
        let event = synthesize_attention_event(&input("turn_completed")).unwrap();
        let mut deduper = NotificationDeduper::default();
        assert!(!attention_notify_allowed(
            &mut deduper,
            false,
            &event,
            Utc::now()
        ));
        assert!(attention_notify_allowed(
            &mut deduper,
            true,
            &event,
            Utc::now()
        ));
        // Identical re-poll of the same attention item is deduplicated.
        assert!(!attention_notify_allowed(
            &mut deduper,
            true,
            &event,
            Utc::now()
        ));
    }

    #[test]
    fn title_carries_the_device_prefix() {
        assert_eq!(
            attention_notification_title(&input("turn_completed")),
            "[buildbox] Refactor"
        );
    }
}
