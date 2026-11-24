//! Session plumbing shared by the tools: attachments, stream accumulation and
//! the two bounded waits (launch readiness and task completion).
//!
//! Everything here reuses `agentport-service`, so MCP Sessions behave exactly
//! like Sessions created by the desktop app or by a phone: same Host, same
//! process-group cleanup, same status evidence.

use agentport_remote_protocol::{
    RunCursor, SessionAttachParams, SessionControlKind, SessionControlParams, SessionDetachParams,
    SessionInputParams, SessionPollParams, SessionStopParams, SessionStructuredPromptParams,
};
use agentport_service::{
    RemoteService, ServiceError, SessionAttachResult, SessionEvent, SessionPollResult,
    SessionSummary,
};
use base64::Engine as _;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// Upper bound for one synchronous tool call's completion wait.
///
/// The stdio server handles one request at a time. Keep this below the common
/// 60-second MCP client deadline so a long turn returns a structured `timeout`
/// that the caller can continue with another wait instead of becoming an
/// unobservable transport outcome.
pub const MAX_WAIT_MS: u64 = 45_000;
/// Default stays below a typical MCP client request timeout (60 s). Long turns
/// must be continued with another `wait_for_task` call; the baseline remains
/// live until a real turn boundary is observed.
pub const DEFAULT_WAIT_MS: u64 = 45_000;
/// Gap between the prompt text and its Enter keypress. See `deliver_prompt`.
const ENTER_GAP: Duration = Duration::from_millis(150);
/// How long to watch for evidence that the prompt actually started a turn.
const SUBMIT_EVIDENCE: Duration = Duration::from_millis(1_500);
/// A TUI can paint its frame before its composer exists; type again after this.
const TYPE_RETRY_GAP: Duration = Duration::from_millis(600);
const MAX_TYPE_ATTEMPTS: u32 = 4;
/// How long the typed text has to show up before the write is declared lost.
///
/// This is the budget that prevents duplicate pastes: while it is running we
/// have no right to retype, because the TUI may simply not have painted yet
/// (codex 0.172 takes over a second on a cold start).
const TEXT_EVIDENCE_WINDOW: Duration = Duration::from_millis(3_500);
const TEXT_EVIDENCE_POLL: Duration = Duration::from_millis(150);
/// Backspaces are sent in small batches so a TUI repaints between them.
const CLEAR_INPUT_GAP: Duration = Duration::from_millis(20);
/// Upper bound for one manual `clear_input`; a leftover prompt is at most a few
/// thousand characters, and this also bounds what a caller can spray at a TUI.
pub const MAX_CLEAR_CHARS: usize = 4_000;
/// How long a `process`-only status is treated as "still starting".
const STARTUP_GRACE: Duration = Duration::from_millis(6_000);
const MAX_ENTER_RETRIES: u32 = 2;
/// Quiet window after the Shell prompt returns. The prompt proves the command
/// ended; the quiet period avoids returning while the terminal is still
/// repainting.
const QUIET_SHELL: Duration = Duration::from_millis(4_000);
/// Quiet window for a coding Agent that never reported a turn boundary. Models
/// routinely think for many seconds without a byte of output, so this only
/// produces an `unknown` verdict, never "done".
/// Quiet window used to decide a freshly launched TUI finished painting.
///
/// 500 ms was too eager: Qoder paints its prompt box and then keeps loading
/// MCP servers, so a prompt typed at "quiet" landed nowhere. Input is also
/// verified after typing, so this only has to be generous, not perfect.
const QUIET_READY: Duration = Duration::from_millis(1_200);
/// Cadence for scanning the rendered screen for trust/login prompts.
const DIALOG_CHECK: Duration = Duration::from_millis(1_500);
/// A finished turn's transcript line can lag the completion hook slightly.
/// Longer than one model repaint: codex 0.172 notifies completion after the
/// first response of a multi-step turn, so the answer can arrive many seconds
/// after the hook that claimed the turn was over.
const REPLY_SETTLE_ATTEMPTS: usize = 6;
const REPLY_SETTLE_GAP: Duration = Duration::from_millis(500);
/// How long the bottom of the screen must stop advertising an active turn
/// before a contradicted completion signal may be believed.
const SCREEN_QUIET_AFTER_CONTRADICTION: Duration = Duration::from_millis(4_000);
pub const DEFAULT_READY_MS: u64 = 25_000;
/// Readiness budget for `send_prompt` on a Session that is still starting. It is
/// shorter than a launch budget because the caller is mid-conversation.
pub const SEND_READY_MS: u64 = 15_000;

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
    // Self-update and confirmation modals. A stray Enter here answers the
    // dialog — codex 0.172 offers "1. Update now / 2. Skip", and a first
    // prompt's Enter once upgraded the CLI instead of submitting it.
    "update available!",
    "update now (runs",
    "skip until next version",
    "a new version is available",
    "restart codex to apply",
    "restart to apply the update",
    "press enter to continue",
    "press enter to retry",
    "continue? (y/n)",
];

/// First recognizable blocking prompt in a rendered tail, if any.
///
/// Matching is done twice: once verbatim and once with all whitespace removed,
/// because full-screen TUIs often draw words with cursor positioning and the
/// captured tail can arrive as `1.Trustfolder`.
pub fn detect_blocking_prompt(tail: &str) -> Option<&'static str> {
    if let Some(pattern) = match_pattern(tail, BLOCKING_PROMPT_PATTERNS) {
        return Some(pattern);
    }
    detect_choice_menu(tail)
}

/// A modal list with a highlighted option is a question, whatever it asks.
///
/// Codex, Claude and Qoder all draw their menus the same way: several numbered
/// rows, one of them marked with a selection glyph. The marker is what keeps an
/// Agent's own numbered prose (a plan, a changelog) from looking like a dialog.
fn detect_choice_menu(tail: &str) -> Option<&'static str> {
    let lines: Vec<&str> = tail.lines().collect();
    let recent = &lines[lines.len().saturating_sub(16)..];
    let numbered = recent.iter().filter(|line| is_numbered_option(line)).count();
    let marked = recent
        .iter()
        .any(|line| is_numbered_option(line) && has_selection_marker(line));
    (numbered >= 2 && marked).then_some("a numbered choice menu owns the keyboard")
}

fn is_numbered_option(line: &str) -> bool {
    let trimmed = line.trim_start_matches(|c: char| c.is_whitespace());
    let rest = trimmed
        .trim_start_matches(|c: char| matches!(c, '›' | '>' | '▸' | '❯' | '●' | '*' | '-'));
    let rest = rest.trim_start();
    let mut chars = rest.chars();
    matches!(chars.next(), Some(digit) if digit.is_ascii_digit())
        && matches!(chars.next(), Some('.') | Some(')'))
        && chars.next().is_some_and(|c| c == ' ' || c == '\t')
}

fn has_selection_marker(line: &str) -> bool {
    line.trim_start()
        .starts_with(|c: char| matches!(c, '›' | '▸' | '❯' | '●'))
}

/// The Agent is visibly still working.
///
/// Every full-screen Agent TUI advertises how to stop it while a turn runs
/// (`esc to interrupt`, `ctrl+c to interrupt`) and drops that affordance when
/// the turn ends. That makes it a far better completion oracle than a provider
/// notification: codex 0.172 fires its `agent-turn-complete` notifier after the
/// first model response of a multi-step turn, while the screen still says
/// `Working (7s · esc to interrupt)`.
const ACTIVE_WORK_PATTERNS: &[&str] = &[
    "esc to interrupt",
    "esc to cancel",
    "esc to stop",
    "ctrl+c to interrupt",
    "ctrl-c to interrupt",
    "press esc to interrupt",
    "working (",
    "working…",
    "thinking (",
];

pub fn detect_active_work(tail: &str) -> Option<&'static str> {
    // Only the bottom of the screen: that is where every TUI paints its busy
    // row, and an Agent's own prose must never be mistaken for one.
    let lines: Vec<&str> = tail.lines().collect();
    let recent = lines[lines.len().saturating_sub(12)..].join("\n");
    match_pattern(&recent, ACTIVE_WORK_PATTERNS)
}

