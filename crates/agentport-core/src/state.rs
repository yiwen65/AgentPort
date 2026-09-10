//! Agent state machine with evidence (PRD 3.4, 4.3).
//!
//! Rules:
//! - Every transition carries source + confidence + timestamp + evidence tag.
//! - Heuristic (PTY) results never present as high confidence.
//! - Per-session monotonic sequence; duplicate/out-of-order observations are
//!   deduped; rapid flip-flops are debounced.

use crate::models::{
    legacy_run_id, AgentState, Confidence, StateSource, StatusEvent, LEGACY_RUN_ORDINAL,
};
use chrono::{Duration, Utc};
use regex::Regex;

/// Metadata-only event accepted after Host session/run/token validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationEvent {
    Completed,
    NeedsInput,
    Failed,
    Working,
}

/// This envelope intentionally has no prompt/tool/error payload field. Strict
/// deserialization also rejects duplicate keys, unknown fields and wrong types.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationRelay {
    event: String,
    kind: String,
    session_id: String,
    run_id: String,
    token: String,
}

/// Authenticate metadata against this concrete Host launch before interpreting
/// its kind. No payload or token is returned to journals or notification clients.
pub fn parse_notification_relay(
    line: &[u8],
    session_id: &str,
    run_id: &str,
    token: &str,
) -> Option<NotificationEvent> {
    if session_id.is_empty() || run_id.is_empty() || token.is_empty() {
        return None;
    }
    let relay: NotificationRelay = serde_json::from_slice(line).ok()?;
    if relay.event != "AgentPortNotification"
        || relay.session_id != session_id
        || relay.run_id != run_id
        || relay.token != token
    {
        return None;
    }
    match relay.kind.as_str() {
        "completed" => Some(NotificationEvent::Completed),
        "needs_input" => Some(NotificationEvent::NeedsInput),
        "failed" => Some(NotificationEvent::Failed),
        "working" => Some(NotificationEvent::Working),
        _ => None,
    }
}

/// What the host (or tests) observed.
#[derive(Debug, Clone)]
pub enum Observation {
    ProcessSpawned,
    ProcessExited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// A requested stop is distinct from an unexpected nonzero process exit,
    /// including the SIGKILL escalation used to clean up a stopped process.
    ProcessStopped {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// Only the authenticated relay parser may construct this observation.
    Notification(NotificationEvent),
    /// Official CLI hook event, e.g. "Stop", "Notification", "PreToolUse".
    Hook(String),
    AdapterTurnStart {
        adapter: String,
    },
    /// A structured adapter protocol proved that the current turn settled.
    /// Unlike PTY silence, this is a semantic lifecycle fact.
    AdapterTurnEnd {
        adapter: String,
    },
    /// Meaningful output bytes arrived on the PTY.
    PtyActivity,
    /// No output for the given duration after activity.
    PtySilence {
        ms: u64,
    },
    /// Output tail matched an adapter needs-input pattern.
    PtyNeedsInputPattern(String),
    /// Output tail matched an adapter working pattern.
    PtyWorkingPattern(String),
}

const DEBOUNCE_MS: i64 = 300;

#[derive(Debug)]
pub struct StateMachine {
    session_id: String,
    run_id: String,
    run_ordinal: i64,
    sequence: i64,
    last: Option<(AgentState, StateSource)>,
    last_emitted_at: Option<chrono::DateTime<Utc>>,
    last_evidence: Option<String>,
    last_completion: Option<(StateSource, chrono::DateTime<Utc>)>,
    /// When true (hook integration unavailable), PTY-derived needs_input is
    /// capped at medium confidence and flagged as imprecise (PRD 3.4 failure A).
    hooks_degraded: bool,
}

impl StateMachine {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self::for_run(session_id, legacy_run_id(), LEGACY_RUN_ORDINAL)
    }

    /// Construct the state machine for one concrete Host launch.  Sequence
    /// numbers intentionally restart at one for each run; the run identity is
    /// the durable namespace that keeps those histories distinct.
    pub fn for_run(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        run_ordinal: i64,
    ) -> Self {
        StateMachine {
            session_id: session_id.into(),
            run_id: run_id.into(),
            run_ordinal,
            sequence: 0,
            last: None,
            last_emitted_at: None,
            last_evidence: None,
            last_completion: None,
            hooks_degraded: false,
        }
    }

    pub fn set_hooks_degraded(&mut self, degraded: bool) {
        self.hooks_degraded = degraded;
    }

    pub fn sequence(&self) -> i64 {
        self.sequence
    }

