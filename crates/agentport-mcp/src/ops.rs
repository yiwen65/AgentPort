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
/// Default stays below a typical MCP client request timeout (60 s). The server
/// handles one request at a time, so a wait that outlives the client's timeout
/// reports "unknown outcome" and blocks every later call behind it.
pub const DEFAULT_WAIT_MS: u64 = 45_000;
/// Gap between the prompt text and its Enter keypress. See `deliver_prompt`.
const ENTER_GAP: Duration = Duration::from_millis(150);
/// How long to watch for evidence that the prompt actually started a turn.
const SUBMIT_EVIDENCE: Duration = Duration::from_millis(1_500);
const MAX_ENTER_RETRIES: u32 = 2;
/// Quiet window before calling a Shell Session finished: a command that printed
/// nothing for four seconds after Enter is done, and the Shell has no other
/// signal to offer.
const QUIET_SHELL: Duration = Duration::from_millis(4_000);
/// Quiet window for a coding Agent that never reported a turn boundary. Models
/// routinely think for many seconds without a byte of output, so this only
/// produces an `unknown` verdict, never "done".
/// Quiet window used to decide a freshly launched TUI finished painting.
const QUIET_READY: Duration = Duration::from_millis(500);
/// Cadence for scanning the rendered screen for trust/login prompts.
const DIALOG_CHECK: Duration = Duration::from_millis(1_500);
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

/// Trust, login and sign-in screens: the CLI is asking a question, not running
/// the prompt. Reading it from the rendered tail is the only signal available —
/// these dialogs are not status events and have no hook.
const BLOCKING_PROMPT_PATTERNS: &[&str] = &[
    "trust this folder",
    "trust this directory",
    "trust folder",
    "do you trust the files",
    "approve in your browser",
    "finish signing in",
    "waiting for approval",
    "log in to continue",
    "sign in to continue",
    // First-run onboarding menus (Cursor CLI) navigate instead of accepting text.
    "use arrow keys to navigate",
    "navigate · enter select",
];

/// First recognizable blocking prompt in a rendered tail, if any.
///
/// Matching is done twice: once verbatim and once with all whitespace removed,
/// because full-screen TUIs often draw words with cursor positioning and the
/// captured tail can arrive as `1.Trustfolder`.
pub fn detect_blocking_prompt(tail: &str) -> Option<&'static str> {
    let lower = tail.to_ascii_lowercase();
    let squeezed: String = lower.split_whitespace().collect();
    BLOCKING_PROMPT_PATTERNS
        .iter()
        .find(|pattern| {
            lower.contains(**pattern)
                || squeezed.contains(&pattern.split_whitespace().collect::<String>())
        })
        .copied()
}

