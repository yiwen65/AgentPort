//! Delivery policy only. Suppression never changes durable history or read cursors.
use crate::models::{AgentState, AttentionKind, StatusEvent};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const DELIVERY_DELAY: Duration = Duration::from_secs(1);
const MAX_PENDING: usize = 64;

/// Per-connection snapshot fence, independent of the process-local deduper.
/// A legacy Host's first requested status is a snapshot, not a new transition.
pub struct NotificationWatermark {
    sequence: i64,
    awaiting_snapshot: bool,
}
impl NotificationWatermark {
    pub fn new(snapshot: Option<&StatusEvent>, legacy: bool) -> Self {
        Self {
            sequence: snapshot.map_or(0, |event| event.sequence),
            awaiting_snapshot: legacy && snapshot.is_none(),
        }
    }
    pub fn accept(&mut self, sequence: i64) -> bool {
        let live = !self.awaiting_snapshot && sequence > self.sequence;
        self.awaiting_snapshot = false;
        self.sequence = self.sequence.max(sequence);
        live
    }
}

#[derive(Default)]
pub struct PendingNotifications {
    pending: VecDeque<(Instant, StatusEvent)>,
}

impl PendingNotifications {
    pub fn push(&mut self, event: StatusEvent, now: Instant) {
        if self.pending.iter().any(|(_, previous)| {
            previous.session_id == event.session_id && previous.run_ordinal > event.run_ordinal
        }) {
            return;
        }
        // Replace the same episode/kind, not an independent failure. The exact
        // and cross-source deduper runs before this presentation-only queue.
        self.pending.retain(|(_, previous)| {
            previous.session_id != event.session_id
                || (previous.run_id == event.run_id
                    && previous.run_ordinal == event.run_ordinal
                    && previous.attention_kind() != event.attention_kind())
        });
        if self.pending.len() >= MAX_PENDING {
            self.pending.pop_front();
        }
        self.pending.push_back((now + DELIVERY_DELAY, event));
    }

    pub fn take_due(&mut self, now: Instant) -> Vec<StatusEvent> {
        let mut due = Vec::new();
        while self
            .pending
            .front()
            .is_some_and(|(deadline, _)| *deadline <= now)
        {
            if let Some((_, event)) = self.pending.pop_front() {
                due.push(event);
            }
        }
        due
    }
}

pub fn is_focused_target(
    event: &StatusEvent,
    selected_session: Option<&str>,
    window_focused: bool,
) -> bool {
    window_focused && selected_session == Some(event.session_id.as_str())
}

/// A current snapshot is required, even with zero remaining delay. Failures
/// describe something that happened; recovery does not erase them. Completion
/// and requests instead expire when superseded by a different effective state.
pub fn is_current(event: &StatusEvent, latest: Option<&StatusEvent>) -> bool {
    let Some(latest) = latest else { return false };
    if event.session_id != latest.session_id
        || event.run_id != latest.run_id
        || event.run_ordinal != latest.run_ordinal
        || latest.sequence < event.sequence
    {
        return false;
    }
    match event.attention_kind() {
        // A later cross-source observation can strengthen the same episode.
        // Requiring identical sequence would discard both after deduplication.
        Some(AttentionKind::ApprovalRequested) => latest.state == AgentState::NeedsInput,
        Some(AttentionKind::TurnCompleted) => {
            latest.state == AgentState::Idle
                && latest.attention_kind() == Some(AttentionKind::TurnCompleted)
        }
        Some(AttentionKind::ExecutionFailed) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NotificationEvent, Observation, StateMachine};

    #[test]
    fn resolved_requests_and_restarted_runs_expire_but_failures_survive_recovery() {
        let mut sm = StateMachine::for_run("s", "r", 1);
        let request = sm
            .observe(Observation::Notification(NotificationEvent::NeedsInput))
            .unwrap();
        assert!(is_focused_target(&request, Some("s"), true));
        assert!(!is_focused_target(&request, Some("other"), true));
        assert!(!is_focused_target(&request, Some("s"), false));
        assert!(!is_focused_target(&request, None, true));
        assert!(is_current(&request, Some(&request)));
        let mut strengthened = request.clone();
        strengthened.sequence += 1;
        assert!(is_current(&request, Some(&strengthened)));
        let work = sm
            .observe(Observation::Notification(NotificationEvent::Working))
            .unwrap();
        assert!(!is_current(&request, Some(&work)));
        let completed = sm
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        assert!(is_current(&completed, Some(&completed)));
        let work = sm
            .observe(Observation::Notification(NotificationEvent::Working))
            .unwrap();
        assert!(!is_current(&completed, Some(&work)));
        let failed = sm
            .observe(Observation::Notification(NotificationEvent::Failed))
            .unwrap();
        let work = sm
            .observe(Observation::Notification(NotificationEvent::Working))
            .unwrap();
        assert!(is_current(&failed, Some(&work)));
        let mut restarted = work.clone();
        restarted.run_id = "new-run".into();
        restarted.run_ordinal += 1;
        assert!(!is_current(&failed, Some(&restarted)));
        assert!(!is_current(&failed, None));
    }

    #[test]
    fn reconnect_snapshots_do_not_replay_notifications() {
        let mut sm = StateMachine::new("s");
        let snapshot = sm
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        let mut fence = NotificationWatermark::new(Some(&snapshot), false);
        assert!(!fence.accept(snapshot.sequence));
        assert!(fence.accept(snapshot.sequence + 1));
        assert!(!fence.accept(snapshot.sequence));
        let mut legacy = NotificationWatermark::new(None, true);
        assert!(!legacy.accept(100));
        assert!(legacy.accept(101));
        assert!(NotificationWatermark::new(None, false).accept(1));
    }

    #[test]
    fn late_old_run_does_not_evict_a_new_run_notification() {
        let mut old = StateMachine::for_run("s", "old", 1);
        let old = old
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        let mut new = StateMachine::for_run("s", "new", 2);
        let new = new
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        let now = Instant::now();
        let mut queue = PendingNotifications::default();
        queue.push(new, now);
        queue.push(old, now);
        let due = queue.take_due(now + DELIVERY_DELAY);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].run_id, "new");
    }

    #[test]
    fn replacement_is_bounded_delayed_and_does_not_erase_failure() {
        let mut sm = StateMachine::new("s");
        let fail = sm
            .observe(Observation::Notification(NotificationEvent::Failed))
            .unwrap();
        let done = sm
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        let now = Instant::now();
        let mut queue = PendingNotifications::default();
        queue.push(fail, now);
        queue.push(done.clone(), now);
        queue.push(done.clone(), now);
        assert!(queue.take_due(now).is_empty());
        assert_eq!(queue.take_due(now + DELIVERY_DELAY).len(), 2);
        for i in 0..100 {
            let mut event = done.clone();
            event.session_id = i.to_string();
            queue.push(event, now);
        }
        assert_eq!(queue.take_due(now + DELIVERY_DELAY).len(), MAX_PENDING);
    }
}