    /// Map an observation to a candidate (state, source, confidence, evidence).
    fn classify(
        &self,
        obs: &Observation,
    ) -> Option<(AgentState, StateSource, Confidence, Option<String>)> {
        use AgentState::*;
        use Confidence::*;
        use StateSource::*;
        let classified = match obs {
            Observation::ProcessSpawned => (Working, Process, High, Some("process:spawn".into())),
            Observation::ProcessExited { code, signal } => {
                let ev = match (code, signal) {
                    (Some(c), _) => format!("process:exit:{c}"),
                    (None, Some(s)) => format!("process:signal:{s}"),
                    _ => "process:exit:unknown".into(),
                };
                (Exited, Process, High, Some(ev))
            }
            Observation::ProcessStopped { code, signal } => (
                Exited,
                Process,
                High,
                Some(format!("process:stopped:code={code:?}:signal={signal:?}")),
            ),
            Observation::Notification(kind) => match kind {
                NotificationEvent::Completed => (
                    Idle,
                    Hook,
                    High,
                    Some("hook:AgentPortNotification:completed".into()),
                ),
                NotificationEvent::NeedsInput => (
                    NeedsInput,
                    Hook,
                    High,
                    Some("hook:AgentPortNotification:needs_input".into()),
                ),
                NotificationEvent::Failed => (
                    Idle,
                    Hook,
                    High,
                    Some("hook:AgentPortNotification:failed".into()),
                ),
                NotificationEvent::Working => (
                    Working,
                    Hook,
                    High,
                    Some("hook:AgentPortNotification:working".into()),
                ),
            },
            Observation::Hook(name) => return classify_hook(name),
            Observation::AdapterTurnStart { adapter } => (
                Working,
                Adapter,
                High,
                Some(format!("adapter:{adapter}:TurnStart")),
            ),
            Observation::AdapterTurnEnd { adapter } => (
                Idle,
                Adapter,
                High,
                Some(format!("adapter:{adapter}:TurnEnd")),
            ),
            Observation::PtyActivity => (Working, Pty, Medium, Some("pty:activity".into())),
            Observation::PtySilence { ms } => {
                (Idle, Pty, Medium, Some(format!("pty:silence:{ms}ms")))
            }
            Observation::PtyNeedsInputPattern(p) => {
                // Never high confidence from heuristics (PRD 3.4 failure path A).
                (NeedsInput, Pty, Medium, Some(format!("pty:pattern:{p}")))
            }
            Observation::PtyWorkingPattern(p) => {
                (Working, Pty, Medium, Some(format!("pty:pattern:{p}")))
            }
        };
        Some(classified)
    }

    /// Feed an observation; returns Some(StatusEvent) when a transition should be recorded.
    pub fn observe(&mut self, obs: Observation) -> Option<StatusEvent> {
        let (state, source, confidence, evidence) = self.classify(&obs)?;
        if source != StateSource::Pty
            && matches!(state, AgentState::Working | AgentState::NeedsInput)
        {
            self.last_completion = None;
        }
        let completed = state == AgentState::Idle
            && ((source == StateSource::Hook
                && matches!(
                    evidence.as_deref(),
                    Some("hook:Stop" | "hook:TurnEnd" | "hook:AgentPortNotification:completed")
                ))
                || (source == StateSource::Adapter
                    && matches!(
                        evidence.as_deref(),
                        Some(
                            "adapter:pi:TurnEnd"
                                | "adapter:easy_pi:TurnEnd"
                                | "adapter:omp:TurnEnd"
                                | "adapter:kimi:TurnEnd"
                        )
                    )));
        if completed
            && self.last_completion.is_some_and(|(previous_source, at)| {
                previous_source != source && Utc::now() - at < Duration::seconds(2)
            })
        {
            return None;
        }
        // Dedupe identical state+source.
        if let Some((last_state, last_source)) = &self.last {
            // Different terminal outcomes (failed vs completed) must survive
            // even when both are represented as an idle interactive process.
            let changed_terminal_outcome = state == AgentState::Idle
                && evidence.as_deref() != self.last_evidence.as_deref()
                && (evidence.as_deref() == Some("hook:AgentPortNotification:failed")
                    || self.last_evidence.as_deref() == Some("hook:AgentPortNotification:failed"));
            if *last_state == state && *last_source == source && !changed_terminal_outcome {
                return None;
            }
        }
        // Debounce only low-confidence PTY churn.  Hook and process facts are
        // authoritative, and a PTY needs-input match is user-actionable, so
        // neither may be swallowed merely because an activity frame arrived
        // in the same output burst.
        if source == StateSource::Pty && state != AgentState::NeedsInput {
            if let Some(t) = self.last_emitted_at {
                if Utc::now() - t < Duration::milliseconds(DEBOUNCE_MS) && self.last.is_some() {
                    return None;
                }
            }
        }
        self.sequence += 1;
        let ev = StatusEvent {
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            run_ordinal: self.run_ordinal,
            sequence: self.sequence,
            state,
            source,
            confidence,
            evidence,
            log_cursor: None,
            occurred_at: Utc::now(),
        };
        self.last = Some((state, source));
        self.last_evidence = ev.evidence.clone();
        if completed {
            self.last_completion = Some((source, ev.occurred_at));
        }
        self.last_emitted_at = Some(ev.occurred_at);
        Some(ev)
    }
}

