//! Session plumbing shared by the tools: attachments, stream accumulation and
//! the two bounded waits (launch readiness and task completion).
//!
//! Everything here reuses `agentport-service`, so MCP Sessions behave exactly
//! like Sessions created by the desktop app or by a phone: same Host, same
//! process-group cleanup, same status evidence.

use agentport_remote_protocol::{
    SessionAttachParams, SessionControlKind, SessionControlParams, SessionDetachParams,
    SessionInputParams, SessionPollParams, SessionStopParams,
};
use agentport_service::{
    RemoteService, ServiceError, SessionAttachResult, SessionEvent, SessionPollResult,
    SessionSummary,
};
use base64::Engine as _;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::text;

/// A plain (non-seed) attach replay: above the service's 64 KiB "small seed"
/// threshold, so reading text never triggers the renderer bootstrap path that
/// would pull ~4 MiB and emulate a screen.
pub const ATTACH_REPLAY_BYTES: u64 = 65_537;
/// Attachments held at once. The service允许 32; we keep far fewer and detach
/// the least recently used so a long-lived server cannot exhaust them.
const MAX_ATTACHMENTS: usize = 8;
/// Upper bound for one tool call's completion wait.
pub const MAX_WAIT_MS: u64 = 600_000;
pub const DEFAULT_WAIT_MS: u64 = 120_000;
/// Quiet window for the fallback used when the service reports no status at
/// all. It must exceed the Host's own PTY-silence threshold (3 s), or the MCP
/// would declare a turn finished while the Agent is merely thinking.
const QUIET_TURN: Duration = Duration::from_millis(3_500);
/// Quiet window used to decide a freshly launched TUI finished painting.
const QUIET_READY: Duration = Duration::from_millis(500);
pub const DEFAULT_READY_MS: u64 = 25_000;

#[derive(Debug, Clone)]
pub struct ToolFailure {
    pub code: String,
    pub message: String,
}

impl ToolFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        ToolFailure {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub type TResult<T> = Result<T, ToolFailure>;

impl From<ServiceError> for ToolFailure {
    fn from(error: ServiceError) -> Self {
        ToolFailure::new(service_code(&error), describe(&error))
    }
}

fn describe(error: &ServiceError) -> String {
    match error {
        ServiceError::Core(inner) | ServiceError::NotExecutedCore(inner) => inner.to_string(),
        other => format!("{other:?}"),
    }
}

fn service_code(error: &ServiceError) -> &'static str {
    match error {
        ServiceError::AttachmentNotFound => "attachment_not_found",
        ServiceError::AttachmentState => "attachment_unavailable",
        ServiceError::InvalidRequest => "invalid_request",
        ServiceError::RiskAcknowledgementRequired => "risk_acknowledgement_required",
        ServiceError::InputOutcomeUnknown => "input_outcome_unknown",
        ServiceError::NotExecutedCore(_) => "not_executed",
        ServiceError::Core(_) => "core_failure",
        ServiceError::PreconditionFailed => "precondition_failed",
        ServiceError::Serialization => "serialization_failed",
        _ => "service_failure",
    }
}

struct AttachmentHandle {
    attachment_id: String,
    last_used: Instant,
}

#[derive(Default)]
pub struct Attachments {
    handles: HashMap<String, AttachmentHandle>,
}

impl Attachments {
    fn touch(&mut self, session_id: &str, attachment_id: &str) {
        self.handles.insert(
            session_id.to_string(),
            AttachmentHandle {
                attachment_id: attachment_id.to_string(),
                last_used: Instant::now(),
            },
        );
    }

    fn get(&self, session_id: &str) -> Option<&AttachmentHandle> {
        self.handles.get(session_id)
    }

    fn forget(&mut self, session_id: &str) {
        self.handles.remove(session_id);
    }