/// `AGENTPORT_MCP_WAIT_TRACE=1` explains why a wait has not settled yet.
fn wait_trace_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| cfg!(debug_assertions) && std::env::var_os("AGENTPORT_MCP_WAIT_TRACE").is_some())
}

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

    /// Newest moment the Session showed any sign of life. Used as the quiet
    /// baseline: output may have happened before this process attached, so a
    /// missing `last_output_at` must not disable the silence fallback.
    pub fn last_activity_at(&self) -> Option<Instant> {
        match (self.last_output_at, self.latest_state.as_ref().and_then(|state| state.observed_at)) {
            (Some(output), Some(state)) => Some(output.max(state)),
            (Some(output), None) => Some(output),
            (None, Some(state)) => Some(state),
            (None, None) => None,
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

    /// Type a prompt and submit it.
    ///
    /// The text and the Enter keypress are written separately on purpose. A
    /// full-screen TUI receives one read per write, and Ink-based CLIs treat a
    /// multi-character read as a paste: when the trailing CR rides along with
    /// the text, the line is inserted and *never submitted* (observed with
    /// Claude Code). Writing them apart, then retrying Enter while no redraw
    /// appears, makes submission robust instead of a race against PTY packet
    /// boundaries.
    pub fn deliver_prompt(&mut self, session_id: &str, text: &str) -> TResult<PromptDelivery> {
        // Flush the startup paint first so the echo of our own text cannot be
        // mistaken for the redraw that proves submission.
        let _ = self.drain(session_id);
        let mut bytes = self.send_bytes(session_id, text.as_bytes())?;
        std::thread::sleep(ENTER_GAP);
        let _ = self.drain(session_id);
        // Never type into a trust/login dialog: the keystrokes are dropped and
        // the caller would wait for a turn that never starts.
        if let Some(dialog) = self
            .peek_tail(session_id)
            .and_then(|tail| detect_blocking_prompt(&tail).map(str::to_string))
        {
            return Ok(PromptDelivery {
                bytes: 0,
                submitted: false,
                redrew: false,
                enter_retries: 0,
                blocked_on: Some(dialog),
            });
        }
        // A distinctive prefix identifies our own prompt in the transcript
        // echo; a dialog that swallows keystrokes never shows it.
        let token: String = text.trim().chars().take(10).collect();
        let mut retries = 0;
        loop {
            bytes += self.send_bytes(session_id, b"\r")?;
            let blocked_on = |this: &mut Self| -> Option<String> {
                this.peek_tail(session_id)
                    .and_then(|tail| detect_blocking_prompt(&tail).map(str::to_string))
            };
            match self.await_turn_start(session_id, &token)? {
                SubmitEvidence::Started => {
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: true,
                        redrew: true,
                        enter_retries: retries,
                        blocked_on: None,
                    })
                }
                // The screen changed but no turn began: most likely a trust,
                // login or permission dialog owns the keyboard. Pressing Enter
                // again could choose an item in that dialog, so stop here and
                // report it honestly.
                SubmitEvidence::RedrewOnly => {
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: false,
                        redrew: true,
                        enter_retries: retries,
                        blocked_on: blocked_on(self),
                    })
                }
                SubmitEvidence::Silent => {
                    if retries >= MAX_ENTER_RETRIES {
                        return Ok(PromptDelivery {
                            bytes,
                            submitted: false,
                            redrew: false,
                            enter_retries: retries,
                            blocked_on: blocked_on(self),
                        });
                    }
                    retries += 1;
                    std::thread::sleep(ENTER_GAP);
                }
            }
        }
    }

    /// Drain anything already buffered without waiting.
    fn drain(&mut self, session_id: &str) -> TResult<usize> {
        let mut seen = 0;
        for _ in 0..3 {
            let poll = self.poll(session_id, 256, 0)?;
            let count = poll.events.len();
            seen += count;
            if count == 0 || poll.closed {
                break;
            }
        }
        Ok(seen)
    }

    /// Classify what the Enter keypress produced.
    ///
    /// "A redraw happened" is not proof of submission: a menu dialog also
    /// redraws. Only a turn start (working state, or a fresh attention signal)
    /// proves the prompt was accepted.
    fn await_turn_start(&mut self, session_id: &str, token: &str) -> TResult<SubmitEvidence> {
        let deadline = Instant::now() + SUBMIT_EVIDENCE;
        let mut redrew = false;
        let mut semantic_working = false;
        loop {
            let poll = self.poll(session_id, 256, 100)?;
            if !poll.events.is_empty() {
                let mut stream = StreamState::default();
                stream.absorb(&poll.events);
                redrew = true;
                if stream.latest_state.as_ref().is_some_and(|state| {
                    state.state == "working"
                        && matches!(state.source.as_str(), "hook" | "adapter")
                }) {
                    semantic_working = true;
                }
            }
            if let Ok(summary) = self.summary(session_id) {
                let hook_working = summary.latest_status.as_ref().is_some_and(|status| {
                    status.state == "working"
                        && matches!(status.source.as_str(), "hook" | "adapter")
                });
                // Only a semantic work claim proves a turn started; a PTY
                // "working" is also what a repainting dialog looks like.
                if hook_working || summary.latest_attention_kind.is_some() {
                    semantic_working = true;
                }
            }
            let done = semantic_working || poll.closed || Instant::now() >= deadline;
            if done {
                if semantic_working {
                    return Ok(SubmitEvidence::Started);
                }
                // Fall back to the transcript: a submitted prompt is echoed as
                // a user message, a swallowed one never reaches it.
                let echoed = self
                    .peek_tail(session_id)
                    .map(|tail| tail.contains(token))
                    .unwrap_or(false);
                return Ok(match (echoed, redrew) {
                    (true, true) => SubmitEvidence::Started,
                    (false, true) => SubmitEvidence::RedrewOnly,
                    _ => SubmitEvidence::Silent,
                });
            }
        }
    }

    /// Bounded replay of the Host tail, used as a submission oracle.
    fn peek_tail(&mut self, session_id: &str) -> Option<String> {
        let outcome = self.read_output(session_id, text::WAIT_TAIL_BYTES).ok()?;
        Some(outcome.text)
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
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut stream = StreamState::default();
        loop {
            let poll = self.poll(session_id, 64, 120)?;
            stream.absorb(&poll.events);
            if poll.closed {
                self.detach(session_id);
            }
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
    /// Sources, in order of authority:
    ///
    /// 1. an attention event: `needs_input` (approval) or `turn_completed`;
    /// 2. a hook/adapter `idle`, which is a turn boundary;
    /// 3. the lifecycle, for an ended Session;
    /// 4. terminal quiet — for a Generic Shell only, where silence really does
    ///    mean the command finished.
    ///
    /// A PTY `idle` is *not* a boundary: the Host reports it after three
    /// seconds of silence, which is exactly what a model thinking looks like.
    /// A closed attachment is not an exit either: the Host evicts clients that
    /// stop draining, which happens between tool calls.
    pub fn wait_for_task(
        &mut self,
        session_id: &str,
        timeout_ms: u64,
        since: Option<StatusMark>,
    ) -> TResult<WaitOutcome> {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms.min(MAX_WAIT_MS));
        let mut stream = StreamState::default();
        let mut saw_turn_source = false;
        let watching_since = Instant::now();
        let mut last_dialog_check = Instant::now();
        loop {
            let summary = self.summary(session_id)?;
            let terminal = matches!(
                summary.lifecycle.as_str(),
                "exited" | "stopped" | "interrupted" | "failed"
            );
            if terminal && !summary.host_alive {
                return Ok(self.settle(
                    session_id,
                    "exited",
                    "lifecycle",
                    "high",
                    format!("lifecycle={} hostAlive=false", summary.lifecycle),
                    &stream,
                    started,
                ));
            }
            let attention = summary.latest_attention_kind.as_deref();
            if attention == Some("approval_requested") {
                return Ok(self.settle(
                    session_id,
                    "needs_input",
                    "hook",
                    "high",
                    "the Agent is waiting for approval".into(),
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
                let turn_source = matches!(status.source.as_str(), "hook" | "adapter");
                saw_turn_source |= turn_source;
                match status.state.as_str() {
                    "needs_input" => {
                        return Ok(self.settle(
                            session_id,
                            "needs_input",
                            &status.source,
                            &status.confidence,
                            "Agent is waiting for approval".into(),
                            &stream,
                            started,
                        ))
                    }
                    "exited" => {
                        return Ok(self.settle(
                            session_id,
                            "exited",
                            &status.source,
                            &status.confidence,
                            "status reported exited".into(),
                            &stream,
                            started,
                        ))
                    }
                    // A hook/adapter idle is a turn boundary. So is a
                    // completion classifier, whatever its state source.
                    "idle"
                        if attention == Some("turn_completed")
                            || turn_source
                            // No prompt is pending and nothing moved since we
                            // attached: the caller is asking about a turn that
                            // is already over.
                            || (since.is_none() && stream.latest_state.is_none()) =>
                    {
                        let evidence = if attention == Some("turn_completed") {
                            "turn completion reported after the prompt".to_string()
                        } else if since.is_some() && fresh {
                            "status moved to idle after the prompt".to_string()
                        } else {
                            "status was already idle and no prompt is pending".to_string()
                        };
                        return Ok(self.settle(
                            session_id,
                            "idle",
                            &status.source,
                            &status.confidence,
                            evidence,
                            &stream,
                            started,
                        ))
                    }
                    _ => {}
                }
            }

            // Drain the attachment: live turn frames, and the only thing that
            // keeps the Host from evicting us as a lagging client.
            let mut polled = 0;
            match self.poll(session_id, 128, 250) {
                Ok(poll) => {
                    polled = poll.events.len();
                    stream.absorb(&poll.events);
                    if poll.closed {
                        self.detach(session_id);
                    }
                }
                Err(_) => self.detach(session_id),
            }
            if wait_trace_enabled() {
                eprintln!(
                    "wait_trace events={polled} state={:?} quiet_age_ms={:?} turn_source={saw_turn_source}",
                    stream.latest_state.as_ref().map(|state| state.state.clone()),
                    stream.last_activity_at().map(|at| at.elapsed().as_millis()),
                );
            }
            if let Some(state) = stream.latest_state.clone() {
                let turn_source = matches!(state.source.as_str(), "hook" | "adapter");
                saw_turn_source |= turn_source;
                match state.state.as_str() {
                    "needs_input" => {
                        return Ok(self.settle(
                            session_id,
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
                        return Ok(self.settle(
                            session_id,
                            "exited",
                            &state.source,
                            &state.confidence,
                            state.evidence.unwrap_or_else(|| "status reported exited".into()),
                            &stream,
                            started,
                        ))
                    }
                    "idle" if turn_source => {
                        return Ok(self.settle(
                            session_id,
                            "idle",
                            &state.source,
                            &state.confidence,
                            state.evidence.unwrap_or_else(|| "turn boundary reported".into()),
                            &stream,
                            started,
                        ))
                    }
                    _ => {}
                }
            }

            // Only a Shell has "silence means the command finished". For a
            // coding Agent silence is equally consistent with a trust prompt
            // and with a model thinking, so the caller gets its honestly
            // labelled timeout instead of a guess.
            let working = stream
                .latest_state
                .as_ref()
                .is_some_and(|state| state.state == "working");
            if summary.adapter_type == "shell" && !saw_turn_source && !working {
                if let Some(at) = stream.last_activity_at().or(Some(watching_since)) {
                    if at.elapsed() >= QUIET_SHELL {
                        return Ok(self.settle(
                            session_id,
                            "idle",
                            "quiet_window",
                            "low",
                            format!(
                                "Generic Shell command finished; quiet for {}ms",
                                at.elapsed().as_millis()
                            ),
                            &stream,
                            started,
                        ));
                    }
                }
            }

            // A trust or login screen is the CLI asking the user a question. It
            // has no hook and no status event, so it is read from the rendered
            // tail — checked on a slow cadence because it costs a replay.
            if last_dialog_check.elapsed() >= DIALOG_CHECK {
                last_dialog_check = Instant::now();
                if let Some(dialog) = self
                    .peek_tail(session_id)
                    .and_then(|tail| detect_blocking_prompt(&tail).map(str::to_string))
                {
                    return Ok(self.settle(
                        session_id,
                        "needs_input",
                        "screen_pattern",
                        "medium",
                        format!("the CLI is waiting on a trust or login prompt ({dialog})"),
                        &stream,
                        started,
                    ));
                }
            }

            if Instant::now() >= deadline {
                return Ok(self.settle(
                    session_id,
                    "timeout",
                    "watchdog",
                    "low",
                    format!("no turn boundary within {timeout_ms}ms"),
                    &stream,
                    started,
                ));
            }
        }
    }

    /// Settle with a tail the caller can actually read.
    ///
    /// The live stream only carries what this call happened to observe; the
    /// prompt echo and a fast answer are often already behind it. A bounded
    /// replay of the Host tail is the authoritative "what does the terminal
    /// show now", so the verdict and the evidence travel together.
    #[allow(clippy::too_many_arguments)]
    fn settle(
        &mut self,
        session_id: &str,
        state: &'static str,
        source: &str,
        confidence: &str,
        evidence: String,
        stream: &StreamState,
        started: Instant,
    ) -> WaitOutcome {
        let mut outcome = settle(state, source, confidence, evidence, stream, started);
        if let Ok(replay) = self.read_output(session_id, text::WAIT_TAIL_BYTES) {
            if !replay.text.trim().is_empty() {
                outcome.tail = replay.text;
                outcome.incomplete |= replay.incomplete;
            }
        }
        outcome
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
pub struct PromptDelivery {
    pub bytes: u64,
    /// A turn actually started, i.e. the prompt was accepted and submitted.
    pub submitted: bool,
    /// The screen changed after Enter. True for a paste echo *and* for a menu
    /// dialog, which is why it cannot stand in for `submitted`.
    pub redrew: bool,
    pub enter_retries: u32,
    /// Recognized trust/login prompt that has to be answered first.
    pub blocked_on: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmitEvidence {
    Started,
    RedrewOnly,
    Silent,
}

pub struct ReadOutcome {
    pub text: String,
    pub truncated: bool,
    pub bytes: u64,
    pub ended: bool,
    /// The Host reported a gap; the returned text is not a complete window.
    pub incomplete: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_prompts_are_recognized_from_real_screens() {
        // Kimi Code and Qoder ask before trusting a new project folder.
        assert_eq!(
            detect_blocking_prompt("  Trust this folder?\n  ↑↓ navigate · Enter select"),
            Some("trust this folder")
        );
        assert_eq!(
            detect_blocking_prompt("❯ 1. Trust folder\n  2. Don't trust and exit"),
            Some("trust folder")
        );
        // Grok Build asks for a browser sign-in when it has no session.
        assert_eq!(
            detect_blocking_prompt("Approve in your browser to finish signing in. V7C4-JDCN"),
            Some("approve in your browser")
        );
        // A TUI that draws words with cursor positioning can lose the spaces.
        assert_eq!(
            detect_blocking_prompt("❯1.Trustfolder\n 2.Don'ttrustandexit"),
            Some("trust folder")
        );
        assert_eq!(
            detect_blocking_prompt("│  Use arrow keys to navigate, Enter to select"),
            Some("use arrow keys to navigate")
        );
        // Ordinary agent output must never be mistaken for a dialog.
        assert_eq!(detect_blocking_prompt("❯ fix the failing test\n⏺ done"), None);
        assert_eq!(detect_blocking_prompt("trustworthiness is not a dialog"), None);
    }
}