/// Classify official hook events. Unknown hook names map to Unknown/low — we
/// never guess (PRD 11.d: unknown versions degrade safely).
fn classify_hook(name: &str) -> Option<(AgentState, StateSource, Confidence, Option<String>)> {
    use AgentState::*;
    use Confidence::*;
    use StateSource::*;
    let ev = Some(format!("hook:{name}"));
    let classified = match name {
        // Claude Code + Kimi hook names (verified per adapter fixtures).
        "PreToolUse" | "UserPromptSubmit" | "SessionStart" | "BeforeTool" => {
            (Working, Hook, High, ev)
        }
        // Claude's generic Notification hook includes idle_prompt and
        // push_notification. It is informational; PermissionRequest is the
        // authoritative approval signal.
        "Notification" => return None,
        "PermissionRequest" | "AskUserQuestion" => (NeedsInput, Hook, High, ev),
        "Stop" | "SubagentStop" | "TurnEnd" | "AfterTool" => (Idle, Hook, High, ev),
        "SessionEnd" => (Exited, Hook, High, ev),
        _ => (Unknown, Hook, Low, ev),
    };
    Some(classified)
}

/// Rolling PTY output detector: strips ANSI, keeps a bounded tail, matches
/// adapter-provided patterns. Pure function of bytes — fully testable.
pub struct PtyDetector {
    tail: Vec<u8>,
    max_tail: usize,
    needs_input: Vec<Regex>,
    working: Vec<Regex>,
}

/// Default patterns shared by all agents (English CLIs).
pub const DEFAULT_NEEDS_INPUT: &[&str] = &[
    r"(?i)do you want to proceed",
    r"(?i)press enter to (confirm|continue)",
    r"(?i)\(y/n\)\s*$",
    r"(?i)allow (this|once|always)",
    r"(?i)approve\?",
];

pub const DEFAULT_WORKING: &[&str] = &[
    r"(?i)esc to interrupt",
    r"(?i)thinking\.\.\.",
    r"(?i)running\b",
];

impl PtyDetector {
    pub fn new(extra_needs_input: &[String], extra_working: &[String]) -> Self {
        Self::with_needs_input(true, extra_needs_input, extra_working)
    }

    pub fn with_needs_input(
        enabled: bool,
        extra_needs_input: &[String],
        extra_working: &[String],
    ) -> Self {
        let compile = |pats: &[&str], extra: &[String]| -> Vec<Regex> {
            pats.iter()
                .map(|p| p.to_string())
                .chain(extra.iter().cloned())
                .filter_map(|p| Regex::new(&p).ok())
                .collect()
        };
        PtyDetector {
            tail: Vec::with_capacity(8192),
            max_tail: 8192,
            needs_input: enabled
                .then(|| compile(DEFAULT_NEEDS_INPUT, extra_needs_input))
                .unwrap_or_default(),
            working: compile(DEFAULT_WORKING, extra_working),
        }
    }