    /// Session ids with a live attachment, oldest first.
    fn eviction_order(&self, keep: usize) -> Vec<String> {
        if self.handles.len() <= keep {
            return Vec::new();
        }
        let mut entries: Vec<(&String, &AttachmentHandle)> = self.handles.iter().collect();
        entries.sort_by_key(|(_, handle)| handle.last_used);
        entries
            .into_iter()
            .take(self.handles.len().saturating_sub(keep))
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct StateObservation {
    pub state: String,
    pub source: String,
    pub confidence: String,
    pub evidence: Option<String>,
    pub observed_at: Option<Instant>,
}

#[derive(Debug, Default)]
pub struct StreamState {
    pub tail: String,
    pub wrote_output: bool,
    pub bytes: u64,
    pub last_output_at: Option<Instant>,
    pub latest_state: Option<StateObservation>,
    pub exit: Option<ExitFacts>,
    /// A gap was reported by the Host: the tail is not a complete window.
    pub incomplete: bool,
}

#[derive(Debug, Clone)]
pub struct ExitFacts {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub group_cleaned: bool,
    pub reason: String,
}

impl StreamState {
    pub fn absorb(&mut self, events: &[SessionEvent]) {
        for event in events {
            match event.event_type.as_str() {
                "output" | "transient_output" => {
                    let Some(encoded) = event.payload.get("data").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded)
                    else {
                        continue;
                    };
                    let rendered = text::render(&bytes, true);
                    if rendered.trim().is_empty() {
                        // Escape-only frames still prove the Agent is painting.
                        self.bytes += bytes.len() as u64;
                        self.wrote_output = true;
                        self.last_output_at = Some(Instant::now());
                        continue;
                    }
                    text::push_bounded(&mut self.tail, &rendered, text::MAX_READ_BYTES);
                    self.bytes += bytes.len() as u64;
                    self.wrote_output = true;
                    self.last_output_at = Some(Instant::now());
                }
                "state" => {
                    let Some(state) = event.payload.get("state").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    self.latest_state = Some(StateObservation {
                        state: state.to_string(),
                        source: event
                            .payload
                            .get("source")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        confidence: event
                            .payload
                            .get("confidence")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        evidence: event
                            .payload
                            .get("evidence")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned),
                        observed_at: Some(Instant::now()),
                    });
                }
                "resync_required" => {
                    // The retained log no longer covers our cursor: the tail is
                    // partial and must not be presented as the whole story.
                    self.incomplete = true;
                }
                "exit" => {
                    self.exit = Some(ExitFacts {
                        code: event.payload.get("code").and_then(|v| v.as_i64()).map(|v| v as i32),
                        signal: event
                            .payload
                            .get("signal")
                            .and_then(|v| v.as_i64())
                            .map(|v| v as i32),
                        group_cleaned: event
                            .payload
                            .get("group_cleaned")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        reason: event
                            .payload
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                    });
                }
                _ => {}
            }
        }
    }

    pub fn tail_text(&self) -> String {
        let (tail, _) = text::tail(&self.tail, text::WAIT_TAIL_BYTES);
        tail
    }
}

/// Durable position of a status transition: a newer mark means the Agent has
/// moved on since the caller sent its prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusMark {
    pub run_ordinal: i64,
    pub sequence: i64,
}

impl StatusMark {
    fn is_newer_than(&self, other: StatusMark) -> bool {
        (self.run_ordinal, self.sequence) > (other.run_ordinal, other.sequence)
    }
}

/// Result of `wait_for_task`.
#[derive(Debug, Clone)]
pub struct WaitOutcome {
    pub state: &'static str,
    pub source: String,
    pub confidence: String,
    pub evidence: String,
    pub tail: String,
    /// The Host reported a gap, so `tail` is not a complete window.
    pub incomplete: bool,
    pub waited_ms: u128,
}

pub struct SessionOps {
    service: Arc<dyn RemoteService>,
    attachments: Attachments,
    batch_sequence: u64,
}

impl SessionOps {
    pub fn new(service: Arc<dyn RemoteService>) -> Self {
        SessionOps {
            service,
            attachments: Attachments::default(),
            batch_sequence: 0,
        }
    }

    /// Direct service access for tools that only query the service layer.
    pub fn service(&self) -> &dyn RemoteService {
        self.service.as_ref()
    }

    fn next_batch_id(&mut self) -> String {
        self.batch_sequence += 1;
        format!(
            "mcp-{}-{}-{}",
            std::process::id(),
            self.batch_sequence,
            Instant::now().elapsed().as_nanos()
        )
    }

    pub fn list_sessions(&self, include_archived: bool) -> TResult<Vec<SessionSummary>> {
        self.service
            .list_sessions(include_archived)
            .map_err(ToolFailure::from)
    }