fn match_pattern(tail: &str, patterns: &[&'static str]) -> Option<&'static str> {
    let lower = tail.to_ascii_lowercase();
    let squeezed = squeeze(&lower);
    patterns.iter().copied().find(|pattern| {
        lower.contains(*pattern) || squeezed.contains(&squeeze(pattern))
    })
}

/// Whitespace-free form of a rendered line, for matching text that a TUI may
/// have wrapped or drawn with cursor positioning.
fn squeeze(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Does a rendered screen or log contain our token, ignoring wraps?
///
/// A prompt is compared without whitespace on either side: a wide (CJK) prompt
/// wraps mid-character-run, so a literal per-line `contains` reports "missing"
/// for text that is plainly there — and "missing" is what licenses retyping.
fn contains_token(haystack: &str, token: &str) -> bool {
    let needle = squeeze(&token.to_ascii_lowercase());
    if needle.is_empty() {
        return true;
    }
    squeeze(&haystack.to_ascii_lowercase()).contains(&needle)
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
    /// Durable status position carried by Host state events. A wait with a
    /// prompt baseline must never settle on an older replayed state.
    pub mark: Option<StatusMark>,
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
                    let mark = event
                        .payload
                        .get("run_ordinal")
                        .and_then(|value| value.as_i64())
                        .zip(event.payload.get("sequence").and_then(|value| value.as_i64()))
                        .map(|(run_ordinal, sequence)| StatusMark {
                            run_ordinal,
                            sequence,
                        });
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
                        mark,
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

/// A status without a durable mark cannot prove that it belongs to the turn
/// being waited for. That is safe for an unbaselined status query, but not for
/// a prompt-specific wait.
fn mark_is_fresh(mark: Option<StatusMark>, since: Option<StatusMark>) -> bool {
    since.is_none_or(|baseline| mark.is_some_and(|mark| mark.is_newer_than(baseline)))
}

/// Has this exact completion claim (or an older one) already been refuted?
fn mark_is_contradicted(mark: Option<StatusMark>, refuted: Option<StatusMark>) -> bool {
    match (mark, refuted) {
        (Some(mark), Some(refuted)) => !mark.is_newer_than(refuted),
        _ => false,
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
    /// The assistant's reply for this turn, when it could be read exactly.
    pub reply: Option<String>,
    pub reply_truncated: bool,
    pub reply_unavailable_reason: Option<String>,
    /// Where `tail` came from: `transcript`, `screen` or `stream`.
    pub tail_source: &'static str,
    /// Why the transcript was not used, when it was not.
    pub fallback_reason: Option<String>,
    /// The Host reported a gap, so `tail` is not a complete window.
    pub incomplete: bool,
    pub waited_ms: u128,
}

pub struct SessionOps {
    service: Arc<dyn RemoteService>,
    attachments: Attachments,
    /// Short fence from the latest prompt this MCP submitted. Native history
    /// can contain several turns; the fence prevents a previous answer from
    /// being returned as the current turn's reply.
    prompt_fences: HashMap<String, String>,
    batch_sequence: u64,
    wait_cancel: Option<Arc<AtomicBool>>,
}

impl SessionOps {
    pub fn new(service: Arc<dyn RemoteService>) -> Self {
        SessionOps {
            service,
            attachments: Attachments::default(),
            prompt_fences: HashMap::new(),
            batch_sequence: 0,
            wait_cancel: None,
        }
    }

    /// Let a background wait interrupt its bounded poll without waiting for
    /// the whole five-second worker quantum to elapse. Synchronous callers do
    /// not install a flag and retain the ordinary wait behavior.
    pub fn set_wait_cancel(&mut self, cancel: Arc<AtomicBool>) {
        self.wait_cancel = Some(cancel);
    }

    fn wait_was_cancelled(&self) -> bool {
        self.wait_cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
    }

    /// Remember enough of the prompt to identify its user event in native
    /// history without retaining the full task text in the MCP process.
    pub fn remember_prompt(&mut self, session_id: &str, prompt: &str) {
        let fence: String = prompt.chars().take(64).collect();
        self.prompt_fences.insert(session_id.to_string(), fence);
    }

    pub fn forget_prompt(&mut self, session_id: &str) {
        self.prompt_fences.remove(session_id);
    }

    /// Direct service access for tools that only query the service layer.
    pub fn service(&self) -> &dyn RemoteService {
        self.service.as_ref()
    }

    pub fn service_handle(&self) -> Arc<dyn RemoteService> {
        Arc::clone(&self.service)
    }

    pub fn prompt_fence(&self, session_id: &str) -> Option<String> {
        self.prompt_fences.get(session_id).cloned()
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

    /// Look up one Session, archived or not: internal callers (status, delete,
    /// ownership checks) must still find a Session the user archived.
    pub fn summary(&self, session_id: &str) -> TResult<SessionSummary> {
        let sessions = self.list_sessions(true)?;
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
        self.open_attachment_with(session_id, false)
    }

    /// `screen_snapshot` asks the Host for its serialized VT grid instead of a
    /// byte replay, which is what makes a full-screen TUI readable.
    fn open_attachment_with(
        &self,
        session_id: &str,
        screen_snapshot: bool,
    ) -> TResult<SessionAttachResult> {
        self.service
            .attach_session(SessionAttachParams {
                session_id: session_id.to_string(),
                replay_tail_bytes: if screen_snapshot { 0 } else { ATTACH_REPLAY_BYTES },
                resume_from: None,
                // The Host serializes the grid only for a client that also
                // subscribes to output (agentport-host/src/server.rs:317).
                subscribe_output: true,
                screen_snapshot,
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

    /// Type a prompt and submit it, proving each step where it can be proven.
    ///
    /// The text and the Enter keypress are written separately on purpose. A
    /// full-screen TUI receives one read per write, and Ink-based CLIs treat a
    /// multi-character read as a paste: when the trailing CR rides along with
    /// the text, the line is inserted and *never submitted* (observed with
    /// Claude Code). Writing them apart, then retrying Enter while no redraw
    /// appears, makes submission robust instead of a race against PTY packet
    /// boundaries.
    ///
    /// Three things can go wrong and each is checked instead of assumed: the
    /// text can be dropped because the TUI is still starting, the Enter can be
    /// swallowed, and a dialog can own the keyboard.
    ///
    /// The rule that keeps the composer clean: **the text is typed again only
    /// when nothing on the session shows the first write** — neither the
    /// rendered screen nor the session log. "I could not see it yet" is not
    /// evidence of a lost write; codex 0.172 needs over a second to paint a
    /// composer, and retyping on that guess pasted one 120-character prompt
    /// four times. Enter may be retried, because an empty composer ignores it.
    pub fn deliver_prompt(&mut self, session_id: &str, text: &str) -> TResult<PromptDelivery> {
        // A distinctive prefix identifies our own text in the composer echo.
        let token: String = text.trim().chars().take(10).collect();
        self.deliver_prompt_with_token(session_id, text, &token)
    }

    /// Deliver a prompt with a caller-supplied evidence token. Role preambles
    /// can scroll their prefix off a TUI screen, so use visible task text for
    /// submission proof rather than an off-screen preamble header.
    pub fn deliver_prompt_with_token(
        &mut self,
        session_id: &str,
        text: &str,
        evidence_token: &str,
    ) -> TResult<PromptDelivery> {
        let token: String = evidence_token.trim().chars().take(10).collect();
        let mut bytes = 0u64;
        let mut attempts = 0u32;
        let mut typed_times = 0u32;
        let mut entered = 0u32;
        let mut redrew = false;

        // A dialog that already owns the keyboard must not receive our text:
        // on a codex update menu that text plus an Enter answers "Update now".
        if let Some(dialog) = self.peek_blocking_prompt(session_id) {
            return Ok(PromptDelivery::blocked_on_dialog(dialog));
        }

        for attempt in 0..MAX_TYPE_ATTEMPTS {
            attempts = attempt + 1;
            // Flush the paint that arrived while we were waiting.
            let _ = self.drain(session_id);
            if !self.text_is_present(session_id, &token) {
                if typed_times > 0 {
                    // Our earlier write never showed up anywhere. Give the TUI
                    // the same gap an ordinary ready-gate wait uses.
                    std::thread::sleep(TYPE_RETRY_GAP);
                    let _ = self.drain(session_id);
                }
                bytes += self.send_bytes(session_id, text.as_bytes())?;
                typed_times += 1;
                std::thread::sleep(ENTER_GAP);
                if !self.wait_for_text(session_id, &token, TEXT_EVIDENCE_WINDOW) {
                    // Nothing on screen, nothing in the log: the bytes never
                    // reached a composer. Typing again is safe *because* no
                    // copy of the text exists anywhere on the session.
                    continue;
                }
            }
            if let Some(dialog) = self.peek_blocking_prompt(session_id) {
                return Ok(PromptDelivery {
                    bytes,
                    submitted: false,
                    redrew: false,
                    enter_retries: entered,
                    blocked_on: Some(dialog),
                    attempts,
                    text_visible: true,
                    cleaned: false,
                    leftover: true,
                });
            }
            if entered >= MAX_ENTER_RETRIES {
                break;
            }
            bytes += self.send_bytes(session_id, b"\r")?;
            entered += 1;
            match self.await_turn_start(session_id, &token)? {
                SubmitEvidence::Started => {
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: true,
                        redrew: true,
                        enter_retries: entered.saturating_sub(1),
                        blocked_on: None,
                        attempts,
                        text_visible: false,
                        cleaned: false,
                        leftover: false,
                    })
                }
                SubmitEvidence::RedrewOnly => {
                    // The screen changed without a turn starting: a dialog owns
                    // the keyboard, and another Enter could pick a menu item.
                    redrew = true;
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: false,
                        redrew,
                        enter_retries: entered.saturating_sub(1),
                        blocked_on: self.peek_blocking_prompt(session_id),
                        attempts,
                        text_visible: self.text_is_present(session_id, &token),
                        cleaned: false,
                        leftover: self.text_is_present(session_id, &token),
                    });
                }
                SubmitEvidence::Silent => {
                    // Enter was swallowed; the composer very likely still
                    // holds the text. Loop presses Enter again without typing.
                    std::thread::sleep(ENTER_GAP);
                }
            }
        }

        // Give up honestly. If nothing ever repainted, the CLI was deaf and
        // our text is sitting in its composer: delete exactly what we typed so
        // the next prompt is not concatenated onto it.
        let leftover = self.text_is_present(session_id, &token);
        let mut cleaned = false;
        if !redrew && leftover && typed_times > 0 {
            let characters = text.chars().count().saturating_mul(typed_times as usize);
            cleaned = self.clear_input(session_id, characters).is_ok();
        }
        Ok(PromptDelivery {
            bytes,
            submitted: false,
            redrew,
            enter_retries: entered.saturating_sub(1),
            blocked_on: self.peek_blocking_prompt(session_id),
            attempts,
            text_visible: leftover && !cleaned,
            cleaned,
            leftover: leftover && !cleaned,
        })
    }

    /// Deliver a one-shot handoff body without retyping it when the TUI hides
    /// pasted text behind a placeholder. Cursor, for example, renders pasted
    /// input as `[Pasted text #N ...]`, so the normal evidence check cannot see
    /// the submitted token and would paste the entire handoff four times. The
    /// body is written once; only Enter may be retried.
    pub fn deliver_prompt_once(
        &mut self,
        session_id: &str,
        text: &str,
        evidence_token: &str,
    ) -> TResult<PromptDelivery> {
        let token: String = evidence_token.trim().chars().take(10).collect();
        let mut bytes = self.send_bytes(session_id, text.as_bytes())?;
        std::thread::sleep(ENTER_GAP);
        let _ = self.drain(session_id);
        if let Some(dialog) = self.peek_blocking_prompt(session_id) {
            return Ok(PromptDelivery {
                bytes,
                submitted: false,
                redrew: false,
                enter_retries: 0,
                blocked_on: Some(dialog),
                attempts: 0,
                text_visible: true,
                cleaned: false,
                leftover: true,
            });
        }
        let mut redrew = false;
        for attempt in 0..=MAX_ENTER_RETRIES {
            bytes += self.send_bytes(session_id, b"\r")?;
            match self.await_turn_start(session_id, &token)? {
                SubmitEvidence::Started => {
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: true,
                        redrew: true,
                        enter_retries: attempt,
                        blocked_on: None,
                        attempts: attempt + 1,
                        text_visible: false,
                        cleaned: false,
                        leftover: false,
                    })
                }
                SubmitEvidence::RedrewOnly => {
                    redrew = true;
                    return Ok(PromptDelivery {
                        bytes,
                        submitted: false,
                        redrew,
                        enter_retries: attempt,
                        blocked_on: self.peek_blocking_prompt(session_id),
                        attempts: attempt + 1,
                        text_visible: self.text_is_present(session_id, &token),
                        cleaned: false,
                        leftover: self.text_is_present(session_id, &token),
                    })
                }
                SubmitEvidence::Silent if attempt < MAX_ENTER_RETRIES => {
                    std::thread::sleep(ENTER_GAP);
                }
                SubmitEvidence::Silent => {}
            }
        }
        let leftover = self.text_is_present(session_id, &token);
        let mut cleaned = false;
        if !redrew && leftover {
            let characters = text.chars().count();
            cleaned = self.clear_input(session_id, characters).is_ok();
        }
        Ok(PromptDelivery {
            bytes,
            submitted: false,
            redrew,
            enter_retries: MAX_ENTER_RETRIES,
            blocked_on: self.peek_blocking_prompt(session_id),
            attempts: MAX_ENTER_RETRIES + 1,
            text_visible: leftover && !cleaned,
            cleaned,
            leftover: leftover && !cleaned,
        })
    }

    /// Is this Session still inside its startup window?
    ///
    /// Paint is not a readiness signal (Qoder draws its frame, then loads MCP
    /// servers). The Agent's own status is: while it is absent or still a spawn
    /// fact (`process`), input can fall into a composer that does not exist yet.
    pub fn is_starting(&mut self, session_id: &str) -> bool {
        match self.summary(session_id) {
            Ok(summary) => match summary.latest_status {
                Some(status) => status.source == "process",
                None => true,
            },
            Err(_) => true,
        }
    }

    /// Is our text on the session right now — in the composer, or in the log?
    ///
    /// The screen is the direct witness for a TUI whose composer is still
    /// initialising; the accumulated log covers Sessions whose screen cannot be
    /// serialized. Both are consulted, because "not visible" is the one answer
    /// that must not be guessed: it is what licenses typing the text a second
    /// time.
    ///
    /// Matching ignores whitespace on both sides. A wrapped CJK prompt splits
    /// its first characters across two rendered rows, so a literal `contains`
    /// on a single row reports "missing" for text that is plainly on screen —
    /// the 600 ms retry then pasted the whole prompt twice.
    fn text_is_present(&mut self, session_id: &str, token: &str) -> bool {
        if token.is_empty() {
            return true;
        }
        if let Ok(screen) = self.read_screen(session_id, text::DEFAULT_READ_LINES) {
            if screen.source == "screen" && contains_token(&screen.text(), token) {
                return true;
            }
        }
        self.peek_stream(session_id)
            .is_some_and(|tail| contains_token(&tail, token))
    }

    /// Wait until the text we typed is visible somewhere.
    ///
    /// Fixed sleeps are the wrong tool here: codex 0.172 needs well over a
    /// second to paint its composer, so a short sleep followed by "retype" is
    /// exactly how a prompt ended up pasted four times. Poll instead.
    fn wait_for_text(&mut self, session_id: &str, token: &str, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            let _ = self.drain(session_id);
            if self.text_is_present(session_id, token) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(TEXT_EVIDENCE_POLL);
        }
    }

    /// Delete what we typed into the composer without submitting it.
    ///
    /// Backspace is the only editing key every Agent composer shares: Ctrl-U,
    /// Ctrl-K and ESC all mean something different per CLI, and on codex an
    /// idle Ctrl-C is "quit". The count is bounded and the cursor sits at the
    /// end of our own text, so the keystrokes only remove characters that this
    /// MCP typed.
    pub fn clear_input(&mut self, session_id: &str, characters: usize) -> TResult<u64> {
        const CHUNK: usize = 32;
        let mut sent = 0u64;
        let mut remaining = characters.min(MAX_CLEAR_CHARS);
        while remaining > 0 {
            let batch = remaining.min(CHUNK);
            let mut bytes = vec![0x7f_u8; batch];
            bytes.shrink_to_fit();
            sent += self.send_bytes(session_id, &bytes)?;
            remaining -= batch;
            std::thread::sleep(CLEAR_INPUT_GAP);
        }
        let _ = self.drain(session_id);
        Ok(sent)
    }

    fn peek_blocking_prompt(&mut self, session_id: &str) -> Option<String> {
        self.peek_screen(session_id)
            .and_then(|tail| detect_blocking_prompt(&tail).map(str::to_string))
    }

    fn shell_prompt_after_prompt(&mut self, session_id: &str, stream: &StreamState) -> bool {
        let Some(fence) = self.prompt_fences.get(session_id).cloned() else {
            return false;
        };
        if shell_prompt_after_fence(&stream.tail, &fence) {
            return true;
        }
        self.read_screen(session_id, text::DEFAULT_READ_LINES)
            .ok()
            .is_some_and(|screen| {
                screen.source == "screen" && shell_prompt_after_fence(&screen.text(), &fence)
            })
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
                    .peek_stream(session_id)
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

    /// Is the bottom of the screen still advertising an active turn?
    ///
    /// Cached for a moment because every read replays the Host grid; a wait
    /// loop asks several times per second and the answer cannot change faster
    /// than a repaint.
    fn active_work_on_screen(
        &mut self,
        session_id: &str,
        cache: &mut Option<(Instant, Option<String>)>,
    ) -> Option<String> {
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_millis(700) {
                return value.clone();
            }
        }
        let value = self
            .peek_screen(session_id)
            .and_then(|tail| detect_active_work(&tail).map(str::to_string));
        *cache = Some((Instant::now(), value.clone()));
        value
    }

    /// Current screen text. Dialogs and menus are screen facts, so this is the
    /// right oracle for "is the CLI asking me something".
    fn peek_screen(&mut self, session_id: &str) -> Option<String> {
        let outcome = self.read_screen(session_id, text::DEFAULT_READ_LINES).ok()?;
        (!outcome.lines.is_empty()).then(|| outcome.text())
    }

    /// Accumulated log tail. The echo of a submitted prompt lives here even
    /// after the screen scrolls or a redraw overwrites it, so submission
    /// evidence uses the stream rather than the grid.
    fn peek_stream(&mut self, session_id: &str) -> Option<String> {
        let outcome = self.read_stream(session_id, None, text::DEFAULT_READ_LINES).ok()?;
        (!outcome.lines.is_empty()).then(|| outcome.text())
    }

    pub fn structured_prompt(&mut self, session_id: &str, text: &str) -> TResult<()> {
        let attachment_id = self.attach(session_id)?;
        self.service
            .structured_prompt(SessionStructuredPromptParams {
                attachment_id,
                text: zeroize::Zeroizing::new(text.to_owned()),
            })
            .map_err(ToolFailure::from)
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

    /// Is the CLI visibly working right now?
    ///
    /// Used to decide whether an interrupt is safe: Ctrl-C is also "quit" for
    /// an idle Agent TUI (codex exits), so a cancel must have evidence that a
    /// turn is actually in flight.
    pub fn active_work(&mut self, session_id: &str) -> TResult<Option<String>> {
        Ok(self
            .peek_screen(session_id)
            .and_then(|tail| detect_active_work(&tail).map(str::to_string)))
    }

    /// Rendered screen text, when the Host can serialize one.
    pub fn screen_text(&mut self, session_id: &str) -> TResult<Option<String>> {
        let outcome = self.read_screen(session_id, text::DEFAULT_READ_LINES)?;
        Ok((outcome.source == "screen" && !outcome.lines.is_empty()).then(|| outcome.text()))
    }

    /// Is a Generic Shell waiting at its prompt, i.e. is nothing running?
    ///
    /// A Shell has no turn hook, but its prompt is proof that the previous
    /// command returned — the same evidence `wait_for_task` uses.
    pub fn shell_prompt_present(&mut self, session_id: &str) -> TResult<bool> {
        let text = match self.screen_text(session_id)? {
            Some(text) => text,
            None => self.peek_stream(session_id).unwrap_or_default(),
        };
        Ok(text
            .lines()
            .rev()
            .take(8)
            .any(|line| is_shell_prompt_line(line)))
    }

    /// The dialog that currently owns the keyboard, if any.
    pub fn blocking_dialog(&mut self, session_id: &str) -> TResult<Option<String>> {
        Ok(self.peek_blocking_prompt(session_id))
    }

    /// Does the Session still have a live Host and a live attachment?
    ///
    /// A registry row can lag a process that is already gone, so this asks the
    /// Host to serve one poll instead of trusting the projection.
    pub fn probe_alive(&mut self, session_id: &str) -> bool {
        match self.poll(session_id, 8, 0) {
            Ok(result) => !result.closed,
            Err(_) => {
                self.detach(session_id);
                false
            }
        }
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
            if poll.closed {
                self.detach(session_id);
            }
            if let Some(exit) = stream.exit.clone() {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: format!("Agent exited during startup ({:?})", exit.code),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                    blocked_on: None,
                });
            }
            if self.is_terminal(session_id)? {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: "Session ended during startup".into(),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                    blocked_on: None,
                });
            }
            let quiet_ready = stream.wrote_output
                && stream
                    .last_output_at
                    .map(|at| at.elapsed())
                    .unwrap_or_default()
                    >= QUIET_READY
                && {
                    let strict = started.elapsed() < STARTUP_GRACE;
                    !(strict
                        && self
                            .summary(session_id)
                            .ok()
                            .and_then(|summary| summary.latest_status)
                            .is_some_and(|status| status.source == "process"))
                };
            let idle_ready = stream
                .latest_state
                .as_ref()
                .is_some_and(|state| state.state == "idle")
                && stream.wrote_output;
            if idle_ready || quiet_ready {
                // Quiet is not readiness when the CLI is asking a question: a
                // modal menu (codex's "1. Update now / 2. Skip") is perfectly
                // quiet, and the Enter meant for a prompt answers it instead.
                if let Some(dialog) = self.peek_blocking_prompt(session_id) {
                    return Ok(ReadyOutcome {
                        ready: false,
                        reason: format!("the CLI is showing a dialog ({dialog})"),
                        state: stream.latest_state.clone(),
                        tail: stream.tail_text(),
                        blocked_on: Some(dialog),
                    });
                }
                return Ok(ReadyOutcome {
                    ready: true,
                    reason: if idle_ready {
                        "status reported idle".into()
                    } else {
                        format!(
                            "terminal quiet for {}ms",
                            stream
                                .last_output_at
                                .map(|at| at.elapsed().as_millis())
                                .unwrap_or_default()
                        )
                    },
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                    blocked_on: None,
                });
            }
            if Instant::now() >= deadline {
                return Ok(ReadyOutcome {
                    ready: false,
                    reason: format!("no quiet window within {timeout_ms}ms"),
                    state: stream.latest_state.clone(),
                    tail: stream.tail_text(),
                    blocked_on: None,
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
    /// 4. terminal quiet after a returned shell prompt — for a Generic Shell
    ///    only, where the prompt proves the command finished.
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
        let mut last_shell_prompt_check = Instant::now();
        let mut shell_prompt_returned = false;
        // A provider's "turn complete" is a claim, not proof: codex 0.172
        // notifies after its first model response while the TUI still shows
        // `esc to interrupt`. The screen is the witness that can refute it.
        let mut busy_cache: Option<(Instant, Option<String>)> = None;
        let mut contradicted_idle = 0u32;
        let mut quiet_since: Option<Instant> = None;
        // The status mark whose completion claim the screen refuted. It must
        // never settle this wait afterwards, however briefly the screen looks
        // quiet: a refuted claim cannot become true by being asked twice.
        let mut contradicted_through: Option<StatusMark> = None;
        loop {
            if self.wait_was_cancelled() {
                return Err(ToolFailure::new(
                    "wait_cancelled",
                    "background wait was cancelled",
                ));
            }
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
            let attention_fresh = summary.latest_status.as_ref().is_some_and(|status| {
                mark_is_fresh(
                    Some(StatusMark {
                        run_ordinal: status.run_ordinal,
                        sequence: status.sequence,
                    }),
                    since,
                )
            });
            if attention == Some("approval_requested") && attention_fresh {
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
                let fresh = mark_is_fresh(Some(mark), since);
                let turn_source = matches!(status.source.as_str(), "hook" | "adapter");
                saw_turn_source |= turn_source;
                match status.state.as_str() {
                    "needs_input" if fresh => {
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
                    "exited" if fresh => {
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
                    // completion classifier, whatever its state source. An
                    // older idle/attention status is only the pre-prompt
                    // baseline and must not settle this turn.
                    "idle"
                        if fresh
                            && !mark_is_contradicted(Some(mark), contradicted_through)
                            && (attention == Some("turn_completed")
                                || turn_source
                                // No prompt is pending and nothing moved since we
                                // attached: the caller is asking about a turn that
                                // is already over.
                                || (since.is_none() && stream.latest_state.is_none())) =>
                    {
                        let evidence = if attention == Some("turn_completed") {
                            "turn completion reported after the prompt".to_string()
                        } else if since.is_some() && fresh {
                            "status moved to idle after the prompt".to_string()
                        } else {
                            "status was already idle and no prompt is pending".to_string()
                        };
                        if let Some(busy) = self.active_work_on_screen(session_id, &mut busy_cache)
                        {
                            contradicted_idle += 1;
                            contradicted_through = Some(match contradicted_through {
                                Some(previous) if previous.is_newer_than(mark) => previous,
                                _ => mark,
                            });
                            quiet_since = None;
                            if wait_trace_enabled() {
                                eprintln!(
                                    "wait_trace ignored idle from {}: screen still shows {busy:?}",
                                    status.source
                                );
                            }
                        } else {
                            return Ok(self.settle(
                                session_id,
                                "idle",
                                &status.source,
                                &status.confidence,
                                evidence,
                                &stream,
                                started,
                            ));
                        }
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
            if self.wait_was_cancelled() {
                return Err(ToolFailure::new(
                    "wait_cancelled",
                    "background wait was cancelled",
                ));
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
                let fresh = mark_is_fresh(state.mark, since);
                saw_turn_source |= turn_source;
                match state.state.as_str() {
                    "needs_input" if fresh => {
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
                    "exited" if fresh => {
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
                    "idle"
                        if turn_source
                            && fresh
                            && !mark_is_contradicted(state.mark, contradicted_through) =>
                    {
                        if let Some(busy) = self.active_work_on_screen(session_id, &mut busy_cache)
                        {
                            contradicted_idle += 1;
                            if let Some(mark) = state.mark {
                                contradicted_through = Some(match contradicted_through {
                                    Some(previous) if previous.is_newer_than(mark) => previous,
                                    _ => mark,
                                });
                            }
                            quiet_since = None;
                            if wait_trace_enabled() {
                                eprintln!(
                                    "wait_trace ignored stream idle from {}: screen shows {busy:?}",
                                    state.source
                                );
                            }
                        } else {
                            return Ok(self.settle(
                                session_id,
                                "idle",
                                &state.source,
                                &state.confidence,
                                state.evidence.unwrap_or_else(|| "turn boundary reported".into()),
                                &stream,
                                started,
                            ));
                        }
                    }
                    _ => {}
                }
            }

            // Only a Shell has a prompt that can prove its command returned.
            // Silence alone is not enough: `sleep 50` is still running even
            // though the PTY has been quiet for several seconds. Check the
            // current VT grid as well as the stream because a Shell prompt can
            // be painted without a durable output event.
            if summary.adapter_type == "shell"
                && !shell_prompt_returned
                && last_shell_prompt_check.elapsed() >= DIALOG_CHECK
            {
                last_shell_prompt_check = Instant::now();
                shell_prompt_returned = self.shell_prompt_after_prompt(session_id, &stream);
            }
            if summary.adapter_type == "shell" && !saw_turn_source && shell_prompt_returned
            {
                if let Some(at) = stream.last_activity_at().or(Some(watching_since)) {
                    if at.elapsed() >= QUIET_SHELL {
                        return Ok(self.settle(
                            session_id,
                            "idle",
                            "quiet_window",
                            "low",
                            format!(
                                "Generic Shell prompt returned; quiet for {}ms",
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
            // tail — checked on a slow cadence because it costs a replay. Do
            // not gate it on semantic working evidence: a provider can still
            // present a login/trust prompt after it has reported working.
            if !shell_prompt_returned && last_dialog_check.elapsed() >= DIALOG_CHECK {
                last_dialog_check = Instant::now();
                if let Some(dialog) = self
                    .peek_screen(session_id)
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

            // The completion signal was refuted. Once the Agent stops
            // advertising an active turn, the screen *is* the completion
            // evidence — but only after it has stayed quiet, so a repaint gap
            // between two tool calls cannot be mistaken for a finished turn.
            if contradicted_idle > 0 {
                match self.active_work_on_screen(session_id, &mut busy_cache) {
                    Some(_) => quiet_since = None,
                    None => {
                        let since = *quiet_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= SCREEN_QUIET_AFTER_CONTRADICTION {
                            return Ok(self.settle(
                                session_id,
                                "idle",
                                "screen",
                                "medium",
                                format!(
                                    "the Agent stopped showing an active turn after {contradicted_idle} premature completion signal(s)"
                                ),
                                &stream,
                                started,
                            ));
                        }
                    }
                }
            }

            if self.wait_was_cancelled() {
                return Err(ToolFailure::new(
                    "wait_cancelled",
                    "background wait was cancelled",
                ));
            }
            if Instant::now() >= deadline {
                return Ok(self.settle(
                    session_id,
                    "timeout",
                    "watchdog",
                    "low",
                    if contradicted_idle > 0 {
                        format!(
                            "no turn boundary within {timeout_ms}ms; {contradicted_idle} completion signal(s) were contradicted by the screen"
                        )
                    } else {
                        format!("no turn boundary within {timeout_ms}ms")
                    },
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
        // The answer first: the assistant's own text for this one turn. Tool
        // output and reasoning never reach it (the transcript layer drops both),
        // so the caller reads a reply, not a log.
        //
        // A completion hook fires before the provider has necessarily flushed
        // its transcript line, so the answer can be a few hundred milliseconds
        // late. Wait for it briefly rather than reporting an empty turn.
        for attempt in 0..REPLY_SETTLE_ATTEMPTS {
            if let Ok(reply) = self.read_reply(session_id, text::WAIT_TAIL_BYTES * 2) {
                if reply.is_available() {
                    outcome.tail = reply.text.clone();
                    outcome.reply = Some(reply.text);
                    outcome.reply_truncated = reply.truncated;
                    outcome.tail_source = reply.source;
                    return outcome;
                }
                if !reply.retryable {
                    outcome.reply_unavailable_reason = reply.unavailable_reason.clone();
                    outcome.fallback_reason = reply.unavailable_reason;
                    break;
                }
                outcome.reply_unavailable_reason = reply.unavailable_reason.clone();
                outcome.fallback_reason = reply.unavailable_reason;
            }
            if attempt + 1 < REPLY_SETTLE_ATTEMPTS {
                std::thread::sleep(REPLY_SETTLE_GAP);
            }
        }
        // Evidence fallbacks for a Session whose Agent keeps no readable
        // transcript (or has not written the turn yet): the screen, then bytes.
        if let Ok(screen) = self.read_screen(session_id, text::DEFAULT_READ_LINES) {
            let text = screen.text();
            if !text.trim().is_empty() {
                outcome.tail = text;
                outcome.tail_source = "screen";
                return outcome;
            }
        }
        if let Ok(stream) = self.read_stream(session_id, None, text::DEFAULT_READ_LINES) {
            let text = stream.text();
            if !text.trim().is_empty() {
                outcome.tail = text;
                outcome.tail_source = "stream";
                outcome.incomplete |= stream.incomplete;
            }
        }
        outcome
    }

    /// Read the newest terminal bytes. Replays the Host tail, so this works
    /// while the Session is running and after a Host restart.
    /// Read the Session's screen, projected from the Host's VT grid.
    ///
    /// This is the answer to full-screen TUIs: a serialized grid already has
    /// every overwrite resolved, so the caller gets what the user sees instead
    /// of a pile of redraw bytes. When the Host predates
    /// `terminal_snapshot_v1`, or could not serialize a grid, the result says so
    /// (`screen-unavailable`) rather than pretending a byte tail is a screen.
    pub fn read_screen(&mut self, session_id: &str, limit: usize) -> TResult<ReadOutcome> {
        let limit = limit.clamp(1, text::MAX_READ_LINES);
        if self.is_terminal(session_id)? {
            // The Host keeps the grid only while it runs; after that the record
            // lives in the Agent's own transcript.
            return Ok(ReadOutcome::ended());
        }
        let attachment = self.open_attachment_with(session_id, true)?;
        // A screen attach carries a grid, not a stream: read it once and release
        // it. It is deliberately kept out of the poll-attachment cache — evicting
        // the cached attachment here would make the next poll replay the log,
        // and that replay would keep refilling the quiet-window timer.
        let _ = self.service().detach_session(SessionDetachParams {
            attachment_id: attachment.attachment_id.clone(),
        });
        let Some(snapshot) = attachment.screen_snapshot else {
            return Ok(ReadOutcome::unavailable("screen-unavailable"));
        };
        let content = snapshot
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        // The grid is serialized as a full repaint: stripping the escape
        // sequences leaves the rows the terminal would draw.
        let rendered = text::render(content.as_bytes(), true);
        let mut lines: Vec<String> = rendered
            .split('\n')
            .map(|line| line.trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        let truncated = lines.len() > limit;
        if truncated {
            lines.drain(..lines.len() - limit);
        }
        Ok(ReadOutcome {
            source: "screen",
            returned_line_count: lines.len(),
            lines,
            truncated,
            limited: false,
            next_cursor: None,
            ended: false,
            incomplete: false,
        })
    }

    /// Read accumulated lines from the Host log, from an opaque cursor.
    ///
    /// Without a cursor this returns a bounded tail; with one it continues
    /// exactly after it, so a caller never stitches two unrelated windows
    /// together. `limited` says the Host could not honour the cursor (log
    /// rotation or a resync), which is not the same as "you asked for few lines".
    pub fn read_stream(
        &mut self,
        session_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> TResult<ReadOutcome> {
        let limit = limit.clamp(1, text::MAX_READ_LINES);
        let resume = match cursor {
            Some(cursor) => Some(decode_cursor(cursor)?),
            None => None,
        };
        if self.is_terminal(session_id)? {
            return Ok(ReadOutcome::ended());
        }
        self.detach(session_id);
        let attachment = self.service().attach_session(SessionAttachParams {
            session_id: session_id.to_string(),
            replay_tail_bytes: if resume.is_some() { 0 } else { ATTACH_REPLAY_BYTES },
            resume_from: resume.clone(),
            subscribe_output: true,
            screen_snapshot: false,
        })?;
        let attachment_id = attachment.attachment_id.clone();
        self.attachments.touch(session_id, &attachment_id);
        let mut stream = StreamState::default();
        let mut last_cursor = attachment.cursor.clone().or(resume);
        let mut limited = false;
        let mut idle_polls = 0;
        for _ in 0..12 {
            let poll = self.service().poll_session(SessionPollParams {
                attachment_id: attachment_id.clone(),
                limit: 256,
                wait_ms: 100,
            })?;
            let empty = poll.events.is_empty();
            for event in &poll.events {
                if event.event_type == "resync_required" {
                    limited = true;
                }
                last_cursor = Some(event.cursor.clone());
            }
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
        let mut lines: Vec<String> = stream
            .tail
            .split('\n')
            .map(|line| line.trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        let truncated = lines.len() > limit;
        if truncated {
            lines.drain(..lines.len() - limit);
        }
        Ok(ReadOutcome {
            source: "stream",
            returned_line_count: lines.len(),
            lines,
            truncated,
            limited,
            next_cursor: last_cursor.as_ref().map(encode_cursor),
            ended: stream.exit.is_some(),
            incomplete: stream.incomplete,
        })
    }

    /// The Agent's own transcript events, newest page first-in-file order.
    ///
    /// `history.page` with no cursor starts at the end of the newest source and
    /// scans backwards, so one call returns the most recent events without
    /// walking the whole conversation. Thinking blocks never reach this layer
    /// (the parser drops them) and tool results are excluded on request.
    pub fn read_transcript_events(
        &mut self,
        session_id: &str,
        limit: usize,
    ) -> TResult<TranscriptOutcome> {
        let params = serde_json::json!({
            "sessionId": session_id,
            "limit": limit.clamp(1, 200),
            "includeToolResults": false,
        });
        let page = match self.service().extended_facade("history.page", params) {
            Ok(page) => page,
            Err(error) => {
                return Ok(TranscriptOutcome {
                    available: false,
                    reason: Some(format!("{error:?}").chars().take(160).collect()),
                    events: Vec::new(),
                })
            }
        };
        let status = page
            .get("sourceStatus")
            .and_then(|status| status.get("status"))
            .and_then(|status| status.as_str())
            .unwrap_or("unavailable");
        if status != "available" {
            let reason = page
                .get("sourceStatus")
                .and_then(|status| status.get("reason"))
                .and_then(|reason| reason.as_str())
                .map(str::to_string)
                .or_else(|| Some(status.to_string()));
            return Ok(TranscriptOutcome {
                available: false,
                reason,
                events: Vec::new(),
            });
        }
        if wait_trace_enabled() {
            if let Some(events) = page.get("events").and_then(|events| events.as_array()) {
                for event in events {
                    eprintln!(
                        "history_event role={:?} kind={:?} answer={:?} text={:?}",
                        event.get("role").and_then(|value| value.as_str()),
                        event.get("kind").and_then(|value| value.as_str()),
                        event.get("answerText").and_then(|value| value.as_str()),
                        event
                            .get("text")
                            .and_then(|value| value.as_str())
                            .map(|text| text.chars().take(60).collect::<String>())
                    );
                }
            }
        }
        let events = page
            .get("events")
            .and_then(|events| events.as_array())
            .map(|events| {
                events
                    .iter()
                    .map(|event| {
                        let role = event
                            .get("role")
                            .and_then(|role| role.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let text = event
                            .get("text")
                            .and_then(|text| text.as_str())
                            .unwrap_or_default()
                            .to_string();
                        // A Host that predates `answerText` cannot separate an
                        // answer from a tool call; its assistant text is the best
                        // available prose. A Host that sends the field says so
                        // exactly, including "no prose in this message".
                        let answer_text = match event.get("answerText") {
                            Some(serde_json::Value::String(prose)) => Some(prose.clone()),
                            // An explicit null: the Host looked, and this event
                            // is not assistant prose.
                            Some(_) => Some(String::new()),
                            // No field at all: an older Host, whose assistant
                            // text is the only prose available.
                            None => (role == "assistant").then(|| text.clone()),
                        };
                        TranscriptEvent {
                            role,
                            kind: event
                                .get("kind")
                                .and_then(|kind| kind.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            text,
                            answer_text,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(TranscriptOutcome {
            available: true,
            reason: None,
            events,
        })
    }

    /// The Agent's reply to the prompt this turn, i.e. one conversational turn.
    ///
    /// Walks back from the newest event: assistant text is the reply, tool and
    /// system events are skipped, and the first user message is the boundary —
    /// that is the prompt we sent. Nothing about tool output or reasoning can
    /// leak into the answer because neither is an assistant text event.
    pub fn read_reply(&mut self, session_id: &str, max_bytes: usize) -> TResult<ReplyOutcome> {
        let Some(prompt_fence) = self.prompt_fences.get(session_id).cloned() else {
            return Ok(ReplyOutcome::unavailable(Some(
                "this MCP process has no submitted prompt fence for the Session".into(),
            )));
        };
        let transcript = self.read_transcript_events(session_id, 80)?;
        if !transcript.available {
            return Ok(ReplyOutcome::unavailable(transcript.reason));
        }
        let reply = last_assistant_turn(&transcript.events, Some(&prompt_fence));
        if reply.trim().is_empty() {
            return Ok(ReplyOutcome {
                text: String::new(),
                truncated: false,
                source: "transcript-unavailable",
                unavailable_reason: Some(
                    "the transcript has no assistant reply for this turn yet".into(),
                ),
                retryable: true,
            });
        }
        let (text, truncated) = text::head(&reply, max_bytes);
        Ok(ReplyOutcome {
            text,
            truncated,
            source: "transcript",
            unavailable_reason: None,
            retryable: false,
        })
    }

}

/// Opaque cursor: callers must round-trip it, never parse it.
fn encode_cursor(cursor: &RunCursor) -> String {
    let json = serde_json::to_vec(cursor).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_cursor(cursor: &str) -> TResult<RunCursor> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .map_err(|_| ToolFailure::new("invalid_cursor", "cursor is not a value this server issued"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ToolFailure::new("invalid_cursor", "cursor is not a value this server issued"))
}

fn shell_prompt_after_fence(tail: &str, fence: &str) -> bool {
    let Some(start) = tail.rfind(fence) else {
        return false;
    };
    tail[start + fence.len()..]
        .lines()
        .any(is_shell_prompt_line)
}

fn is_shell_prompt_line(line: &str) -> bool {
    let line = line.trim();
    let Some(marker) = line.chars().last() else {
        return false;
    };
    if !matches!(marker, '$' | '#' | '%') {
        return false;
    }
    let prefix = &line[..line.len() - marker.len_utf8()];
    !prefix.is_empty()
        && (prefix.starts_with("sh-")
            || prefix.starts_with("bash")
            || prefix.starts_with("zsh")
            || prefix.contains('@')
            || prefix.contains(':'))
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
        reply: None,
        reply_truncated: false,
        reply_unavailable_reason: None,
        tail_source: "stream",
        fallback_reason: None,
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
    /// A modal dialog owns the keyboard: the CLI is asking a question and an
    /// Enter sent for a prompt would answer it.
    pub blocked_on: Option<String>,
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
    /// How many type-and-submit rounds this delivery needed.
    pub attempts: u32,
    /// Our text is still visible on the session (normally: in the composer).
    pub text_visible: bool,
    /// The text this call typed was deleted again after a failed send.
    pub cleaned: bool,
    /// Text this MCP typed may still sit in the composer.
    pub leftover: bool,
}

impl PromptDelivery {
    /// A dialog owned the keyboard before anything was typed.
    pub fn blocked_on_dialog(dialog: String) -> PromptDelivery {
        PromptDelivery {
            bytes: 0,
            submitted: false,
            redrew: false,
            enter_retries: 0,
            blocked_on: Some(dialog),
            attempts: 0,
            text_visible: false,
            cleaned: false,
            leftover: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmitEvidence {
    Started,
    RedrewOnly,
    Silent,
}

pub struct ReadOutcome {
    /// Where these lines came from: `screen`, `stream` or `screen-unavailable`.
    pub source: &'static str,
    pub lines: Vec<String>,
    pub returned_line_count: usize,
    /// Older lines were dropped to honour `limit`.
    pub truncated: bool,
    /// The Host could not honour the cursor (rotation or resync).
    pub limited: bool,
    /// Opaque continuation for `source: "stream"`.
    pub next_cursor: Option<String>,
    pub ended: bool,
    /// The Host reported a gap; these lines are not a complete window.
    pub incomplete: bool,
}

impl ReadOutcome {
    fn unavailable(source: &'static str) -> ReadOutcome {
        ReadOutcome {
            source,
            lines: Vec::new(),
            returned_line_count: 0,
            truncated: false,
            limited: false,
            next_cursor: None,
            ended: false,
            incomplete: false,
        }
    }

    fn ended() -> ReadOutcome {
        ReadOutcome {
            ended: true,
            ..ReadOutcome::unavailable("screen-unavailable")
        }
    }

    /// Joined view for callers that only want text (and for the dialog checks).
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// One transcript event as the history layer exposes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptEvent {
    pub role: String,
    pub kind: String,
    /// The transcript line: includes tool-call summaries.
    pub text: String,
    /// Assistant prose only. `Some("")` means the Host looked and found none
    /// (a tool-only message, a tool result, a user prompt); `None` means the
    /// Host did not report prose at all, so `text` is all there is.
    pub answer_text: Option<String>,
}

/// Result of reading the Agent's own transcript.
pub struct TranscriptOutcome {
    pub available: bool,
    pub reason: Option<String>,
    pub events: Vec<TranscriptEvent>,
}

/// The assistant's answer for one conversational turn.
#[derive(Debug, Clone)]
pub struct ReplyOutcome {
    pub text: String,
    pub truncated: bool,
    pub source: &'static str,
    pub unavailable_reason: Option<String>,
    /// The transcript itself was readable; only the turn's answer was missing.
    /// That is worth a short retry, a missing transcript is not.
    pub retryable: bool,
}

impl ReplyOutcome {
    pub fn unavailable(reason: Option<String>) -> ReplyOutcome {
        ReplyOutcome {
            text: String::new(),
            truncated: false,
            source: "transcript-unavailable",
            unavailable_reason: reason,
            retryable: false,
        }
    }

    pub fn is_available(&self) -> bool {
        !self.text.trim().is_empty()
    }
}

/// Assistant text of the newest turn, reading the events backwards.
///
/// Only assistant *prose* counts. A transcript line mixes the Agent's words
/// with the tool calls it made ("Read {\"file_path\":...}"), and quoting that
/// as the answer is how a Qoder turn reported the tool summary as its reply.
fn last_assistant_turn(events: &[TranscriptEvent], prompt_fence: Option<&str>) -> String {
    let mut collected: Vec<&str> = Vec::new();
    let mut found_prompt = false;
    for event in events.iter().rev() {
        match event.role.as_str() {
            "assistant"
                if !event.kind.contains("tool") && !event.kind.contains("thinking") => {
                let prose = event
                    .answer_text
                    .as_deref()
                    .unwrap_or(event.text.as_str())
                    .trim();
                // An Agent that merely echoes the prompt has not answered it.
                let echoed = prompt_fence.is_some_and(|fence| {
                    let fence = squeeze(&fence.to_ascii_lowercase());
                    !fence.is_empty() && squeeze(&prose.to_ascii_lowercase()) == fence
                });
                if !prose.is_empty() && !echoed {
                    collected.push(prose);
                }
            }
            // Tool calls and results are not part of the answer, and they must
            // not end the walk: an agent that used tools still answered.
            "tool" => continue,
            "system" => continue,
            // The prompt we sent is the turn boundary. Without seeing it in
            // the bounded history page, collected text could be the previous
            // turn's answer and must not be returned as this turn's reply.
            "user" => {
                found_prompt = prompt_fence.is_none_or(|fence| event.text.contains(fence));
                break;
            }
            _ => continue,
        }
    }
    if !found_prompt {
        return String::new();
    }
    collected.reverse();
    collected.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_the_assistant_turn_not_the_log() {
        let event = |role: &str, kind: &str, text: &str| TranscriptEvent {
            role: role.into(),
            kind: kind.into(),
            text: text.into(),
            answer_text: (role == "assistant").then(|| text.to_string()),
        };
        // Previous turn, then our prompt, then a turn that used tools.
        let events = vec![
            event("user", "message", "older question"),
            event("assistant", "assistant", "older answer"),
            event("user", "message", "the prompt we sent"),
            event("tool", "tool", "Bash echo hi"),
            event("assistant", "assistant", "first part"),
            event("tool", "tool", "Bash npm test"),
            event("assistant", "message", "message-shaped answer"),
            event("assistant", "assistant", "final answer"),
        ];
        // Only this turn's assistant text, tool calls skipped, prompt excluded.
        assert_eq!(
            last_assistant_turn(&events, None),
            "first part\n\nmessage-shaped answer\n\nfinal answer"
        );
        // Our prompt is the newest event: the turn has not answered yet, so
        // there is no reply (never the previous turn's answer).
        assert_eq!(last_assistant_turn(&events[..3], None), "");
        let only_prompt = vec![event("user", "message", "prompt")];
        assert_eq!(last_assistant_turn(&only_prompt, None), "");
        // A page that starts after the prompt must not leak the previous
        // assistant answer as if it belonged to the current turn.
        assert_eq!(last_assistant_turn(&events[1..2], None), "");
        assert_eq!(
            last_assistant_turn(&events, Some("the prompt we sent")),
            "first part\n\nmessage-shaped answer\n\nfinal answer"
        );
        assert_eq!(last_assistant_turn(&events, Some("a different prompt")), "");
    }

    #[test]
    fn a_tool_call_or_a_prompt_echo_is_not_an_answer() {
        // Claude and Qoder keep the tool call in the same assistant message as
        // the answer. The transcript line shows both; the reply must be prose.
        let events = vec![
            TranscriptEvent {
                role: "user".into(),
                kind: "message".into(),
                text: "Read /tmp/x.md and answer".into(),
                answer_text: None,
            },
            TranscriptEvent {
                role: "assistant".into(),
                kind: "assistant".into(),
                text: "Read /tmp/x.md\n{\"file_path\":\"/tmp/x.md\"}".into(),
                answer_text: Some(String::new()),
            },
            TranscriptEvent {
                role: "assistant".into(),
                kind: "assistant".into(),
                text: "the real answer".into(),
                answer_text: Some("the real answer".into()),
            },
        ];
        assert_eq!(last_assistant_turn(&events, Some("Read /tmp/x.md")), "the real answer");
        // A turn that only produced a tool call has no reply yet; it must not
        // report the tool summary as if the Agent had said it.
        let tools_only = vec![
            TranscriptEvent {
                role: "user".into(),
                kind: "message".into(),
                text: "Read /tmp/x.md".into(),
                answer_text: None,
            },
            TranscriptEvent {
                role: "assistant".into(),
                kind: "assistant".into(),
                text: "Read /tmp/x.md".into(),
                answer_text: Some(String::new()),
            },
        ];
        assert_eq!(last_assistant_turn(&tools_only, Some("Read /tmp/x.md")), "");
        // An assistant message that is exactly the prompt is an echo, not an answer.
        let echo = vec![
            TranscriptEvent {
                role: "user".into(),
                kind: "message".into(),
                text: "Read /tmp/x.md and answer".into(),
                answer_text: None,
            },
            TranscriptEvent {
                role: "assistant".into(),
                kind: "assistant".into(),
                text: "Read  /tmp/x.md and answer".into(),
                answer_text: Some("Read  /tmp/x.md and answer".into()),
            },
        ];
        assert_eq!(
            last_assistant_turn(&echo, Some("Read /tmp/x.md and answer")),
            ""
        );
    }

    #[test]
    fn state_events_keep_their_durable_status_mark() {
        let mut stream = StreamState::default();
        stream.absorb(&[SessionEvent {
            event_type: "state".into(),
            cursor: RunCursor {
                run_id: "run_2".into(),
                run_ordinal: 2,
                generation: 0,
                offset: 0,
                status_sequence: 7,
            },
            payload: serde_json::json!({
                "run_ordinal": 2,
                "sequence": 7,
                "state": "idle",
                "source": "hook",
                "confidence": "high"
            }),
        }]);
        assert_eq!(
            stream.latest_state.as_ref().and_then(|state| state.mark),
            Some(StatusMark {
                run_ordinal: 2,
                sequence: 7
            })
        );
        assert!(mark_is_fresh(
            Some(StatusMark {
                run_ordinal: 2,
                sequence: 7
            }),
            Some(StatusMark {
                run_ordinal: 2,
                sequence: 6
            })
        ));
        assert!(!mark_is_fresh(
            Some(StatusMark {
                run_ordinal: 2,
                sequence: 6
            }),
            Some(StatusMark {
                run_ordinal: 2,
                sequence: 7
            })
        ));
        assert!(!mark_is_fresh(None, Some(StatusMark {
            run_ordinal: 2,
            sequence: 7
        })));
    }

    #[test]
    fn cursors_round_trip_and_reject_foreign_values() {
        let cursor = RunCursor {
            run_id: "run_1".into(),
            run_ordinal: 3,
            generation: 2,
            offset: 41_000,
            status_sequence: 7,
        };
        let encoded = encode_cursor(&cursor);
        // Opaque to callers: no plain JSON leaks the internals.
        assert!(!encoded.contains('{'));
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.run_id, "run_1");
        assert_eq!(decoded.offset, 41_000);
        let error = decode_cursor("not-a-cursor").unwrap_err();
        assert_eq!(error.code, "invalid_cursor");
    }

    #[test]
    fn read_outcome_joins_lines_and_reports_absence() {
        let outcome = ReadOutcome {
            source: "screen",
            lines: vec!["one".into(), "two".into()],
            returned_line_count: 2,
            ..ReadOutcome::unavailable("screen")
        };
        assert_eq!(outcome.text(), "one\ntwo");
        assert!(ReadOutcome::unavailable("screen-unavailable").lines.is_empty());
        assert!(ReadOutcome::ended().ended);
    }

    #[test]
    fn shell_completion_requires_a_prompt_after_the_command() {
        assert!(!shell_prompt_after_fence(
            "sh-3.2$ sleep 50; echo DONE\n",
            "sleep 50; echo DONE"
        ));
        assert!(shell_prompt_after_fence(
            "sh-3.2$ echo DONE\nDONE\nsh-3.2$\n",
            "echo DONE"
        ));
        assert!(is_shell_prompt_line("sh-3.2$"));
        assert!(is_shell_prompt_line("user@host:~/repo$"));
        assert!(!is_shell_prompt_line("DONE$ output"));
    }

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
        // A numbered plan in the Agent's own prose is not a menu: no option is
        // highlighted and no navigation hint is drawn.
        assert_eq!(
            detect_blocking_prompt("1. change the parser\n2. add a test\n3. commit"),
            None
        );
    }

    #[test]
    fn a_cli_update_menu_is_a_dialog() {
        // codex 0.172, verbatim from a real pane: the first prompt's Enter
        // picked "Update now" and upgraded the CLI mid-session.
        let screen = concat!(
            "  >_ OpenAI Codex (v0.171.0)\n",
            "  Update available! 0.171.0 -> 0.172.0\n",
            "› 1. Update now (runs `npm install -g @openai/codex`)\n",
            "  2. Skip\n",
            "  3. Skip until next version\n",
            "  Press enter to continue"
        );
        assert!(detect_blocking_prompt(screen).is_some());
        // Even without the explicit phrases, a marked numbered menu is a
        // question that owns the keyboard.
        let menu = "What should I do next?\n› 1. continue\n  2. stop\n  3. ask";
        assert_eq!(
            detect_blocking_prompt(menu),
            Some("a numbered choice menu owns the keyboard")
        );
    }

    #[test]
    fn active_work_is_read_from_the_bottom_of_the_screen() {
        let working = concat!(
            "› read the README\n",
            "\n",
            "• Working (7s • esc to interrupt)\n",
            "\n",
            "› Ask Codex to do anything"
        );
        assert_eq!(detect_active_work(working), Some("esc to interrupt"));
        // The finished turn drops the affordance.
        let done = concat!(
            "› read the README\n",
            "\n",
            "• # AgentPort PROBE-OK.\n",
            "\n",
            "  Worked for 6s • 00:19\n",
            "\n",
            "› Ask Codex to do anything"
        );
        assert_eq!(detect_active_work(done), None);
        // An Agent *talking* about interrupting itself is not a running turn:
        // only the bottom rows are considered.
        let quoted = concat!(
            "press esc to interrupt in most TUIs\n",
            "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n",
            "› next"
        );
        assert_eq!(detect_active_work(quoted), None);
    }

    #[test]
    fn wrapped_prompt_text_is_still_evidence() {
        // The same prompt, and the row a 40-column TUI wraps it into.
        let typed = "请你只用一句话回答：请先读取 README.md 的第一行";
        let screen = "› 请你只用一句话回答：请先读取 README.md 的第\n  一行，并包含 PROBE-OK";
        let token: String = typed.chars().take(10).collect();
        assert!(contains_token(screen, &token));
        assert!(!contains_token("› something else entirely", &token));
    }
}