    /// Feed raw PTY bytes; returns observations derived from the current tail.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Observation> {
        let stripped = strip_ansi_escapes::strip(chunk);
        self.tail.extend_from_slice(&stripped);
        if self.tail.len() > self.max_tail {
            let drop = self.tail.len() - self.max_tail;
            self.tail.drain(..drop);
        }
        // The tail exists so patterns split across reads still match. A prompt
        // wholly before this boundary is historical output, not evidence that
        // an unrelated TUI repaint (for example, mouse hover) needs approval.
        let new_output_start = self.tail.len().saturating_sub(stripped.len());
        let mut out = vec![Observation::PtyActivity];
        let text = String::from_utf8_lossy(&self.tail);
        for r in &self.needs_input {
            if let Some(m) = r.find_iter(&text).find(|m| m.end() > new_output_start) {
                out.push(Observation::PtyNeedsInputPattern(
                    text[m.start()..m.end().min(m.start() + 40)].replace('\n', " "),
                ));
                return out; // needs-input wins over working
            }
        }
        for r in &self.working {
            if let Some(m) = r.find_iter(&text).find(|m| m.end() > new_output_start) {
                out.push(Observation::PtyWorkingPattern(
                    text[m.start()..m.end().min(m.start() + 40)].replace('\n', " "),
                ));
                return out;
            }
        }
        out
    }

    /// Current ANSI-stripped output tail for adapter metadata extraction.
    /// The tail is bounded by `max_tail`, so callers never scan the full log.
    pub fn stripped_tail(&self) -> String {
        String::from_utf8_lossy(&self.tail).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_relay_kinds_are_precise_but_raw_hook_names_cannot_spoof_them() {
        use crate::models::AttentionKind;
        for (kind, expected) in [
            (
                NotificationEvent::Completed,
                Some(AttentionKind::TurnCompleted),
            ),
            (
                NotificationEvent::NeedsInput,
                Some(AttentionKind::ApprovalRequested),
            ),
            (
                NotificationEvent::Failed,
                Some(AttentionKind::ExecutionFailed),
            ),
            (NotificationEvent::Working, None),
        ] {
            let mut sm = StateMachine::new("ses_t");
            let event = sm.observe(Observation::Notification(kind)).unwrap();
            assert_eq!(event.confidence, Confidence::High);
            assert_eq!(event.attention_kind(), expected);
            assert!(sm.observe(Observation::Notification(kind)).is_none());
        }
        let mut sm = StateMachine::new("ses_t");
        for name in [
            "AgentPortNotification",
            "AgentPortNotification:completed",
            "AgentPortNotification:failed",
        ] {
            if let Some(event) = sm.observe(Observation::Hook(name.into())) {
                assert_eq!(event.attention_kind(), None);
            }
        }
    }

    #[test]
    fn hook_and_native_completion_share_one_journal_event_until_a_precise_new_turn() {
        let mut sm = StateMachine::new("ses_t");
        sm.observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        assert!(sm
            .observe(Observation::AdapterTurnEnd {
                adapter: "omp".into()
            })
            .is_none());
        sm.observe(Observation::AdapterTurnStart {
            adapter: "omp".into(),
        })
        .unwrap();
        assert!(sm
            .observe(Observation::AdapterTurnEnd {
                adapter: "omp".into()
            })
            .is_some());
        assert!(sm
            .observe(Observation::Notification(NotificationEvent::Completed))
            .is_none());
        assert_eq!(sm.sequence(), 3);
    }

    #[test]
    fn requested_stop_never_becomes_failure_even_after_sigkill_escalation() {
        for (code, signal) in [(Some(1), None), (None, Some(9)), (Some(137), None)] {
            let mut sm = StateMachine::new("ses_t");
            let event = sm
                .observe(Observation::ProcessStopped { code, signal })
                .unwrap();
            assert_eq!(event.state, AgentState::Exited);
            assert_eq!(event.attention_kind(), None);
        }
        let mut sm = StateMachine::new("ses_t");
        let failed = sm
            .observe(Observation::ProcessExited {
                code: Some(1),
                signal: None,
            })
            .unwrap();
        assert_eq!(
            failed.attention_kind(),
            Some(crate::models::AttentionKind::ExecutionFailed)
        );
    }

    #[test]
    fn working_clears_pending_relay_approval_and_terminal_outcomes_remain_distinct() {
        let mut sm = StateMachine::new("ses_t");
        sm.observe(Observation::Notification(NotificationEvent::NeedsInput))
            .unwrap();
        assert_eq!(
            sm.observe(Observation::Notification(NotificationEvent::Working))
                .unwrap()
                .state,
            AgentState::Working
        );
        let failed = sm
            .observe(Observation::Notification(NotificationEvent::Failed))
            .unwrap();
        let completed = sm
            .observe(Observation::Notification(NotificationEvent::Completed))
            .unwrap();
        assert_ne!(failed.attention_kind(), completed.attention_kind());
        sm.observe(Observation::AdapterTurnStart {
            adapter: "omp".into(),
        })
        .unwrap();
        assert!(sm
            .observe(Observation::AdapterTurnEnd {
                adapter: "omp".into()
            })
            .unwrap()
            .attention_kind()
            .is_some());
    }

    #[test]
    fn process_exit_is_high_confidence_fact() {
        let mut sm = StateMachine::new("ses_t");
        let e = sm
            .observe(Observation::ProcessExited {
                code: Some(0),
                signal: None,
            })
            .unwrap();
        assert_eq!(e.state, AgentState::Exited);
        assert_eq!(e.source, StateSource::Process);
        assert_eq!(e.confidence, Confidence::High);
        assert_eq!(e.sequence, 1);
    }

    #[test]
    fn hook_needs_input_high_pty_never_high() {
        let mut sm = StateMachine::new("ses_t");
        let e = sm
            .observe(Observation::Hook("PermissionRequest".into()))
            .unwrap();
        assert_eq!(
            (e.state, e.confidence),
            (AgentState::NeedsInput, Confidence::High)
        );
        let mut sm2 = StateMachine::new("ses_t2");
        std::thread::sleep(std::time::Duration::from_millis(320));
        let e2 = sm2
            .observe(Observation::PtyNeedsInputPattern(
                "Do you want to proceed".into(),
            ))
            .unwrap();
        assert_eq!(
            (e2.state, e2.confidence),
            (AgentState::NeedsInput, Confidence::Medium)
        );
    }

    #[test]
    fn informational_notification_hook_does_not_override_idle_state() {
        let mut sm = StateMachine::new("ses_t");
        let idle = sm.observe(Observation::Hook("Stop".into())).unwrap();
        assert_eq!(idle.state, AgentState::Idle);

        assert!(sm
            .observe(Observation::Hook("Notification".into()))
            .is_none());
        assert_eq!(sm.sequence(), 1);
    }

    #[test]
    fn dedupe_and_monotonic_sequence() {
        let mut sm = StateMachine::new("ses_t");
        assert!(sm.observe(Observation::PtyActivity).is_some());
        assert!(sm.observe(Observation::PtyActivity).is_none()); // dup
        std::thread::sleep(std::time::Duration::from_millis(320));
        let e = sm.observe(Observation::PtySilence { ms: 3000 }).unwrap();
        assert_eq!(e.sequence, 2);
    }

    #[test]
    fn detector_matches_and_strips_ansi() {
        let mut d = PtyDetector::new(&[], &[]);
        let obs = d.feed(b"\x1b[32mThinking...\x1b[0m working on it");
        assert!(obs
            .iter()
            .any(|o| matches!(o, Observation::PtyWorkingPattern(_))));
        let obs = d.feed(b"\nDo you want to proceed? (y/n)");
        assert!(obs
            .iter()
            .any(|o| matches!(o, Observation::PtyNeedsInputPattern(_))));
    }

    #[test]
    fn detector_can_disable_semantically_impossible_approval_matches() {
        let mut d = PtyDetector::with_needs_input(false, &[], &[]);
        let observations = d.feed(b"Allow once\nPress enter to confirm");
        assert_eq!(observations.len(), 1);
        assert!(matches!(observations[0], Observation::PtyActivity));
    }

    #[test]
    fn detector_does_not_reemit_a_stale_prompt_on_unrelated_output() {
        let mut d = PtyDetector::new(&[], &[]);
        let prompt = d.feed(b"Press enter to confirm");
        assert!(prompt
            .iter()
            .any(|o| matches!(o, Observation::PtyNeedsInputPattern(_))));

        let repaint = d.feed(b"\x1b[1;1H");
        assert_eq!(repaint.len(), 1);
        assert!(matches!(repaint[0], Observation::PtyActivity));

        let mut split = PtyDetector::new(&[], &[]);
        assert_eq!(split.feed(b"Press enter to ").len(), 1);
        assert!(split
            .feed(b"confirm")
            .iter()
            .any(|o| matches!(o, Observation::PtyNeedsInputPattern(_))));
    }

    #[test]
    fn unknown_hook_degrades_to_unknown_low() {
        let mut sm = StateMachine::new("ses_t");
        let e = sm
            .observe(Observation::Hook("FutureNewEvent".into()))
            .unwrap();
        assert_eq!(
            (e.state, e.confidence),
            (AgentState::Unknown, Confidence::Low)
        );
    }

    #[test]
    fn adapter_turn_end_is_a_high_confidence_idle_fact() {
        let mut sm = StateMachine::new("ses_t");
        let event = sm
            .observe(Observation::AdapterTurnEnd {
                adapter: "kimi".into(),
            })
            .unwrap();
        assert_eq!(event.state, AgentState::Idle);
        assert_eq!(event.source, StateSource::Adapter);
        assert_eq!(event.confidence, Confidence::High);
        assert_eq!(event.evidence.as_deref(), Some("adapter:kimi:TurnEnd"));
    }
}
