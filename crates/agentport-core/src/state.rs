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

/// What the host (or tests) observed.
#[derive(Debug, Clone)]
pub enum Observation {
    ProcessSpawned,
    ProcessExited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// Official CLI hook event, e.g. "Stop", "Notification", "PreToolUse".
    Hook(String),
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
    fn classify(&self, obs: &Observation) -> (AgentState, StateSource, Confidence, Option<String>) {
        use AgentState::*;
        use Confidence::*;
        use StateSource::*;
        match obs {
            Observation::ProcessSpawned => (Working, Process, High, Some("process:spawn".into())),
            Observation::ProcessExited { code, signal } => {
                let ev = match (code, signal) {
                    (Some(c), _) => format!("process:exit:{c}"),
                    (None, Some(s)) => format!("process:signal:{s}"),
                    _ => "process:exit:unknown".into(),
                };
                (Exited, Process, High, Some(ev))
            }
            Observation::Hook(name) => classify_hook(name),
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
        }
    }

    /// Feed an observation; returns Some(StatusEvent) when a transition should be recorded.
    pub fn observe(&mut self, obs: Observation) -> Option<StatusEvent> {
        let (state, source, confidence, evidence) = self.classify(&obs);
        // Dedupe identical state+source.
        if let Some((last_state, last_source)) = &self.last {
            if *last_state == state && *last_source == source {
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
        self.last_emitted_at = Some(ev.occurred_at);
        Some(ev)
    }
}

/// Classify official hook events. Unknown hook names map to Unknown/low — we
/// never guess (PRD 11.d: unknown versions degrade safely).
fn classify_hook(name: &str) -> (AgentState, StateSource, Confidence, Option<String>) {
    use AgentState::*;
    use Confidence::*;
    use StateSource::*;
    let ev = Some(format!("hook:{name}"));
    match name {
        // Claude Code + Kimi hook names (verified per adapter fixtures).
        "PreToolUse" | "UserPromptSubmit" | "SessionStart" | "BeforeTool" => {
            (Working, Hook, High, ev)
        }
        "Notification" | "PermissionRequest" | "AskUserQuestion" => (NeedsInput, Hook, High, ev),
        "Stop" | "SubagentStop" | "TurnEnd" | "AfterTool" => (Idle, Hook, High, ev),
        "SessionEnd" => (Exited, Hook, High, ev),
        _ => (Unknown, Hook, Low, ev),
    }
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
            needs_input: compile(DEFAULT_NEEDS_INPUT, extra_needs_input),
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
        let mut out = vec![Observation::PtyActivity];
        let text = String::from_utf8_lossy(&self.tail);
        for r in &self.needs_input {
            if let Some(m) = r.find(&text) {
                out.push(Observation::PtyNeedsInputPattern(
                    text[m.start()..m.end().min(m.start() + 40)].replace('\n', " "),
                ));
                return out; // needs-input wins over working
            }
        }
        for r in &self.working {
            if let Some(m) = r.find(&text) {
                out.push(Observation::PtyWorkingPattern(
                    text[m.start()..m.end().min(m.start() + 40)].replace('\n', " "),
                ));
                return out;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .observe(Observation::Hook("Notification".into()))
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
}