    pub fn summary(&self, session_id: &str) -> TResult<SessionSummary> {
        let sessions = self.list_sessions(false)?;
        sessions
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| ToolFailure::new("session_not_found", format!("no Session {session_id}")))
    }

    /// Attach, or reuse the cached attachment for this Session.
    pub fn attach(&mut self, session_id: &str) -> TResult<String> {
        if let Some(handle) = self.attachments.get(session_id) {
            return Ok(handle.attachment_id.clone());
        }
        let result = self.open_attachment(session_id)?;
        for evict in self.attachments.eviction_order(MAX_ATTACHMENTS - 1) {
            if let Some(handle) = self.attachments.get(&evict) {
                let _ = self
                    .service
                    .detach_session(SessionDetachParams {
                        attachment_id: handle.attachment_id.clone(),
                    });
            }
            self.attachments.forget(&evict);
        }
        self.attachments.touch(session_id, &result.attachment_id);
        Ok(result.attachment_id)
    }

    fn open_attachment(&self, session_id: &str) -> TResult<SessionAttachResult> {
        self.service
            .attach_session(SessionAttachParams {
                session_id: session_id.to_string(),
                replay_tail_bytes: ATTACH_REPLAY_BYTES,
                resume_from: None,
                subscribe_output: true,
                screen_snapshot: false,
            })
            .map_err(ToolFailure::from)
    }

    /// Poll one attachment. A stale attachment is reopened once.
    pub fn poll(
        &mut self,
        session_id: &str,
        limit: u16,
        wait_ms: u64,
    ) -> TResult<SessionPollResult> {
        let attachment_id = self.attach(session_id)?;
        match self.service.poll_session(SessionPollParams {
            attachment_id: attachment_id.clone(),
            limit,
            wait_ms,
        }) {
            Ok(result) => {
                self.attachments.touch(session_id, &attachment_id);
                Ok(result)
            }
            Err(ServiceError::AttachmentNotFound) | Err(ServiceError::AttachmentState) => {
                self.attachments.forget(session_id);
                let attachment_id = self.attach(session_id)?;
                self.service
                    .poll_session(SessionPollParams {
                        attachment_id,
                        limit,
                        wait_ms,
                    })
                    .map_err(ToolFailure::from)
            }
            Err(error) => Err(ToolFailure::from(error)),
        }
    }

    pub fn send_bytes(&mut self, session_id: &str, bytes: &[u8]) -> TResult<u64> {
        let attachment_id = self.attach(session_id)?;
        let batch_id = self.next_batch_id();
        // Terminal input stays zeroizing all the way into the service.
        let data_base64 =
            zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(bytes));
        self.service
            .input_session(SessionInputParams {
                attachment_id,
                batch_id,
                data_base64,
            })
            .map(|_| bytes.len() as u64)
            .map_err(ToolFailure::from)
    }

    pub fn interrupt(&mut self, session_id: &str) -> TResult<bool> {
        let attachment_id = self.attach(session_id)?;
        self.service
            .control_session(SessionControlParams {
                attachment_id,
                control: SessionControlKind::Interrupt,
                cols: None,
                rows: None,
                expected_revision: None,
                source_kind: None,
                source_device_id: None,
                orientation: None,
            })
            .map(|result| result.accepted)
            .map_err(ToolFailure::from)
    }

    pub fn stop(&mut self, session_id: &str, grace_ms: u64) -> TResult<bool> {
        let result = self
            .service
            .stop_session(SessionStopParams {
                session_id: session_id.to_string(),
                grace_ms,
            })
            .map_err(ToolFailure::from)?;
        // Release the service-side attachment (and its Host socket) instead of
        // only dropping our handle: the Host bounds authenticated clients.
        self.detach(session_id);
        Ok(result.group_cleaned)
    }

    pub fn detach(&mut self, session_id: &str) {
        if let Some(handle) = self.attachments.get(session_id) {
            let _ = self
                .service
                .detach_session(SessionDetachParams {
                    attachment_id: handle.attachment_id.clone(),
                });
        }
        self.attachments.forget(session_id);
    }

    /// Authoritative status mark used as a "turn baseline".
    pub fn status_mark(&self, session_id: &str) -> TResult<Option<StatusMark>> {
        Ok(self.summary(session_id)?.latest_status.map(|status| StatusMark {
            run_ordinal: status.run_ordinal,
            sequence: status.sequence,
        }))
    }

    /// True when the Session has ended and its Host is gone, i.e. attaching
    /// would fail for a reason that is not an error.
    pub fn is_terminal(&self, session_id: &str) -> TResult<bool> {
        let summary = self.summary(session_id)?;
        Ok(matches!(
            summary.lifecycle.as_str(),
            "exited" | "stopped" | "interrupted" | "failed"
        ) && !summary.host_alive)
    }

    /// Wait until a freshly launched CLI is accepting input.
    ///
    /// Terminal CLIs paint asynchronously; typing before the first quiet
    /// window loses bytes in some TUIs. Readiness is "output observed, then
    /// quiet" or an explicit idle status, never a fixed sleep.
    pub fn wait_ready(&mut self, session_id: &str, timeout_ms: u64) -> TResult<ReadyOutcome> {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut stream = StreamState::default();
        loop {
            let poll = self.poll(session_id, 64, 120)?;
            stream.absorb(&poll.events);
            if let Some(exit) = stream.exit.clone() {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: format!("Agent exited during startup ({:?})", exit.code),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                });
            }
            if self.is_terminal(session_id)? {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: "Session ended during startup".into(),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                });
            }
            if let Some(state) = stream.latest_state.clone() {
                if state.state == "idle" && stream.wrote_output {
                    return Ok(ReadyOutcome {
                        ready: true,
                        reason: "status reported idle".into(),
                        state: Some(state),
                        tail: stream.tail_text(),
                    });
                }
            }
            if stream.wrote_output {
                let quiet = stream
                    .last_output_at
                    .map(|at| at.elapsed())
                    .unwrap_or_default();
                if quiet >= QUIET_READY {
                    return Ok(ReadyOutcome {
                        ready: true,
                        reason: format!("terminal quiet for {}ms", quiet.as_millis()),
                        state: stream.latest_state.clone(),
                        tail: stream.tail_text(),
                    });
                }
            }
            if Instant::now() >= deadline {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: format!("no quiet window within {timeout_ms}ms"),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                });
            }
        }
    }

    /// Wait for the current turn to settle, returning the evidence used.
    ///
    /// Three sources cooperate, in this order:
    ///
    /// 1. the service summary (a cached live Host handshake) — decides "this
    ///    Session is over" and reports an already-settled turn;
    /// 2. `state` frames on the attachment — the live, fastest turn signal;
    /// 3. terminal quiet, *only* when no `working` signal was ever seen, and
    ///    reported as low confidence because it is a guess.
    ///
    /// A closed attachment is never treated as an exit: the Host evicts clients
    /// that stop draining, which happens between tool calls.
    pub fn wait_for_task(
        &mut self,
        session_id: &str,
        timeout_ms: u64,
        since: Option<StatusMark>,
    ) -> TResult<WaitOutcome> {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms.min(MAX_WAIT_MS));
        let mut stream = StreamState::default();
        let mut saw_working = false;
        loop {
            let summary = self.summary(session_id)?;
            let terminal = matches!(
                summary.lifecycle.as_str(),
                "exited" | "stopped" | "interrupted" | "failed"
            );
            if terminal && !summary.host_alive {
                return Ok(settle(
                    "exited",
                    "lifecycle",
                    "high",
                    format!("lifecycle={} hostAlive=false", summary.lifecycle),
                    &stream,
                    started,
                ));
            }
            if let Some(status) = summary.latest_status.as_ref() {
                let mark = StatusMark {
                    run_ordinal: status.run_ordinal,
                    sequence: status.sequence,
                };
                let fresh = since.is_none_or(|baseline| mark.is_newer_than(baseline));
                match status.state.as_str() {
                    "needs_input" => {
                        return Ok(settle(
                            "needs_input",
                            &status.source,
                            &status.confidence,
                            "Agent is waiting for approval".into(),
                            &stream,
                            started,
                        ))
                    }
                    "exited" => {
                        return Ok(settle(
                            "exited",
                            &status.source,
                            &status.confidence,
                            "status reported exited".into(),
                            &stream,
                            started,
                        ))
                    }
                    "working" => saw_working = true,
                    "idle" if fresh => {
                        return Ok(settle(
                            "idle",
                            &status.source,
                            &status.confidence,
                            "status moved to idle after the prompt".into(),
                            &stream,
                            started,
                        ))
                    }
                    // Already idle before this process sent anything: the turn
                    // the caller is asking about is over (regression: a repeat
                    // wait used to burn the whole timeout).
                    "idle" if since.is_none() && stream.latest_state.is_none() => {
                        return Ok(settle(
                            "idle",
                            &status.source,
                            &status.confidence,
                            "status was already idle and no prompt is pending".into(),
                            &stream,
                            started,
                        ))
                    }
                    _ => {}
                }
            }

            // Drain the attachment: live turn frames, and the only thing that
            // keeps the Host from evicting us as a lagging client.
            match self.poll(session_id, 128, 250) {
                Ok(poll) => {
                    stream.absorb(&poll.events);
                    if poll.closed {
                        self.detach(session_id);
                    }
                }
                Err(_) => self.detach(session_id),
            }
            if let Some(state) = stream.latest_state.clone() {
                match state.state.as_str() {
                    "needs_input" => {
                        return Ok(settle(
                            "needs_input",
                            &state.source,
                            &state.confidence,
                            state
                                .evidence
                                .unwrap_or_else(|| "Agent is waiting for approval".into()),
                            &stream,
                            started,
                        ))
                    }
                    "exited" => {
                        return Ok(settle(
                            "exited",
                            &state.source,
                            &state.confidence,
                            state.evidence.unwrap_or_else(|| "status reported exited".into()),
                            &stream,
                            started,
                        ))
                    }
                    "working" => saw_working = true,
                    "idle" if saw_working || since.is_none() => {
                        return Ok(settle(
                            "idle",
                            &state.source,
                            &state.confidence,
                            state
                                .evidence
                                .unwrap_or_else(|| "status moved to idle".into()),
                            &stream,
                            started,
                        ))
                    }
                    _ => {}
                }
            }

            // No turn signal was ever observed: fall back to silence, clearly
            // labelled. This only happens for Agents whose status is a spawn
            // fact rather than a turn heuristic.
            if !saw_working {
                if let Some(at) = stream.last_output_at {
                    if at.elapsed() >= QUIET_TURN {
                        return Ok(settle(
                            "idle",
                            "quiet_window",
                            "low",
                            format!(
                                "no turn-status signal from this Agent; terminal quiet for {}ms",
                                at.elapsed().as_millis()
                            ),
                            &stream,
                            started,
                        ));
                    }
                }
            }

            if Instant::now() >= deadline {
                return Ok(settle(
                    "timeout",
                    "watchdog",
                    "low",
                    format!("still running after {timeout_ms}ms"),
                    &stream,
                    started,
                ));
            }
        }
    }

    /// Read the newest terminal bytes. Replays the Host tail, so this works
    /// while the Session is running and after a Host restart.
    pub fn read_output(&mut self, session_id: &str, tail_bytes: usize) -> TResult<ReadOutcome> {
        let want = tail_bytes.clamp(1024, text::MAX_READ_BYTES);
        if self.is_terminal(session_id)? {
            // The Host keeps terminal bytes only while it runs; after that the
            // text lives in the Agent's native history.
            return Ok(ReadOutcome {
                text: String::new(),
                truncated: false,
                bytes: 0,
                ended: true,
                incomplete: false,
            });
        }
        self.detach(session_id);
        let attachment = self.open_attachment(session_id)?;
        self.attachments.touch(session_id, &attachment.attachment_id);
        let mut stream = StreamState::default();
        let mut idle_polls = 0;
        for _ in 0..12 {
            let poll = self.poll(session_id, 256, 100)?;
            let empty = poll.events.is_empty();
            stream.absorb(&poll.events);
            if poll.closed || stream.exit.is_some() {
                break;
            }
            if empty {
                idle_polls += 1;
                if idle_polls >= 2 {
                    break;
                }
            } else {
                idle_polls = 0;
            }
        }
        let (trimmed, truncated) = text::tail(&stream.tail, want);
        Ok(ReadOutcome {
            text: trimmed,
            truncated,
            bytes: stream.bytes,
            ended: stream.exit.is_some() || self.session_ended(session_id),
            incomplete: stream.incomplete,
        })
    }

    fn session_ended(&self, session_id: &str) -> bool {
        self.summary(session_id)
            .map(|summary| {
                matches!(
                    summary.lifecycle.as_str(),
                    "exited" | "stopped" | "interrupted" | "failed"
                )
            })
            .unwrap_or(false)
    }
}

fn settle(
    state: &'static str,
    source: &str,
    confidence: &str,
    evidence: String,
    stream: &StreamState,
    started: Instant,
) -> WaitOutcome {
    WaitOutcome {
        state,
        source: source.to_string(),
        confidence: confidence.to_string(),
        evidence,
        tail: stream.tail_text(),
        incomplete: stream.incomplete,
        waited_ms: started.elapsed().as_millis(),
    }
}

#[derive(Debug, Clone)]
pub struct ReadyOutcome {
    pub ready: bool,
    pub reason: String,
    pub state: Option<StateObservation>,
    pub tail: String,
}

#[derive(Debug, Clone)]
pub struct ReadOutcome {
    pub text: String,
    pub truncated: bool,
    pub bytes: u64,
    pub ended: bool,
    /// The Host reported a gap; the returned text is not a complete window.
    pub incomplete: bool,
}
