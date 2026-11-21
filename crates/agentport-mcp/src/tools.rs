//! Tool surface: JSON Schemas plus the dispatch that maps each tool onto
//! `agentport-service`.
//!
//! The surface is deliberately narrow. Everything destructive (git writes,
//! document writes, secret writes, worktree removal, archiving, settings) and
//! everything that could type into a Session the user is driving stays out of
//! v1: this is a delegation tool, not a remote control for the whole app.

use agentport_core::agent_roles::{AgentRole, AgentRoleMetadata};
use agentport_core::models::AgentType;
use agentport_remote_protocol::{
    AgentProbeAllParams, ProjectAddParams, RemoteAgentType, SessionCreateParams, SessionIdParams,
};
use agentport_service::{RemoteService, SessionSummary};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ops::{
    ReadyOutcome, SessionOps, StatusMark, TResult, ToolFailure, DEFAULT_READY_MS, DEFAULT_WAIT_MS,
    MAX_WAIT_MS, SEND_READY_MS,
};
use crate::registry::{OwnedSession, Registry, RoleSnapshot};
use crate::text;
use crate::ui;
use crate::wait_jobs::{
    JobState, WaitRegistry, WaitSpec, DEFAULT_WAIT_GROUP_TIMEOUT_MS, MAX_WAIT_GROUP_ITEMS,
    MAX_WAIT_GROUP_TIMEOUT_MS,
};

/// Keep a malformed or unexpectedly large batch from turning one synchronous
/// MCP request into an unbounded amount of work. Session creation itself still
/// uses the existing per-process live-session limit.
const MAX_BATCH_ITEMS: usize = 32;
/// Keep repeated waits idempotent without retaining one reply/tail per
/// historical Session for the lifetime of a long-lived MCP process.
const MAX_SETTLED_TURNS: usize = 64;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: fn() -> Value,
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "list_agents",
        description: "Which Agents you can delegate to right now. You do NOT need this before \
                      create_session: a wrong or unavailable agent id comes back with the \
                      selectable ids. Use it when the user asks what exists. probe=true re-detects \
                      (slower).",
        schema: list_agents_schema,
    },
    ToolDef {
        name: "list_roles",
        description: "List enabled Agent Role metadata when needed. Delegation tools also expose enabled Role name/description metadata directly; pass a chosen roleId or omit it.",
        schema: list_roles_schema,
    },
    ToolDef {
        name: "resolve_project",
        description: "Map a directory to a project id, registering it if it is unknown. Usually \
                      unnecessary: create_session resolves its project itself (and defaults to \
                      your working directory). Use it only to inspect where a path would land.",
        schema: resolve_project_schema,
    },
    ToolDef {
        name: "list_sessions",
        description: "List the Sessions this MCP created, with lifecycle, status evidence and host \
                      liveness. You do NOT need this before delegating — create_session returns the \
                      ids it made. Use it to find a Session you started earlier in this conversation.",
        schema: list_sessions_schema,
    },
    ToolDef {
        name: "session_status",
        description: "Status of one Session this MCP created, plus the tail of its status history (state, source, confidence, evidence). When a completed turn is available, completion includes the final reply so recovery does not require read_output.",
        schema: session_status_schema,
    },
    ToolDef {
        name: "create_session",
        description: "Create a Session for the given Agent in a project and, optionally, send the \
                      first prompt once the CLI is ready. The delegated Session runs in the \
                      Agent's own full-permission mode by default (no approval prompts, no \
                      sandbox bypass prompt); pass permission=native to keep the CLI's prompts. By \
                      default it also splits a new pane for the Session so the user can watch it. \
                      Returns the Session id. Sessions are owned by this MCP server: only they \
                      can be driven by the other tools.",
        schema: create_session_schema,
    },
    ToolDef {
        name: "create_sessions",
        description: "Create several independent delegated Sessions in one call. Each task is \
                      processed with the same readiness and prompt-submission checks as \
                      create_session; one task's error is returned in its item without discarding \
                      successful Sessions created earlier in the batch.",
        schema: create_sessions_schema,
    },
    ToolDef {
        name: "handoff",
        description: "Create a new split-pane Agent Session and delegate a complete Markdown handoff directly to it. This is a one-shot fire-and-forget handoff: it returns immediately and does not require wait_for_task or a wait group. No handoff document is written.",
        schema: handoff_schema,
    },
    ToolDef {
        name: "send_prompt",
        description: "Send one line of text (Enter appended) to a Session this MCP created. Escape \
                      and control sequences are rejected; use cancel_turn to stop a running turn.",
        schema: send_prompt_schema,
    },
    ToolDef {
        name: "wait_for_task",
        description: "Wait for exactly the current delegated turn and return its final assistant reply when it settles. Returns idle | needs_input | exited | timeout with source, confidence, evidence and reply. timeout is a structured continuation point (continuation/stillRunning/nextAction); call wait_for_task again for the same Session, and do not use read_output to decide completion. Each synchronous wait is capped below common client deadlines (default 45s).",
        schema: wait_for_task_schema,
    },
    ToolDef {
        name: "wait_for_tasks",
        description: "Wait for several MCP-owned Sessions in one call under one shared request budget. Each item preserves the same state, confidence, evidence, reply and output fallback fields as wait_for_task; an error for one item does not hide the other results.",
        schema: wait_for_tasks_schema,
    },
    ToolDef {
        name: "start_wait_group",
        description: "Register waits for several independent Session turns without blocking this MCP request. Returns a waitGroupId immediately; use get_wait_group for independent states and final replies.",
        schema: start_wait_group_schema,
    },
    ToolDef {
        name: "get_wait_group",
        description: "Read a nonblocking wait group. Completed items include the final reply; waiting items do not block this request.",
        schema: get_wait_group_schema,
    },
    ToolDef {
        name: "cancel_wait_group",
        description: "Cancel background waiting for a wait group without stopping any Agent Session.",
        schema: cancel_wait_group_schema,
    },
    ToolDef {
        name: "read_output",
        description: "Read bounded progress/output (ANSI stripped) for a Session. It is informational and works while the Session runs; it is not completion evidence. Use wait_for_task.reply for the final answer of the current turn.",
        schema: read_output_schema,
    },
    ToolDef {
        name: "cancel_turn",
        description: "Send Ctrl-C to the Session's Agent (keeps the Session alive). Use this to \
                      stop a runaway turn.",
        schema: cancel_turn_schema,
    },
    ToolDef {
        name: "terminate_session",
        description: "Stop the Session and clean up its whole process group. Irreversible: the \
                      Agent process is gone and only native history remains. A finished task is \
                      NOT a reason to call this: Sessions stay open for the user to read and \
                      continue. Use it only when the user asks, or the Session is stuck.",
        schema: terminate_session_schema,
    },
    ToolDef {
        name: "archive_session",
        description: "Hide the Session from the sidebar and stop it. Its Agent transcript \
                      stays readable and the user can unarchive it in AgentPort. Prefer this \
                      over delete_session unless the user asked for a removal.",
        schema: archive_session_schema,
    },
    ToolDef {
        name: "delete_session",
        description: "Permanently remove a Session this MCP created: stops it, deletes its Agent \
                      transcript files and its AgentPort record. Irreversible. Requires the \
                      confirm string \"delete <sessionId>\".",
        schema: delete_session_schema,
    },
    ToolDef {
        name: "open_pane",
        description: "Ask the AgentPort desktop app to show this Session in the visible pane \
                      layout. Fails when the app is not running.",
        schema: open_pane_schema,
    },
    ToolDef {
        name: "split_pane",
        description: "Ask the desktop app to put this Session in a NEW pane, to the right of or \
                      below the focused pane (or below/right of targetSessionId). Use this to \
                      watch several delegated agents side by side.",
        schema: split_pane_schema,
    },
    ToolDef {
        name: "focus_pane",
        description: "Ask the desktop app to focus this Session's pane (opening it first when it \
                      is not on screen).",
        schema: focus_pane_schema,
    },
    ToolDef {
        name: "close_pane",
        description: "Ask the desktop app to drop this Session's pane from the layout. The \
                      Session keeps running; only the view changes.",
        schema: close_pane_schema,
    },
];

fn obj(properties: Value, required: Value) -> Value {
    json!({ "type": "object", "properties": properties, "required": required,
            "additionalProperties": false })
}

fn list_agents_schema() -> Value {
    obj(
        json!({
            "probe": {
                "type": "boolean",
                "default": false,
                "description": "Re-detect installed CLIs instead of using the cached snapshot"
            }
        }),
        json!([]),
    )
}

fn list_roles_schema() -> Value {
    obj(json!({}), json!([]))
}

fn resolve_project_schema() -> Value {
    obj(
        json!({ "path": { "type": "string", "description": "Absolute directory path" } }),
        json!(["path"]),
    )
}

fn list_sessions_schema() -> Value {
    obj(
        json!({ "includeArchived": { "type": "boolean", "default": false } }),
        json!([]),
    )
}

fn session_status_schema() -> Value {
    obj(
        json!({ "sessionId": { "type": "string" } }),
        json!(["sessionId"]),
    )
}

fn create_session_schema() -> Value {
    obj(
        json!({
            "agent": {
                "type": "string",
                "description": "Agent id such as claude, codex, kimi, qoder, pi, easy-pi, omp, cursor-agent, grok, shell. A wrong or unavailable id returns the selectable ones."
            },
            "roleId": {
                "type": "string",
                "description": "Optional enabled role id. The model chooses from the enabled Role metadata in the tool description; omit it when no Role applies."
            },
            "projectPath": {
                "type": "string",
                "description": "Optional. Omit to delegate in your own working directory; pass it only for another checkout."
            },
            "projectId": {
                "type": "string",
                "description": "Optional existing project id; prefer projectPath or omitting it."
            },
            "title": { "type": "string" },
            "prompt": {
                "type": "string",
                "description": "First task. Sent once the CLI reports a quiet terminal or idle status."
            },
            "permission": {
                "type": "string",
                "enum": ["bypass", "auto", "native"],
                "default": "bypass",
                "description": "bypass (default) launches the Agent with its own full-permission flag so a delegated task never stops to ask; auto relaxes approvals less aggressively; native keeps the CLI's own prompts but will block on them when nobody is watching."
            },
            "worktreeId": { "type": "string" },
            "promptTimeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": 120000,
                "default": 25000
            }
        }),
        json!(["agent"]),
    )
}

fn create_sessions_schema() -> Value {
    obj(
        json!({
            "projectPath": {
                "type": "string",
                "description": "Optional project directory for every task; defaults to your own working directory"
            },
            "projectId": {
                "type": "string",
                "description": "Optional existing project id for every task; a task may override it"
            },
            "tasks": {
                "type": "array",
                "maxItems": MAX_BATCH_ITEMS,
                "description": "Independent create_session requests. Results stay aligned by index and optional taskId.",
                "items": {
                    "type": "object",
                    "properties": {
                        "taskId": {
                            "type": "string",
                            "description": "Optional caller correlation id echoed in the result"
                        },
                        "agent": {
                            "type": "string",
                            "description": "Agent id such as claude, codex, kimi, qoder, pi, easy-pi, omp, cursor-agent, grok, shell"
                        },
                        "roleId": {
                            "type": "string",
                            "description": "Optional enabled role id; choose from the enabled Role metadata in the tool description, or omit it when no Role applies"
                        },
                        "projectPath": {
                            "type": "string",
                            "description": "Absolute project directory; omit to inherit the batch project or your working directory"
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Existing project id; omit to inherit the batch project"
                        },
                        "title": { "type": "string" },
                        "prompt": {
                            "type": "string",
                            "description": "First task. Sent once the CLI reports a quiet terminal or idle status."
                        },
                        "permission": {
                            "type": "string",
                            "enum": ["bypass", "auto", "native"],
                            "default": "bypass"
                        },
                        "worktreeId": { "type": "string" },
                        "promptTimeoutMs": {
                            "type": "integer",
                            "minimum": 1000,
                            "maximum": 120000,
                            "default": 25000
                        }
                    },
                    "required": ["agent"],
                    "additionalProperties": false
                }
            }
        }),
        json!(["tasks"]),
    )
}

fn handoff_schema() -> Value {
    obj(
        json!({
            "agent": {
                "type": "string",
                "description": "Required Agent id such as claude, codex, easy-pi, or shell"
            },
            "handoff": {
                "type": "string",
                "description": "Complete Markdown handoff: summary, user intent/success criteria, outcomes, decisions/constraints, files/artifacts, commands/evidence, unresolved risks, and recommended continuation. Maximum 8 KiB."
            },
            "roleId": {
                "type": "string",
                "description": "Optional enabled Role id chosen from the metadata in tools/list"
            },
            "projectPath": { "type": "string" },
            "projectId": { "type": "string" },
            "title": { "type": "string" },
            "permission": {
                "type": "string",
                "enum": ["bypass", "auto", "native"],
                "default": "bypass"
            },
            "worktreeId": { "type": "string" },
            "promptTimeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": 120000,
                "default": 25000
            }
        }),
        json!(["agent", "handoff"]),
    )
}

fn send_prompt_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "text": { "type": "string", "description": "Single prompt line; Enter is appended" }
        }),
        json!(["sessionId", "text"]),
    )
}

fn wait_for_task_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": MAX_WAIT_MS,
                "default": DEFAULT_WAIT_MS
            },
            "sinceSequence": {
                "type": "integer",
                "description": "Status sequence from your own send_prompt; only a newer transition settles"
            },
            "sinceRunOrdinal": {
                "type": "integer",
                "description": "Run ordinal paired with sinceSequence; returned by create_session/send_prompt"
            }
        }),
        json!(["sessionId"]),
    )
}

fn wait_for_tasks_schema() -> Value {
    obj(
        json!({
            "projectPath": {
                "type": "string",
                "description": "Optional project directory for every task; defaults to your own working directory"
            },
            "projectId": {
                "type": "string",
                "description": "Optional existing project id for every task; a task may override it"
            },
            "tasks": {
                "type": "array",
                "maxItems": MAX_BATCH_ITEMS,
                "description": "Sessions to wait for; results stay aligned by index and optional taskId.",
                "items": {
                    "type": "object",
                    "properties": {
                        "taskId": {
                            "type": "string",
                            "description": "Optional caller correlation id echoed in the result"
                        },
                        "sessionId": { "type": "string" },
                        "sinceSequence": {
                            "type": "integer",
                            "description": "Status sequence from your own send_prompt; only a newer transition settles"
                        },
                        "sinceRunOrdinal": {
                            "type": "integer",
                            "description": "Run ordinal paired with sinceSequence; returned by create_session/send_prompt"
                        }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": MAX_WAIT_MS,
                "default": DEFAULT_WAIT_MS,
                "description": "Shared total request budget; items are processed in order and later items receive structured continuation results when the budget is exhausted."
            }
        }),
        json!(["tasks"]),
    )
}

fn start_wait_group_schema() -> Value {
    obj(
        json!({
            "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_WAIT_GROUP_ITEMS,
                "description": "Independent MCP-owned Session turns to monitor concurrently.",
                "items": {
                    "type": "object",
                    "properties": {
                        "taskId": { "type": "string" },
                        "sessionId": { "type": "string" },
                        "sinceSequence": { "type": "integer" },
                        "sinceRunOrdinal": { "type": "integer" }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": MAX_WAIT_GROUP_TIMEOUT_MS,
                "default": DEFAULT_WAIT_GROUP_TIMEOUT_MS,
                "description": "Background wait deadline; this call itself returns immediately."
            }
        }),
        json!(["tasks"]),
    )
}

fn get_wait_group_schema() -> Value {
    obj(
        json!({ "waitGroupId": { "type": "string" } }),
        json!(["waitGroupId"]),
    )
}

fn cancel_wait_group_schema() -> Value {
    obj(
        json!({ "waitGroupId": { "type": "string" } }),
        json!(["waitGroupId"]),
    )
}

fn read_output_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "source": {
                "type": "string",
                "enum": ["auto", "reply", "screen", "stream", "transcript"],
                "default": "auto",
                "description": "auto/screen project the Host's VT grid (overwrites resolved); reply returns the assistant's answer for the current turn only; stream returns accumulated lines from a cursor; transcript returns the assistant messages in the Agent's own history."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": text::MAX_READ_LINES,
                "default": text::DEFAULT_READ_LINES,
                "description": "Lines to return, counted from the newest."
            },
            "cursor": {
                "type": "string",
                "description": "nextCursor from a previous source=stream read; continues exactly after it."
            },
            "tailBytes": {
                "type": "integer",
                "minimum": 1024,
                "maximum": text::MAX_READ_BYTES,
                "description": "Deprecated alias for limit, converted at ~80 bytes per line."
            }
        }),
        json!(["sessionId"]),
    )
}

fn cancel_turn_schema() -> Value {
    obj(
        json!({ "sessionId": { "type": "string" } }),
        json!(["sessionId"]),
    )
}

fn terminate_session_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "graceMs": { "type": "integer", "minimum": 0, "maximum": 10000, "default": 1500 }
        }),
        json!(["sessionId"]),
    )
}

fn split_pane_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "direction": {
                "type": "string",
                "enum": ["auto", "right", "down"],
                "default": "auto",
                "description": "auto lets the renderer pick the placement that keeps the whole layout balanced"
            },
            "targetSessionId": {
                "type": "string",
                "description": "Split beside this Session instead of the focused pane"
            },
            "focus": { "type": "boolean", "default": true }
        }),
        json!(["sessionId"]),
    )
}

fn focus_pane_schema() -> Value {
    obj(
        json!({ "sessionId": { "type": "string" } }),
        json!(["sessionId"]),
    )
}

fn close_pane_schema() -> Value {
    obj(
        json!({ "sessionId": { "type": "string" } }),
        json!(["sessionId"]),
    )
}

fn archive_session_schema() -> Value {
    obj(json!({ "sessionId": { "type": "string" } }), json!(["sessionId"]))
}

fn delete_session_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "confirm": {
                "type": "string",
                "description": "Exactly \"delete <sessionId>\"; a boolean is not accepted because the removal is irreversible"
            }
        }),
        json!(["sessionId", "confirm"]),
    )
}

fn open_pane_schema() -> Value {
    obj(
        json!({
            "sessionId": { "type": "string" },
            "focus": { "type": "boolean", "default": true }
        }),
        json!(["sessionId"]),
    )
}

#[derive(Debug, Clone)]
struct SettledTurn {
    state: &'static str,
    source: String,
    confidence: String,
    evidence: String,
    reply: Option<String>,
    reply_unavailable_reason: Option<String>,
    tail_source: &'static str,
    fallback_reason: Option<String>,
}

/// A create call's project, after resolution or registration.
struct ResolvedProject {
    id: String,
    root_path: String,
    /// Registered by this call rather than found.
    created: bool,
}

fn public_role_metadata(role: AgentRoleMetadata) -> Value {
    json!({
        "roleId": role.id,
        "name": role.name,
        "description": role.description,
        "outputContract": role.output_contract,
        "revision": role.revision,
        "builtIn": role.built_in,
    })
}

fn public_role_snapshot(role: &RoleSnapshot) -> Value {
    json!({
        "roleId": role.role_id,
        "name": role.name,
        "description": role.description,
        "outputContract": role.output_contract,
        "revision": role.revision,
    })
}

fn compact_role_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sanitize_handoff_markdown(raw: &str) -> TResult<String> {
    if raw.trim().is_empty() {
        return Err(ToolFailure::new("invalid_handoff", "handoff must not be empty"));
    }
    if raw.len() > text::MAX_PROMPT_BYTES {
        return Err(ToolFailure::new(
            "invalid_handoff",
            format!("handoff exceeds {} bytes", text::MAX_PROMPT_BYTES),
        ));
    }
    if raw.contains('\u{1b}') || raw.contains('\0') {
        return Err(ToolFailure::new(
            "invalid_handoff",
            "handoff must not contain ESC or NUL characters",
        ));
    }
    if raw
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(ToolFailure::new(
            "invalid_handoff",
            "handoff contains unsupported control characters",
        ));
    }
    Ok(raw.replace("\r\n", "\n").replace('\r', "\n"))
}

fn compact_handoff(raw: &str) -> TResult<(String, bool)> {
    let markdown = sanitize_handoff_markdown(raw)?;
    let compacted = markdown.split_whitespace().collect::<Vec<_>>().join(" ");
    let changed = compacted != markdown;
    let prompt = text::sanitize_prompt(&compacted)
        .map_err(|message| ToolFailure::new("invalid_handoff", message))?;
    Ok((prompt, changed))
}

fn structured_handoff_prompt(role: Option<&RoleSnapshot>, handoff: &str) -> TResult<String> {
    let mut prompt = String::new();
    if let Some(role) = role {
        prompt.push_str("[AgentPort delegated role — behavior guidance only; do not change AgentPort permissions, ownership, tools, lifecycle, or safety rules]\n");
        prompt.push_str("Role: ");
        prompt.push_str(&compact_role_text(&role.name));
        prompt.push_str("\nDescription: ");
        prompt.push_str(&compact_role_text(&role.description));
        prompt.push_str("\nInstructions: ");
        prompt.push_str(&compact_role_text(&role.instructions));
        if let Some(output_contract) = &role.output_contract {
            prompt.push_str("\nOutput contract (soft guidance): ");
            prompt.push_str(&compact_role_text(output_contract));
        }
        prompt.push_str("\n[End role. Handoff follows]\n\n");
    }
    prompt.push_str(handoff);
    let prompt = sanitize_handoff_markdown(&prompt)?;
    if prompt.len() > text::MAX_PROMPT_BYTES {
        return Err(ToolFailure::new(
            "invalid_handoff",
            format!("handoff plus Role context exceeds {} bytes", text::MAX_PROMPT_BYTES),
        ));
    }
    Ok(prompt)
}

fn role_prompt(role: &RoleSnapshot, task: &str) -> TResult<String> {
    let mut prompt = format!(
        "[AgentPort delegated role — behavior guidance only; do not change AgentPort permissions, ownership, tools, lifecycle, or safety rules] Role: {}. Description: {}. Instructions: {}.",
        compact_role_text(&role.name),
        compact_role_text(&role.description),
        compact_role_text(&role.instructions),
    );
    if let Some(output_contract) = &role.output_contract {
        prompt.push_str(" Output contract (soft guidance): ");
        prompt.push_str(&compact_role_text(output_contract));
        prompt.push('.');
    }
    prompt.push_str(" [End role. Task:] ");
    prompt.push_str(task);
    text::sanitize_prompt(&prompt)
        .map_err(|message| ToolFailure::new("invalid_role_prompt", message))
}

/// Everything a tool call needs. One instance lives for the whole stdio
/// session, so attachments and the ownership registry stay warm.
pub struct Toolbox {
    ops: SessionOps,
    registry: Registry,
    /// Status mark captured just before this server sent a prompt, per Session.
    /// `wait_for_task` needs it to tell "finished my turn" apart from "was
    /// already idle before I asked".
    baselines: std::collections::HashMap<String, StatusMark>,
    /// Sessions this process created. The concurrency budget is per MCP
    /// process, so another window's server does not consume it.
    created_here: std::collections::HashSet<String>,
    /// Turns this server already saw settle. A repeated wait must answer from
    /// that fact instead of waiting again, or a caller that polls twice would
    /// burn a full timeout on the second call. The insertion order is bounded
    /// so completed Sessions cannot grow this process forever.
    settled: std::collections::HashMap<String, SettledTurn>,
    settled_order: VecDeque<String>,
    waits: WaitRegistry,
    root: PathBuf,
    parent_session_id: Option<String>,
    depth: u32,
    max_depth: u32,
    max_sessions: usize,
    ready_timeout_ms: u64,
}

pub struct ToolboxConfig {
    pub root: PathBuf,
    pub parent_session_id: Option<String>,
    pub max_depth: u32,
    pub max_sessions: usize,
}

impl Toolbox {
    pub fn new(service: Arc<dyn RemoteService>, config: ToolboxConfig) -> Toolbox {
        let registry = Registry::load(&config.root);
        // Depth is derived from the registry rather than injected through env:
        // a child Agent's MCP looks up the Session that launched it.
        let depth = config
            .parent_session_id
            .as_ref()
            .and_then(|parent| registry.get(parent))
            .map(|entry| entry.depth + 1)
            .unwrap_or(0);
        Toolbox {
            ops: SessionOps::new(service),
            registry,
            created_here: std::collections::HashSet::new(),
            baselines: std::collections::HashMap::new(),
            settled: std::collections::HashMap::new(),
            settled_order: VecDeque::new(),
            waits: WaitRegistry::default(),
            root: config.root,
            parent_session_id: config.parent_session_id,
            depth,
            max_depth: config.max_depth,
            max_sessions: config.max_sessions.max(1),
            ready_timeout_ms: DEFAULT_READY_MS,
        }
    }

    pub fn depth(&self) -> u32 {
        self.depth
    }

    /// Build the MCP tool registry with enabled Role metadata appended only to
    /// delegation tools. The model can choose a role ID or omit it; this path
    /// never loads full Role instructions.
    pub fn tool_definitions(&self) -> Vec<Value> {
        let role_hint = self
            .ops
            .service()
            .list_agent_role_metadata()
            .ok()
            .map(|roles| {
                roles
                    .into_iter()
                    .filter(|role| role.enabled)
                    .map(|role| {
                        format!(
                            "- {}: {} — {}",
                            role.id,
                            compact_role_text(&role.name),
                            compact_role_text(&role.description)
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|roles| !roles.is_empty())
            .map(|roles| {
                format!(
                    "\n\nEnabled Agent Roles (choose one by passing its roleId, or omit roleId if none applies):\n{}",
                    roles.join("\n")
                )
            })
            .unwrap_or_default();
        TOOLS
            .iter()
            .map(|tool| {
                let description = if matches!(tool.name, "create_session" | "create_sessions" | "handoff") {
                    format!("{}{}", tool.description, role_hint)
                } else {
                    tool.description.to_string()
                };
                json!({
                    "name": tool.name,
                    "description": description,
                    "inputSchema": (tool.schema)(),
                })
            })
            .collect()
    }

    pub fn call(&mut self, name: &str, args: &Value) -> TResult<Value> {
        let args = args
            .as_object()
            .cloned()
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "arguments must be an object"))?;
        match name {
            "list_agents" => self.list_agents(&args),
            "list_roles" => self.list_roles(&args),
            "resolve_project" => self.resolve_project(&args),
            "list_sessions" => self.list_sessions(&args),
            "session_status" => self.session_status(&args),
            "create_session" => self.create_session(&args),
            "create_sessions" => self.create_sessions(&args),
            "handoff" => self.handoff(&args),
            "send_prompt" => self.send_prompt(&args),
            "wait_for_task" => self.wait_for_task(&args),
            "wait_for_tasks" => self.wait_for_tasks(&args),
            "start_wait_group" => self.start_wait_group(&args),
            "get_wait_group" => self.get_wait_group(&args),
            "cancel_wait_group" => self.cancel_wait_group(&args),
            "read_output" => self.read_output(&args),
            "cancel_turn" => self.cancel_turn(&args),
            "terminate_session" => self.terminate_session(&args),
            "archive_session" => self.archive_session(&args),
            "delete_session" => self.delete_session(&args),
            "open_pane" => self.open_pane(&args),
            "split_pane" => self.split_pane(&args),
            "focus_pane" => self.focus_pane(&args),
            "close_pane" => self.close_pane(&args),
            other => Err(ToolFailure::new(
                "unknown_tool",
                format!("unknown tool {other}"),
            )),
        }
    }

    // -- read-only ---------------------------------------------------------

    fn list_roles(&mut self, _args: &Map<String, Value>) -> TResult<Value> {
        let roles = self
            .ops
            .service()
            .list_agent_role_metadata()
            .map_err(ToolFailure::from)?;
        let roles: Vec<Value> = roles
            .into_iter()
            .filter(|role| role.enabled)
            .map(public_role_metadata)
            .collect();
        Ok(json!({ "roles": roles }))
    }

    fn list_agents(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        // Only Agents the user can actually pick: installed, and not hidden in
        // AgentPort's settings. Listing the rest invites a create_session for a
        // CLI that is missing or switched off.
        let hidden = self
            .ops
            .service()
            .agent_preferences()
            .map(|preferences| preferences.agent_hidden)
            .unwrap_or_default();
        let selectable = |agent: &str| !hidden.iter().any(|hidden| hidden == agent);

        if args.get("probe").and_then(Value::as_bool).unwrap_or(false) {
            let probed = self
                .ops
                .service()
                .probe_all_agents(AgentProbeAllParams {
                    preserve_selections: false,
                })
                .map_err(ToolFailure::from)?;
            let entries: Vec<Value> = probed
                .iter()
                .filter(|result| result.install.is_some() && selectable(&result.agent))
                .map(|result| {
                    json!({
                        "agent": result.agent.clone(),
                        "displayName": result.display_name.clone(),
                        "path": result.install.as_ref().map(|install| install.executable_path.clone()),
                        "version": result.install.as_ref().map(|install| install.version_text.clone()),
                        "exactResume": result.install.as_ref().map(|install| install.exact_resume),
                        "approvalModel": result.install.as_ref().map(|install| install.approval_model.as_str()),
                        "defaultTransport": result.install.as_ref().map(|install| install.default_transport.as_str()),
                    })
                })
                .collect();
            return Ok(json!({ "agents": entries, "probed": true }));
        }
        let agents = self
            .ops
            .service()
            .supported_agents()
            .map_err(ToolFailure::from)?;
        let entries: Vec<Value> = agents
            .iter()
            .filter(|agent| agent.install.is_some() && selectable(&agent.agent))
            .map(|agent| {
                json!({
                    "agent": agent.agent.clone(),
                    "displayName": agent.display_name.clone(),
                    "commandNames": agent.command_names.clone(),
                    "path": agent.install.as_ref().map(|install| install.executable_path.clone()),
                    "version": agent.install.as_ref().map(|install| install.version_text.clone()),
                    "exactResume": agent.install.as_ref().map(|install| install.exact_resume),
                    "approvalModel": agent.install.as_ref().map(|install| install.approval_model.as_str()),
                    "defaultTransport": agent.install.as_ref().map(|install| install.default_transport.as_str()),
                })
            })
            .collect();
        Ok(json!({ "agents": entries }))
    }

    /// Agent ids a caller may delegate to right now: installed and not switched
    /// off in AgentPort's settings. Used to answer a wrong guess in one step, so
    /// nobody has to enumerate first.
    fn selectable_agent_ids(&mut self) -> Vec<String> {
        let hidden = self
            .ops
            .service()
            .agent_preferences()
            .map(|preferences| preferences.agent_hidden)
            .unwrap_or_default();
        self.ops
            .service()
            .supported_agents()
            .unwrap_or_default()
            .into_iter()
            .filter(|agent| {
                agent.install.is_some() && !hidden.iter().any(|hidden| hidden == &agent.agent)
            })
            .map(|agent| agent.agent)
            .collect()
    }

    /// Project for a create call: `projectId`, then `projectPath`, then the
    /// server's own working directory (the Agent's cwd).
    fn resolve_target_project(&mut self, args: &Map<String, Value>) -> TResult<ResolvedProject> {
        if let Some(id) = optional_str(args, "projectId") {
            let projects = self.ops.service().list_projects().map_err(ToolFailure::from)?;
            let project = projects
                .into_iter()
                .find(|project| project.id == id)
                .ok_or_else(|| ToolFailure::new("unknown_project", format!("no project {id}")))?;
            return Ok(ResolvedProject {
                id: project.id,
                root_path: project.root_path,
                created: false,
            });
        }
        let path = match optional_str(args, "projectPath") {
            Some(path) => path,
            None => std::env::current_dir()
                .ok()
                .and_then(|dir| dir.to_str().map(str::to_string))
                .ok_or_else(|| {
                    ToolFailure::new(
                        "missing_project",
                        "pass projectPath: this server could not read its own working directory",
                    )
                })?,
        };
        // Inside a known project, "here" means that project: an Agent whose cwd
        // is `repo/src` must not create a second project for it.
        let normalized = agentport_core::paths::normalize_abs(&path)
            .map_err(|error| ToolFailure::new("invalid_path", error.to_string()))?;
        let projects = self.ops.service().list_projects().map_err(ToolFailure::from)?;
        if let Some(enclosing) = projects
            .iter()
            .filter(|project| {
                normalized == project.root_path
                    || normalized.starts_with(&format!("{}/", project.root_path.trim_end_matches('/')))
            })
            .max_by_key(|project| project.root_path.len())
        {
            return Ok(ResolvedProject {
                id: enclosing.id.clone(),
                root_path: enclosing.root_path.clone(),
                created: false,
            });
        }
        self.register_project(&path)
    }

    /// Resolve a directory to a project, registering it when it is unknown.
    fn register_project(&mut self, path: &str) -> TResult<ResolvedProject> {
        let normalized = agentport_core::paths::normalize_abs(path)
            .map_err(|error| ToolFailure::new("invalid_path", error.to_string()))?;
        let projects = self.ops.service().list_projects().map_err(ToolFailure::from)?;
        if let Some(existing) = projects
            .iter()
            .find(|project| project.root_path == normalized)
        {
            return Ok(ResolvedProject {
                id: existing.id.clone(),
                root_path: existing.root_path.clone(),
                created: false,
            });
        }
        let added = self
            .ops
            .service()
            .add_project(ProjectAddParams {
                path: normalized,
                name: None,
            })
            .map_err(ToolFailure::from)?;
        Ok(ResolvedProject {
            id: added.project.id,
            root_path: added.project.root_path,
            created: !added.focused_existing,
        })
    }

    fn resolve_project(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let path = require_str(args, "path")?;
        let normalized = agentport_core::paths::normalize_abs(&path)
            .map_err(|error| ToolFailure::new("invalid_path", error.to_string()))?;
        let projects = self
            .ops
            .service()
            .list_projects()
            .map_err(ToolFailure::from)?;
        if let Some(existing) = projects
            .iter()
            .find(|project| project.root_path == normalized)
        {
            return Ok(json!({
                "projectId": existing.id,
                "name": existing.name,
                "rootPath": existing.root_path,
                "created": false,
            }));
        }
        let added = self
            .ops
            .service()
            .add_project(ProjectAddParams {
                path: normalized,
                name: None,
            })
            .map_err(ToolFailure::from)?;
        Ok(json!({
            "projectId": added.project.id,
            "name": added.project.name,
            "rootPath": added.project.root_path,
            "created": !added.focused_existing,
        }))
    }

    fn list_sessions(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let include_archived = args
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // Prune and scope against the *complete* set: a default listing hides
        // archived Sessions, and pruning from that view would quietly drop their
        // ownership (breaking unarchive, delete and status afterwards).
        let all = self.ops.list_sessions(true)?;
        let known: std::collections::HashSet<String> =
            all.iter().map(|session| session.id.clone()).collect();
        self.registry.prune(&known);
        let sessions: Vec<_> = all
            .into_iter()
            .filter(|session| include_archived || session.archived_at.is_none())
            .collect();
        // The user's own Sessions are not this server's business: they are
        // neither addressable nor visible here.
        let owned: Vec<Value> = sessions
            .iter()
            .filter(|session| self.registry.contains(&session.id))
            .map(|session| {
                let role = self
                    .registry
                    .get(&session.id)
                    .and_then(|entry| entry.role.as_ref())
                    .map(public_role_snapshot);
                json!({
                    "sessionId": session.id,
                    "title": session.title,
                    "projectId": session.project_id,
                    "agent": session.adapter_type,
                    "cwd": session.cwd,
                    "lifecycle": session.lifecycle,
                    "hostAlive": session.host_alive,
                    "permissionMode": session.permission_mode,
                    "status": session.latest_status.as_ref().map(|status| json!({
                        "state": status.state,
                        "source": status.source,
                        "confidence": status.confidence,
                        "occurredAt": status.occurred_at,
                    })),
                    "attention": session.latest_attention_kind,
                    "role": role,
                })
            })
            .collect();
        Ok(json!({ "sessions": owned, "mcpDepth": self.depth }))
    }

    /// Surface a completed turn through the ordinary status read as well as
    /// `wait_for_task`. This is the recovery path after a caller-side request
    /// deadline: the Agent's hook/adapter completion event is already durable,
    /// so the coordinator can receive the final reply without reading PTY
    /// progress or sending another prompt.
    fn completed_turn(&mut self, session_id: &str, summary: &SessionSummary) -> Option<Value> {
        if let Some(previous) = self
            .settled
            .get(session_id)
            .filter(|turn| turn.reply.is_some())
        {
            return Some(json!({
                "state": previous.state,
                "source": previous.source,
                "confidence": previous.confidence,
                "evidence": previous.evidence,
                "reply": previous.reply,
                "replyTruncated": false,
                "replyUnavailableReason": previous.reply_unavailable_reason,
                "outputSource": previous.tail_source,
                "outputFallbackReason": previous.fallback_reason,
                "continuation": false,
                "alreadySettled": true,
            }));
        }

        let baseline = self.baselines.get(session_id).copied()?;
        let status = summary.latest_status.as_ref()?;
        let mark = StatusMark {
            run_ordinal: status.run_ordinal,
            sequence: status.sequence,
        };
        if (mark.run_ordinal, mark.sequence) <= (baseline.run_ordinal, baseline.sequence) {
            return None;
        }
        let turn_completed = summary.latest_attention_kind.as_deref() == Some("turn_completed")
            || (status.state == "idle"
                && matches!(status.source.as_str(), "hook" | "adapter"));
        if !turn_completed {
            return None;
        }
        let reply = self.ops.read_reply(session_id, text::MAX_READ_BYTES).ok()?;
        if !reply.is_available() {
            return None;
        }
        let evidence = if summary.latest_attention_kind.as_deref() == Some("turn_completed") {
            "turn completion reported after the prompt".to_string()
        } else {
            "status moved to idle after the prompt".to_string()
        };
        self.baselines.remove(session_id);
        self.remember_settled(
            session_id,
            SettledTurn {
                state: "idle",
                source: status.source.clone(),
                confidence: status.confidence.clone(),
                evidence: evidence.clone(),
                reply: Some(reply.text.clone()),
                reply_unavailable_reason: None,
                tail_source: reply.source,
                fallback_reason: None,
            },
        );
        Some(json!({
            "state": "idle",
            "source": status.source,
            "confidence": status.confidence,
            "evidence": evidence,
            "reply": reply.text,
            "replyTruncated": reply.truncated,
            "replyUnavailableReason": Value::Null,
            "outputSource": reply.source,
            "outputFallbackReason": Value::Null,
            "continuation": false,
            "alreadySettled": false,
        }))
    }

    fn session_status(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let summary = self.ops.summary(&session_id)?;
        let history = self
            .ops
            .service()
            .session_status_history(SessionIdParams {
                session_id: session_id.clone(),
            })
            .unwrap_or_default();
        let recent: Vec<Value> = history
            .iter()
            .rev()
            .take(5)
            .map(|status| {
                json!({
                    "state": status.state,
                    "source": status.source,
                    "confidence": status.confidence,
                    "sequence": status.sequence,
                    "occurredAt": status.occurred_at,
                })
            })
            .collect();
        let completion = self.completed_turn(&session_id, &summary);
        let role = self
            .registry
            .get(&session_id)
            .and_then(|entry| entry.role.as_ref())
            .map(public_role_snapshot);
        Ok(json!({
            "sessionId": summary.id,
            "title": summary.title,
            "agent": summary.adapter_type,
            "cwd": summary.cwd,
            "lifecycle": summary.lifecycle,
            "hostAlive": summary.host_alive,
            "permissionMode": summary.permission_mode,
            "status": summary.latest_status.as_ref().map(|status| json!({
                "state": status.state,
                "source": status.source,
                "confidence": status.confidence,
                "occurredAt": status.occurred_at,
            })),
            "attention": summary.latest_attention_kind,
            "completion": completion,
            "role": role,
            "history": recent,
        }))
    }

    // -- delegation --------------------------------------------------------

    fn resolve_role(&self, args: &Map<String, Value>) -> TResult<Option<AgentRole>> {
        let Some(value) = args.get("roleId") else {
            return Ok(None);
        };
        let Some(role_id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
            return Err(ToolFailure::new(
                "invalid_role",
                "roleId must be a non-empty string",
            ));
        };
        let role = self
            .ops
            .service()
            .get_agent_role(role_id)
            .map_err(|error| match error {
                agentport_service::ServiceError::Core(agentport_core::CoreError::NotFound(_))
                | agentport_service::ServiceError::NotExecutedCore(
                    agentport_core::CoreError::NotFound(_),
                ) => ToolFailure::new(
                    "role_not_found",
                    format!("role {role_id} does not exist; call list_roles for enabled roles"),
                ),
                other => ToolFailure::from(other),
            })?;
        if !role.enabled {
            return Err(ToolFailure::new(
                "role_not_enabled",
                format!("role {role_id} is disabled; call list_roles for enabled roles"),
            ));
        }
        Ok(Some(role))
    }

    fn handoff(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let raw = require_str(args, "handoff")?;
        let markdown = sanitize_handoff_markdown(&raw)?;
        let normalized = markdown != raw;
        let mut delegated = args.clone();
        delegated.remove("handoff");
        // Create first without an ordinary prompt. JSON-RPC can then receive
        // the exact Markdown through structured_prompt; PTY falls back to the
        // proven line-oriented delivery path below.
        delegated.remove("prompt");
        let mut result = self.create_session_with_pane(&delegated, true)?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolFailure::new("handoff_failed", "delegation returned no Session id"))?
            .to_string();
        let summary = self.ops.summary(&session_id)?;
        if summary.transport == "json_rpc" {
            let timeout = optional_u64(args, "promptTimeoutMs")
                .unwrap_or(self.ready_timeout_ms)
                .clamp(1_000, 120_000);
            let ready = self.ops.wait_ready(&session_id, timeout)?;
            if let Some(object) = result.as_object_mut() {
                object.insert("ready".into(), json!(ready.ready));
                object.insert("readyEvidence".into(), json!(ready.reason));
                object.insert("outputTail".into(), json!(ready.tail));
            }
            if ready.ready {
                let role = self
                    .registry
                    .get(&session_id)
                    .and_then(|entry| entry.role.clone());
                let structured = structured_handoff_prompt(role.as_ref(), &markdown)?;
                let baseline = self.ops.status_mark(&session_id).unwrap_or(None);
                self.ops.structured_prompt(&session_id, &structured)?;
                if let Some(baseline) = baseline {
                    self.baselines.insert(session_id.clone(), baseline);
                }
                self.ops.remember_prompt(
                    &session_id,
                    &markdown.chars().take(64).collect::<String>(),
                );
                let mut role_delivered = false;
                if role.is_some() {
                    role_delivered = self
                        .registry
                        .mark_role_preamble_delivered(&session_id)
                        .is_ok();
                }
                if let Some(object) = result.as_object_mut() {
                    object.insert("promptSent".into(), json!(true));
                    object.insert("promptSubmitted".into(), json!(true));
                    object.insert("promptBytes".into(), json!(structured.len()));
                    object.insert("statusSequence".into(), json!(baseline.map(|mark| mark.sequence)));
                    object.insert("statusRunOrdinal".into(), json!(baseline.map(|mark| mark.run_ordinal)));
                    object.insert("rolePreambleDelivered".into(), json!(role_delivered));
                    object.insert(
                        "handoff".into(),
                        json!({
                            "direct": true,
                            "transport": "json_rpc",
                            "formatPreserved": true,
                            "normalizedLineEndings": normalized,
                            "compacted": false,
                            "promptBytes": structured.len(),
                            "oneShot": true,
                            "completion": "not_collected_by_handoff"
                        }),
                    );
                }
            } else if let Some(object) = result.as_object_mut() {
                object.insert("promptSent".into(), json!(false));
                object.insert(
                    "handoff".into(),
                    json!({
                        "direct": true,
                        "transport": "json_rpc",
                        "formatPreserved": Value::Null,
                        "normalizedLineEndings": normalized,
                        "compacted": false,
                        "fallbackReason": "agent_not_ready",
                        "oneShot": true,
                        "completion": "not_collected_by_handoff"
                    }),
                );
            }
        } else {
            let (prompt, compacted) = compact_handoff(&markdown)?;
            let mut send_args = Map::new();
            send_args.insert("sessionId".into(), Value::String(session_id.clone()));
            send_args.insert("text".into(), Value::String(prompt.clone()));
            let sent = self.send_prompt_with_mode(&send_args, true)?;
            if let (Some(result_object), Some(sent_object)) =
                (result.as_object_mut(), sent.as_object())
            {
                for (key, value) in sent_object {
                    result_object.insert(key.clone(), value.clone());
                }
                if let Some(submitted) = sent_object.get("submitted") {
                    result_object.insert("promptSent".into(), submitted.clone());
                    result_object.insert("promptSubmitted".into(), submitted.clone());
                }
                if let Some(ready) = sent_object.get("readyBeforeSend") {
                    result_object.insert("ready".into(), ready.clone());
                }
                result_object.insert(
                    "handoff".into(),
                    json!({
                        "direct": true,
                        "transport": summary.transport,
                        "formatPreserved": false,
                        "normalizedLineEndings": normalized,
                        "compacted": compacted,
                        "promptBytes": prompt.len(),
                        "fallbackReason": "structured_prompt_requires_json_rpc_transport",
                        "oneShot": true,
                        "completion": "not_collected_by_handoff"
                    }),
                );
            }
        }
        Ok(result)
    }

    fn create_session(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        self.create_session_with_pane(args, true)
    }

    /// Create a Session while optionally deferring pane placement. Batch
    /// creation uses the same launch/readiness/ownership path as the single
    /// tool, but queues one combined pane intent after all items succeed.
    fn create_session_with_pane(
        &mut self,
        args: &Map<String, Value>,
        queue_pane: bool,
    ) -> TResult<Value> {
        // Resolve before project registration or Session creation so an
        // unavailable role fails closed without leaving any side effect.
        let role = self.resolve_role(args)?;
        if self.depth >= self.max_depth {
            return Err(ToolFailure::new(
                "delegation_depth_exceeded",
                format!(
                    "delegation depth {} reached the limit of {}; finish this task yourself",
                    self.depth, self.max_depth
                ),
            ));
        }
        let live_owned = self.live_owned_count()?;
        if live_owned >= self.max_sessions {
            let live_summary = self.live_owned_summary();
            let limit = self.max_sessions;
            return Err(ToolFailure::new(
                "too_many_sessions",
                format!(
                    "this MCP process already drives {live_owned} live Sessions (limit {}): {}; finish \
                     or reuse one, or terminate one only if it is actually finished or stuck",
                    limit,
                    live_summary
                ),
            ));
        }

        let agent_name = require_str(args, "agent")?;
        let agent: AgentType = agent_name.parse().map_err(|_| {
            let selectable = self.selectable_agent_ids();
            ToolFailure::new(
                "unknown_agent",
                format!(
                    "unknown agent {agent_name}; selectable Agents here: {}",
                    selectable.join(", ")
                ),
            )
        })?;
        if role.is_some() && agent == AgentType::Shell {
            return Err(ToolFailure::new(
                "role_not_supported",
                "roles are prompt guidance for conversational Agents and cannot be applied safely to the Generic Shell Agent",
            ));
        }

        // Delegation is unattended by definition: the default is the Agent's own
        // full-permission mode, so a child never parks on an approval prompt
        // that nobody is there to answer. Callers that want the CLI's prompts
        // ask for `native` explicitly (and then own the blocking that implies).
        let permission = optional_str(args, "permission").unwrap_or_else(|| "bypass".into());
        if !matches!(permission.as_str(), "bypass" | "auto" | "native") {
            return Err(ToolFailure::new(
                "invalid_permission",
                "permission must be bypass, auto or native",
            ));
        }
        // The service requires an explicit risk acknowledgement for any mode
        // that relaxes approvals; a delegated Session has no other actor to ask.
        let risk_ack = permission != "native";

        // The project is resolved here, never by the caller: an explicit id or
        // path wins, otherwise the Session lands in the directory the Agent is
        // already working in, which is what "delegate this here" means.
        let project = self.resolve_target_project(args)?;
        let project_id = project.id.clone();

        let title = optional_str(args, "title");
        let role_snapshot = role.as_ref().map(RoleSnapshot::from);
        let task_prompt = optional_str(args, "prompt")
            .map(|text| text::sanitize_prompt(&text))
            .transpose()
            .map_err(|message| ToolFailure::new("invalid_prompt", message))?;
        let prompt_fence = task_prompt
            .as_ref()
            .map(|text| text.chars().take(64).collect::<String>());
        let evidence_token = role_snapshot
            .as_ref()
            .and(task_prompt.as_ref())
            .map(|text| text.chars().take(10).collect::<String>());
        let prompt = task_prompt
            .map(|text| match role_snapshot.as_ref() {
                Some(role) => role_prompt(role, &text),
                None => Ok(text),
            })
            .transpose()?;
        let prompt_timeout = optional_u64(args, "promptTimeoutMs")
            .unwrap_or(self.ready_timeout_ms)
            .clamp(1_000, 120_000);
        // Placement is part of delegating, not an option: every delegated
        // Session appears in the parent's layout, anchored beside the pane the
        // coordinating Agent is running in.
        if let Some(pane) = optional_str(args, "pane") {
            if matches!(pane.as_str(), "none" | "open") {
                return Err(ToolFailure::new(
                    "pane_not_optional",
                    "a delegated Session always gets a pane; drop the pane argument (the layout \
                     planner picks the best placement)",
                ));
            }
        }

        // Only refuse from a cache that actually has entries: a fresh data
        // directory has probed nothing yet, and the service probes on launch.
        let selectable = self.selectable_agent_ids();
        if !selectable.is_empty() && !selectable.iter().any(|id| id == agent.as_str()) {
            return Err(ToolFailure::new(
                "agent_unavailable",
                format!(
                    "{} is not selectable here (not installed, or switched off in AgentPort's \
                     adapter settings); selectable Agents: {}",
                    agent.display_name(),
                    selectable.join(", ")
                ),
            ));
        }
        let launch = self
            .ops
            .service()
            .create_session(SessionCreateParams {
                project_id,
                agent: remote_agent(agent),
                title: title.clone(),
                preset_id: None,
                worktree_id: optional_str(args, "worktreeId"),
                permission: permission.clone(),
                transport: None,
                risk_ack,
                cols: None,
                rows: None,
                extra_args: None,
            })
            .map_err(ToolFailure::from)?;

        let session_id = launch.session_id.clone();
        self.created_here.insert(session_id.clone());
        if let Err(error) = self.registry.insert(OwnedSession {
            session_id: session_id.clone(),
            created_at: now_rfc3339(),
            depth: self.depth,
            parent_session_id: self.parent_session_id.clone(),
            agent: Some(agent.as_str().to_string()),
            title: title.clone(),
            permission: Some(permission.clone()),
            role: role_snapshot.clone(),
            role_preamble_delivered: false,
        }) {
            // The Session exists and is running: never leave an un-addressable
            // process behind, and never hand back an id the caller cannot use.
            self.created_here.remove(&session_id);
            let _ = self.ops.stop(&session_id, 1_500);
            return Err(ToolFailure::new(
                "registry_write_failed",
                format!("could not record ownership ({error}); the Session was stopped"),
            ));
        }

        let notices: Vec<Value> = launch
            .notices
            .iter()
            .map(|notice| json!({ "code": notice.code, "message": notice.message }))
            .collect();

        let mut result = json!({
            "sessionId": session_id,
            "agent": agent.as_str(),
            "title": title,
            "projectId": project.id,
            "projectPath": project.root_path,
            "permissionMode": permission,
            // Agents without a permission flag (Pi, Shell) fall back to their
            // native behaviour; say so instead of implying a flag was applied.
            "effectivePermissionMode": effective_permission_mode(agent, &permission),
            "resumePrecision": launch.resume_precision,
            "notices": notices,
            "ready": false,
            "promptSent": false,
            "role": role_snapshot.as_ref().map(public_role_snapshot),
            "rolePreambleDelivered": false,
        });

        if let Some(prompt) = prompt {
            let ready = self.ops.wait_ready(&session_id, prompt_timeout)?;
            result["ready"] = json!(ready.ready);
            result["readyEvidence"] = json!(ready.reason);
            result["outputTail"] = json!(ready.tail);
            if ready.ready {
                // Baseline before the prompt so `wait_for_task` can require a
                // *newer* status transition.
                let baseline = self.ops.status_mark(&session_id).unwrap_or(None);
                // A first delivery can still fail if the Agent was not reading
                // input yet; give it one more readiness round rather than
                // handing the caller a prompt they must re-send by hand.
                let mut delivery = match evidence_token.as_deref() {
                    Some(token) => self
                        .ops
                        .deliver_prompt_with_token(&session_id, &prompt, token),
                    None => self.ops.deliver_prompt(&session_id, &prompt),
                };
                if matches!(&delivery, Ok(value) if !value.submitted && value.blocked_on.is_none())
                {
                    if let Ok(ready_again) = self.ops.wait_ready(&session_id, prompt_timeout) {
                        if ready_again.ready {
                            delivery = match evidence_token.as_deref() {
                                Some(token) => self
                                    .ops
                                    .deliver_prompt_with_token(&session_id, &prompt, token),
                                None => self.ops.deliver_prompt(&session_id, &prompt),
                            };
                        }
                    }
                }
                match delivery {
                    Ok(delivery) => {
                        if let Some(baseline) = baseline {
                            self.baselines.insert(session_id.clone(), baseline);
                            result["statusSequence"] = json!(baseline.sequence);
                            result["statusRunOrdinal"] = json!(baseline.run_ordinal);
                        }
                        self.forget_settled(&session_id);
                        if delivery.submitted {
                            if let Some(fence) = prompt_fence.as_deref() {
                                self.ops.remember_prompt(&session_id, fence);
                            }
                        }
                        result["promptSent"] = json!(delivery.submitted);
                        result["promptBytes"] = json!(delivery.bytes);
                        result["promptSubmitted"] = json!(delivery.submitted);
                        result["promptRedrew"] = json!(delivery.redrew);
                        result["enterRetries"] = json!(delivery.enter_retries);
                        result["promptAttempts"] = json!(delivery.attempts);
                        if delivery.submitted {
                            if role_snapshot.is_some() {
                                let recorded = self
                                    .registry
                                    .mark_role_preamble_delivered(&session_id)
                                    .is_ok();
                                result["rolePreambleDelivered"] = json!(recorded);
                                if !recorded {
                                    result["roleAuditWarning"] = json!("the role prompt was delivered, but its one-time delivery marker could not be persisted");
                                }
                            } else {
                                result["rolePreambleDelivered"] = json!(false);
                            }
                        }
                        if let Some(dialog) = delivery.blocked_on.clone() {
                            result["blockedOn"] = json!(dialog);
                        }
                        if !delivery.submitted {
                            result["hint"] = json!(if delivery.blocked_on.is_some() {
                                "the CLI is waiting on a trust or login prompt in the pane; \
                                 answer it there (or delegate into a directory the Agent already \
                                 trusts) and then call send_prompt"
                            } else if delivery.redrew {
                                "the screen changed but no turn started — the CLI is probably \
                                 showing a trust, login or permission dialog; answer it in the \
                                 AgentPort pane, then use send_prompt"
                            } else {
                                "Enter was swallowed: no output changed at all. Check outputTail \
                                 before retrying"
                            });
                        }
                    }
                    Err(failure) => {
                        result["promptSent"] = json!(false);
                        result["promptError"] = json!(failure.message);
                    }
                }
            } else {
                result["promptSent"] = json!(false);
                result["hint"] = json!(
                    "the CLI never reached a quiet terminal; inspect outputTail and send the \
                     prompt yourself with send_prompt"
                );
            }
        }

        // Report the title the Session actually got (AgentPort may suffix it).
        if let Ok(summary) = self.ops.summary(&session_id) {
            result["title"] = json!(summary.title);
            result["cwd"] = json!(summary.cwd);
        }

        // Queue the placement last: the Session exists and is owned by now, so
        // the renderer can resolve it when it drains the queue. Batch callers
        // defer this until all successful items have been created.
        if queue_pane {
            // Placement is part of delegating, not an option, and the parent
            // Session (the one running this MCP) anchors the new pane so it
            // opens next to the coordinator.
            result["pane"] = self.queue_pane(ui::PaneIntent {
                kind: "split_pane",
                session_id: &session_id,
                direction: None,
                target_session_id: self.parent_session_id.as_deref(),
                session_ids: None,
                focus: true,
            })?;
        }

        Ok(result)
    }

    /// Create several independent Sessions without changing the single-session
    /// launch path. Work is intentionally bounded and sequential: service and
    /// registry state stay serialized, while a malformed or failed item is
    /// converted to an item error and does not discard earlier successes.
    fn create_sessions(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let tasks = args
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "tasks must be an array"))?;
        if tasks.len() > MAX_BATCH_ITEMS {
            return Err(ToolFailure::new(
                "invalid_arguments",
                format!("tasks must contain at most {MAX_BATCH_ITEMS} items"),
            ));
        }

        // One project for the whole batch: the caller states it once instead of
        // repeating (or resolving) it per task.
        let shared_project_path = optional_str(args, "projectPath");
        let shared_project_id = optional_str(args, "projectId");

        let mut results = Vec::with_capacity(tasks.len());
        let mut pane_sessions = Vec::new();
        let mut succeeded = 0usize;

        for (index, task) in tasks.iter().enumerate() {
            let task_map = task.as_object();
            let task_id = task_map.and_then(|map| optional_str(map, "taskId"));
            let outcome = match task_map {
                Some(map) => {
                    let mut map = map.clone();
                    if optional_str(&map, "projectPath").is_none()
                        && optional_str(&map, "projectId").is_none()
                    {
                        if let Some(path) = shared_project_path.clone() {
                            map.insert("projectPath".into(), Value::String(path));
                        } else if let Some(id) = shared_project_id.clone() {
                            map.insert("projectId".into(), Value::String(id));
                        }
                    }
                    let map = &map;
                    if optional_str(map, "pane").is_some_and(|pane| pane == "none") {
                        return Err(ToolFailure::new(
                            "pane_not_optional",
                            "a delegated Session always gets a pane; drop the pane argument",
                        ));
                    }
                    let outcome = self.create_session_with_pane(map, false);
                    if let Ok(value) = &outcome {
                        if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                            pane_sessions.push(session_id.to_string());
                        }
                    }
                    outcome
                }
                None => Err(ToolFailure::new(
                    "invalid_arguments",
                    "each task must be an object",
                )),
            };

            let item = match outcome {
                Ok(value) => {
                    succeeded += 1;
                    batch_item_success(index, task_id.as_deref(), value)
                }
                Err(failure) => batch_item_failure(index, task_id.as_deref(), failure),
            };
            results.push(item);
        }

        let failed = results.len().saturating_sub(succeeded);
        let mut response = json!({
            "results": results,
            "succeeded": succeeded,
            "failed": failed,
        });
        if let Some(last_session_id) = pane_sessions.last() {
            // Pane placement is deliberately one command for the whole batch.
            // A queue failure is reported as data so all created Sessions remain
            // addressable; successful Session creation must never be rolled back
            // merely because the desktop app is unavailable.
            let pane = match self.queue_batch_pane(&pane_sessions) {
                Ok(value) => value,
                Err(failure) => json!({
                    "queued": false,
                    "kind": "batch_pane",
                    "focus": true,
                    "focusSessionId": last_session_id,
                    "error": {
                        "code": failure.code,
                        "message": failure.message,
                    },
                }),
            };
            response["pane"] = pane;
        }
        Ok(response)
    }

    fn queue_batch_pane(&self, session_ids: &[String]) -> TResult<Value> {
        let command_id = ui::enqueue_batch(
            &self.root,
            session_ids.to_vec(),
            true,
            self.parent_session_id.as_deref(),
            &now_rfc3339(),
        )
            .map_err(|error| {
                ToolFailure::new(
                    "ui_queue_failed",
                    format!("could not queue the pane: {error}"),
                )
            })?;
        Ok(json!({
            "sessionIds": session_ids,
            "kind": "batch_pane",
            "queued": true,
            "commandId": command_id,
            "focus": true,
            "focusSessionId": session_ids.last(),
            "note": "the desktop app applies this batch intent on its next queue poll; layout ownership remains in the renderer",
        }))
    }

    fn send_prompt(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        self.send_prompt_with_mode(args, false)
    }

    fn send_prompt_with_mode(
        &mut self,
        args: &Map<String, Value>,
        one_shot_handoff: bool,
    ) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        if self.waits.is_active(&session_id) {
            return Err(ToolFailure::new(
                "wait_already_active",
                "a background wait owns this Session turn; cancel or collect it before sending another prompt",
            ));
        }
        let raw = require_str(args, "text")?;
        let task = text::sanitize_prompt(&raw)
            .map_err(|message| ToolFailure::new("invalid_prompt", message))?;
        let role = self
            .registry
            .get(&session_id)
            .and_then(|entry| {
                (!entry.role_preamble_delivered)
                    .then(|| entry.role.clone())
                    .flatten()
            });
        let evidence_token: String = task.chars().take(10).collect();
        let prompt_fence: String = task.chars().take(64).collect();
        let prompt = match role.as_ref() {
            Some(role) => role_prompt(role, &task)?,
            None => task,
        };
        let summary = self.ops.summary(&session_id)?;
        if !matches!(summary.lifecycle.as_str(), "running" | "creating") {
            return Err(ToolFailure::new(
                "session_not_running",
                format!(
                    "Session is {}; use terminate_session or create a new one",
                    summary.lifecycle
                ),
            ));
        }
        // Typing into a TUI that is still starting is how a prompt gets lost:
        // the tty echoes the text, the Agent never receives it. Any send waits
        // for the same readiness gate `create_session` uses, bounded so a busy
        // Agent does not block the call.
        let ready = if !self.ops.is_starting(&session_id) {
            ReadyOutcome {
                ready: true,
                reason: "already painted".into(),
                state: None,
                tail: String::new(),
            }
        } else {
            self.ops.wait_ready(&session_id, SEND_READY_MS)?
        };
        let baseline = self.ops.status_mark(&session_id).unwrap_or(None);
        let delivery = if one_shot_handoff {
            self.ops
                .deliver_prompt_once(&session_id, &prompt, &evidence_token)
        } else {
            match role.as_ref() {
                Some(_) => self
                    .ops
                    .deliver_prompt_with_token(&session_id, &prompt, &evidence_token),
                None => self.ops.deliver_prompt(&session_id, &prompt),
            }
        }?;
        let _ = ready;
        let mut role_preamble_delivered = false;
        if delivery.submitted {
            if let Some(baseline) = baseline {
                self.baselines.insert(session_id.clone(), baseline);
            }
            self.forget_settled(&session_id);
            self.ops.remember_prompt(&session_id, &prompt_fence);
            if role.is_some() {
                role_preamble_delivered = self
                    .registry
                    .mark_role_preamble_delivered(&session_id)
                    .is_ok();
            }
        }
        Ok(json!({
            "sessionId": session_id,
            "sent": delivery.submitted,
            "submitted": delivery.submitted,
            "redrew": delivery.redrew,
            "bytes": delivery.bytes,
            "enterRetries": delivery.enter_retries,
            "promptAttempts": delivery.attempts,
            "readyBeforeSend": ready.ready,
            "blockedOn": delivery.blocked_on.clone(),
            "statusSequence": baseline.map(|mark| mark.sequence),
            "statusRunOrdinal": baseline.map(|mark| mark.run_ordinal),
            "role": role.as_ref().map(public_role_snapshot),
            "rolePreambleApplied": role.is_some(),
            "rolePreambleDelivered": role_preamble_delivered,
            "hint": if delivery.submitted {
                Value::Null
            } else if delivery.blocked_on.is_some() {
                json!("the CLI is waiting on a trust or login prompt in the pane; answer it there, then call send_prompt")
            } else if delivery.redrew {
                json!("the screen changed but no turn started — the CLI is probably showing a trust, login or permission dialog")
            } else {
                json!("Enter was swallowed: no output changed at all")
            },
        }))
    }

    fn remember_settled(&mut self, session_id: &str, turn: SettledTurn) {
        // Refreshing a Session keeps it at the newest end of the bounded
        // insertion order. This cache is a recovery/idempotence convenience,
        // not durable history.
        self.settled_order.retain(|id| id != session_id);
        while self.settled.len() >= MAX_SETTLED_TURNS {
            let oldest = self
                .settled_order
                .pop_front()
                .or_else(|| self.settled.keys().next().cloned());
            let Some(oldest) = oldest else { break };
            self.settled.remove(&oldest);
        }
        self.settled.insert(session_id.to_string(), turn);
        self.settled_order.push_back(session_id.to_string());
    }

    fn forget_settled(&mut self, session_id: &str) {
        self.settled.remove(session_id);
        self.settled_order.retain(|id| id != session_id);
    }

    fn remember_wait_outcome(&mut self, session_id: &str, outcome: &crate::ops::WaitOutcome) {
        // Only a real turn boundary clears the baseline and is remembered. A
        // quiet-window verdict is a guess: caching it would turn silence into
        // a confident "finished" on the next call.
        if matches!(outcome.state, "idle" | "needs_input" | "exited")
            && outcome.source != "quiet_window"
            && outcome.confidence != "low"
        {
            self.baselines.remove(session_id);
            self.remember_settled(
                session_id,
                SettledTurn {
                    state: outcome.state,
                    source: outcome.source.clone(),
                    confidence: outcome.confidence.clone(),
                    evidence: outcome.evidence.clone(),
                    reply: outcome.reply.clone(),
                    reply_unavailable_reason: outcome.reply_unavailable_reason.clone(),
                    tail_source: outcome.tail_source,
                    fallback_reason: outcome.fallback_reason.clone(),
                },
            );
        }
    }

    fn wait_for_task(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        if self.waits.is_active(&session_id) {
            return Err(ToolFailure::new(
                "wait_already_active",
                "a background wait already owns this Session turn; use get_wait_group",
            ));
        }
        // A stdio MCP request cannot outlive the client's own deadline. Clamp
        // even an explicitly oversized value so the caller receives a normal
        // `timeout` result and can continue the same turn with another wait.
        let timeout = wait_timeout_ms(optional_u64(args, "timeoutMs"));
        let since = match optional_u64(args, "sinceSequence") {
            Some(sequence) => Some(StatusMark {
                run_ordinal: optional_u64(args, "sinceRunOrdinal")
                    .and_then(|value| i64::try_from(value).ok())
                    .unwrap_or(i64::MIN),
                sequence: i64::try_from(sequence).unwrap_or(i64::MAX),
            }),
            None => self.baselines.get(&session_id).copied(),
        };
        if since.is_none() {
            // Only answer from the cache when it carries the reply: a settled
            // turn with no answer is worth re-reading (the transcript may have
            // caught up since).
            if let Some(previous) = self
                .settled
                .get(&session_id)
                .filter(|previous| previous.reply.is_some())
            {
                return Ok(json!({
                    "sessionId": session_id,
                    "state": previous.state,
                    "source": previous.source,
                    "confidence": previous.confidence,
                    "evidence": previous.evidence,
                    "waitedMs": 0,
                    "reply": previous.reply,
                    "replyTruncated": false,
                    "replyUnavailableReason": previous.reply_unavailable_reason,
                    "outputTail": "",
                    "outputSource": previous.tail_source,
                    "outputFallbackReason": previous.fallback_reason,
                    "outputIncomplete": false,
                    "alreadySettled": true,
                    "continuation": false,
                    "stillRunning": false,
                    "nextAction": Value::Null,
                }));
            }
        }
        let outcome = self.ops.wait_for_task(&session_id, timeout, since)?;
        let still_running = outcome.state == "timeout"
            && self
                .ops
                .summary(&session_id)
                .map(|summary| {
                    matches!(summary.lifecycle.as_str(), "running" | "creating")
                        && summary.host_alive
                })
                .unwrap_or(false);
        self.remember_wait_outcome(&session_id, &outcome);
        Ok(json!({
            "sessionId": session_id,
            "state": outcome.state,
            "source": outcome.source,
            "confidence": outcome.confidence,
            "evidence": outcome.evidence,
            "waitedMs": outcome.waited_ms,
            // The conversational part: the child's answer for this turn.
            "reply": outcome.reply,
            "replyTruncated": outcome.reply_truncated,
            "replyUnavailableReason": outcome.reply_unavailable_reason,
            // Evidence for when no transcript exists (or the turn wrote none).
            "outputTail": outcome.tail,
            "outputSource": outcome.tail_source,
            "outputFallbackReason": outcome.fallback_reason,
            "outputIncomplete": outcome.incomplete,
            // A timeout is a continuation point, not a completion answer. The
            // caller must wait again for the same turn; read_output is only
            // progress evidence and must not decide completion.
            "continuation": outcome.state == "timeout",
            "stillRunning": still_running,
            "nextAction": if outcome.state == "timeout" {
                json!("wait_for_task")
            } else {
                Value::Null
            },
        }))
    }

    /// Wait for several Sessions using the exact single-session wait path. The
    /// loop is deliberately bounded and ordered so baselines, settled replies,
    /// attachments and ownership remain in one Toolbox. The timeout is a
    /// shared request budget, not a per-item multiplier: a batch must return
    /// before the caller's MCP deadline even when several Sessions are slow.
    fn wait_for_tasks(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let tasks = args
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "tasks must be an array"))?;
        if tasks.len() > MAX_BATCH_ITEMS {
            return Err(ToolFailure::new(
                "invalid_arguments",
                format!("tasks must contain at most {MAX_BATCH_ITEMS} items"),
            ));
        }
        let timeout = wait_timeout_ms(optional_u64(args, "timeoutMs"));
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let mut results = Vec::with_capacity(tasks.len());
        let mut succeeded = 0usize;

        for (index, task) in tasks.iter().enumerate() {
            let task_map = task.as_object();
            let task_id = task_map.and_then(|map| optional_str(map, "taskId"));
            let outcome = match task_map {
                Some(map) => match require_str(map, "sessionId") {
                    Ok(session_id) => {
                        let remaining = deadline
                            .saturating_duration_since(Instant::now())
                            .as_millis() as u64;
                        if remaining < 1_000 {
                            match self.require_owned(&session_id) {
                                Ok(()) => Ok(batch_timeout_continuation(
                                    &session_id,
                                    "the shared batch wait budget was exhausted before this Session",
                                )),
                                Err(failure) => Err(failure),
                            }
                        } else {
                            let mut wait_args = Map::new();
                            wait_args.insert("sessionId".into(), Value::String(session_id));
                            if let Some(since) = map.get("sinceSequence") {
                                wait_args.insert("sinceSequence".into(), since.clone());
                            }
                            if let Some(run_ordinal) = map.get("sinceRunOrdinal") {
                                wait_args.insert("sinceRunOrdinal".into(), run_ordinal.clone());
                            }
                            wait_args.insert(
                                "timeoutMs".into(),
                                json!(timeout.min(remaining).clamp(1_000, MAX_WAIT_MS)),
                            );
                            self.wait_for_task(&wait_args)
                        }
                    }
                    Err(failure) => Err(failure),
                },
                None => Err(ToolFailure::new(
                    "invalid_arguments",
                    "each task must be an object",
                )),
            };
            let item = match outcome {
                Ok(value) => {
                    succeeded += 1;
                    batch_item_success(index, task_id.as_deref(), value)
                }
                Err(failure) => batch_item_failure(index, task_id.as_deref(), failure),
            };
            results.push(item);
        }

        Ok(json!({
            "results": results,
            "succeeded": succeeded,
            "failed": tasks.len().saturating_sub(succeeded),
            "timeoutMs": timeout,
        }))
    }

    fn start_wait_group(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let tasks = args
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "tasks must be an array"))?;
        if tasks.is_empty() || tasks.len() > MAX_WAIT_GROUP_ITEMS {
            return Err(ToolFailure::new(
                "invalid_arguments",
                format!("tasks must contain 1..={MAX_WAIT_GROUP_ITEMS} items"),
            ));
        }
        let timeout = optional_u64(args, "timeoutMs")
            .unwrap_or(DEFAULT_WAIT_GROUP_TIMEOUT_MS)
            .clamp(1_000, MAX_WAIT_GROUP_TIMEOUT_MS);
        let mut specs = Vec::new();
        let mut errors = Vec::new();
        for (index, task) in tasks.iter().enumerate() {
            let Some(map) = task.as_object() else {
                errors.push(json!({
                    "index": index,
                    "error": { "code": "invalid_arguments", "message": "each task must be an object" }
                }));
                continue;
            };
            let task_id = optional_str(map, "taskId");
            let session_id = match require_str(map, "sessionId") {
                Ok(value) => value,
                Err(failure) => {
                    errors.push(batch_item_failure(index, task_id.as_deref(), failure));
                    continue;
                }
            };
            if let Err(failure) = self.require_owned(&session_id) {
                errors.push(batch_item_failure(index, task_id.as_deref(), failure));
                continue;
            }
            let baseline = match optional_u64(map, "sinceSequence") {
                Some(sequence) => Some(StatusMark {
                    run_ordinal: optional_u64(map, "sinceRunOrdinal")
                        .and_then(|value| i64::try_from(value).ok())
                        .unwrap_or(i64::MIN),
                    sequence: i64::try_from(sequence).unwrap_or(i64::MAX),
                }),
                None => self.baselines.get(&session_id).copied(),
            };
            let prompt_fence = self.ops.prompt_fence(&session_id);
            specs.push(WaitSpec {
                session_id,
                task_id,
                baseline,
                prompt_fence,
            });
        }
        if specs.is_empty() {
            return Ok(json!({
                "waitGroupId": Value::Null,
                "state": "failed",
                "allDone": true,
                "results": [],
                "errors": errors,
            }));
        }
        let (group_id, items) = self
            .waits
            .start_group(self.ops.service_handle(), specs, timeout)?;
        let mut results: Vec<Value> = items
            .iter()
            .map(|item| {
                let mut value = json!({
                    "sessionId": item.session_id,
                    "state": "waiting",
                });
                if let Some(task_id) = &item.task_id {
                    value["taskId"] = json!(task_id);
                }
                value
            })
            .collect();
        results.extend(errors);
        Ok(json!({
            "waitGroupId": group_id,
            "state": "waiting",
            "allDone": false,
            "timeoutMs": timeout,
            "results": results,
        }))
    }

    fn get_wait_group(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let group_id = require_str(args, "waitGroupId")?;
        let snapshot = self.waits.snapshot(&group_id)?;
        let group_id_value = snapshot.group_id.clone();
        let all_done = snapshot.all_done;
        let all_cancelled = all_done
            && snapshot
                .items
                .iter()
                .all(|item| matches!(item.state, JobState::Cancelled));
        let mut results = Vec::with_capacity(snapshot.items.len());
        for item in snapshot.items {
            let mut value = match item.state {
                JobState::Waiting => json!({
                    "sessionId": item.session_id,
                    "state": "waiting",
                }),
                JobState::Cancelling => json!({
                    "sessionId": item.session_id,
                    "state": "cancelling",
                    "continuation": false,
                }),
                JobState::Cancelled => json!({
                    "sessionId": item.session_id,
                    "state": "cancelled",
                    "continuation": false,
                }),
                JobState::Completed(Ok(outcome)) => {
                    self.remember_wait_outcome(&item.session_id, &outcome);
                    background_outcome_value(&item.session_id, &outcome)
                }
                JobState::Completed(Err(error)) => json!({
                    "sessionId": item.session_id,
                    "state": "failed",
                    "error": { "code": error.code, "message": error.message },
                }),
            };
            if let Some(task_id) = item.task_id {
                value["taskId"] = json!(task_id);
            }
            results.push(value);
        }
        if all_done {
            self.waits.release_sessions(&group_id_value)?;
        }
        Ok(json!({
            "waitGroupId": group_id_value,
            "state": if all_cancelled {
                "cancelled"
            } else if all_done {
                "completed"
            } else {
                "waiting"
            },
            "allDone": all_done,
            "results": results,
        }))
    }

    fn cancel_wait_group(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let group_id = require_str(args, "waitGroupId")?;
        let snapshot = self.waits.cancel(&group_id)?;
        let mut results = Vec::with_capacity(snapshot.items.len());
        for item in snapshot.items {
            let mut value = json!({
                "sessionId": item.session_id,
                "state": match item.state {
                    JobState::Completed(_) => "completed",
                    JobState::Cancelled => "cancelled",
                    JobState::Cancelling | JobState::Waiting => "cancelling",
                },
            });
            if let Some(task_id) = item.task_id {
                value["taskId"] = json!(task_id);
            }
            results.push(value);
        }
        Ok(json!({
            "waitGroupId": snapshot.group_id,
            "state": if snapshot.all_done { "cancelled" } else { "cancelling" },
            "allDone": snapshot.all_done,
            "results": results,
        }))
    }

    fn read_output(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let limit = optional_u64(args, "limit")
            .map(|value| value as usize)
            .unwrap_or_else(|| {
                // Backwards compatibility: an old caller passed a byte budget.
                optional_u64(args, "tailBytes")
                    .map(|bytes| ((bytes as usize) / 80).max(1))
                    .unwrap_or(text::DEFAULT_READ_LINES)
            });
        let source = optional_str(args, "source").unwrap_or_else(|| "auto".into());
        if !matches!(
            source.as_str(),
            "auto" | "reply" | "screen" | "stream" | "transcript"
        ) {
            return Err(ToolFailure::new(
                "invalid_arguments",
                "source must be auto, reply, screen, stream or transcript",
            ));
        }
        if source == "reply" {
            let reply = self.ops.read_reply(&session_id, text::MAX_READ_BYTES)?;
            return Ok(json!({
                "sessionId": session_id,
                "source": reply.source,
                "lines": reply.text.lines().map(str::to_string).collect::<Vec<_>>(),
                "text": reply.text,
                "truncated": reply.truncated,
                "limited": false,
                "nextCursor": Value::Null,
                "fallbackReason": reply.unavailable_reason,
            }));
        }
        if source == "transcript" {
            let transcript = self.ops.read_transcript_events(&session_id, limit)?;
            let lines: Vec<String> = transcript
                .events
                .iter()
                .filter(|event| event.role == "assistant" && !event.text.trim().is_empty())
                .flat_map(|event| event.text.lines().map(str::to_string))
                .collect();
            let (text, truncated) = text::tail(&lines.join("\n"), text::MAX_READ_BYTES);
            let lines: Vec<String> = if truncated {
                text.lines().map(str::to_string).collect()
            } else {
                lines
            };
            return Ok(json!({
                "sessionId": session_id,
                "source": if transcript.available { "transcript" } else { "transcript-unavailable" },
                "lines": lines,
                "truncated": truncated,
                "limited": false,
                "fallbackReason": transcript.reason,
                "nextCursor": Value::Null,
            }));
        }
        let outcome = if source == "stream" {
            self.ops
                .read_stream(&session_id, optional_str(args, "cursor").as_deref(), limit)?
        } else {
            // `auto` and `screen` both project the VT grid; a Host that cannot
            // serialize one degrades to the cursor-free stream instead of
            // handing back redraw bytes as if they were a screen.
            let screen = self.ops.read_screen(&session_id, limit)?;
            if screen.source == "screen" || source == "screen" {
                screen
            } else {
                self.ops.read_stream(&session_id, None, limit)?
            }
        };
        let text = outcome.text();
        let mut value = json!({
            "sessionId": session_id,
            "source": outcome.source,
            "lines": outcome.lines,
            // Joined convenience view; `lines` is the contract.
            "text": text,
            "returnedLineCount": outcome.returned_line_count,
            "truncated": outcome.truncated,
            "limited": outcome.limited,
            "nextCursor": outcome.next_cursor,
            "incomplete": outcome.incomplete,
        });
        if outcome.ended {
            value["ended"] = json!(true);
            if text.trim().is_empty() {
                value["hint"] = json!(
                    "this Session has ended and its Host tail is gone; source=transcript reads the \
                     Agent's own history instead"
                );
            }
        }
        Ok(value)
    }

    fn cancel_turn(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        if self.ops.is_terminal(&session_id)? {
            return Err(ToolFailure::new(
                "session_not_running",
                "this Session has already ended; there is no turn to cancel",
            ));
        }
        let accepted = self.ops.interrupt(&session_id)?;
        Ok(json!({ "sessionId": session_id, "accepted": accepted, "sessionAlive": true }))
    }

    fn terminate_session(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let grace = optional_u64(args, "graceMs").unwrap_or(1_500);
        let group_cleaned = self.ops.stop(&session_id, grace)?;
        self.ops.forget_prompt(&session_id);
        self.baselines.remove(&session_id);
        self.forget_settled(&session_id);
        // Ownership is kept: the Session row still exists (terminated, not
        // deleted), and `list_sessions` prunes rows whose Session is gone, so
        // an agent can still ask what happened to what it started.
        Ok(json!({
            "sessionId": session_id,
            "stopped": true,
            "groupCleaned": group_cleaned,
        }))
    }

    /// Hide the Session: stop it and drop it out of the sidebar. Reversible in
    /// the app, so it is the right way to tidy up without losing history.
    fn archive_session(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        self.ops
            .service()
            .archive_session(SessionIdParams {
                session_id: session_id.clone(),
            })
            .map_err(ToolFailure::from)?;
        self.ops.forget_prompt(&session_id);
        self.baselines.remove(&session_id);
        self.forget_settled(&session_id);
        self.ops.detach(&session_id);
        let mut result = json!({
            "sessionId": session_id,
            "archived": true,
            "historyPreserved": true,
            "note": "the Agent transcript is untouched; unarchive it in AgentPort to see it again",
        });
        if let Ok(pane) = self.queue_pane(ui::PaneIntent {
            kind: "close_pane",
            session_id: &session_id,
            direction: None,
            target_session_id: None,
            session_ids: None,
            focus: false,
        }) {
            result["pane"] = pane;
        }
        Ok(result)
    }

    /// Remove the Session for good: stop, delete the Agent transcript files and
    /// the AgentPort record. Guarded by a confirm string because nothing here
    /// can be undone.
    fn delete_session(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let expected = format!("delete {session_id}");
        let confirm = optional_str(args, "confirm").unwrap_or_default();
        if confirm != expected {
            return Err(ToolFailure::new(
                "confirmation_required",
                format!(
                    "delete_session needs confirm: \"{expected}\"; it removes the Agent's \
                     transcript files and cannot be undone. Use archive_session to keep history."
                ),
            ));
        }
        // Drop the pane before the row disappears, so the renderer is never left
        // showing a Session id it cannot resolve.
        let pane = self
            .queue_pane(ui::PaneIntent {
                kind: "close_pane",
                session_id: &session_id,
                direction: None,
                target_session_id: None,
                session_ids: None,
                focus: false,
            })
            .ok();
        let summary = self.ops.summary(&session_id)?;
        if summary.archived_at.is_none() {
            // The service only deletes archived Sessions; archiving first also
            // stops the Host under the same rollback guarantees.
            self.ops
                .service()
                .archive_session(SessionIdParams {
                    session_id: session_id.clone(),
                })
                .map_err(ToolFailure::from)?;
        }
        self.ops
            .service()
            .delete_archived_session(SessionIdParams {
                session_id: session_id.clone(),
            })
            .map_err(ToolFailure::from)?;
        self.ops.detach(&session_id);
        self.ops.forget_prompt(&session_id);
        self.created_here.remove(&session_id);
        self.baselines.remove(&session_id);
        self.forget_settled(&session_id);
        let _ = self.registry.remove(&session_id);
        let mut result = json!({
            "sessionId": session_id,
            "deleted": true,
            "transcriptDeleted": true,
            "irreversible": true,
        });
        if let Some(pane) = pane {
            result["pane"] = pane;
        }
        Ok(result)
    }

    fn open_pane(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let focus = args.get("focus").and_then(Value::as_bool).unwrap_or(true);
        self.queue_pane(ui::PaneIntent::open(&session_id, focus))
    }

    /// Put the Session in a new pane beside the focused one (or beside
    /// `targetSessionId`). The renderer owns the layout, so this is an intent;
    /// the reply says the command was queued, not that a pane exists.
    fn split_pane(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        let direction = optional_str(args, "direction").unwrap_or_else(|| "auto".into());
        if !matches!(direction.as_str(), "auto" | "right" | "down") {
            return Err(ToolFailure::new(
                "invalid_arguments",
                "direction must be auto, right or down",
            ));
        }
        let target = optional_str(args, "targetSessionId");
        if let Some(target) = target.as_ref() {
            self.require_owned(target)?;
        }
        let focus = args.get("focus").and_then(Value::as_bool).unwrap_or(true);
        self.queue_pane(ui::PaneIntent {
            kind: "split_pane",
            session_id: &session_id,
            direction: match direction.as_str() {
                "right" => Some("right"),
                "down" => Some("down"),
                _ => None,
            },
            target_session_id: target.as_deref(),
            session_ids: None,
            focus,
        })
    }

    fn focus_pane(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        self.queue_pane(ui::PaneIntent {
            kind: "focus_pane",
            session_id: &session_id,
            direction: None,
            target_session_id: None,
            session_ids: None,
            focus: true,
        })
    }

    /// Remove the Session's pane from the layout. The Session keeps running:
    /// only the view changes.
    fn close_pane(&mut self, args: &Map<String, Value>) -> TResult<Value> {
        let session_id = require_str(args, "sessionId")?;
        self.require_owned(&session_id)?;
        self.queue_pane(ui::PaneIntent {
            kind: "close_pane",
            session_id: &session_id,
            direction: None,
            target_session_id: None,
            session_ids: None,
            focus: false,
        })
    }

    fn queue_pane(&self, intent: ui::PaneIntent<'_>) -> TResult<Value> {
        let kind = intent.kind;
        let session_id = intent.session_id.to_string();
        let command_id = ui::enqueue(&self.root, intent, &now_rfc3339()).map_err(|error| {
            ToolFailure::new(
                "ui_queue_failed",
                format!("could not queue the pane: {error}"),
            )
        })?;
        Ok(json!({
            "sessionId": session_id,
            "kind": kind,
            "queued": true,
            "commandId": command_id,
            "note": "the desktop app applies this on its next queue poll; the pane layout is \
                     owned by the renderer, so a queued intent is not a promise of layout",
        }))
    }

    // -- helpers -----------------------------------------------------------

    fn require_owned(&self, session_id: &str) -> TResult<()> {
        if self.registry.contains(session_id) {
            return Ok(());
        }
        // Not "read-only": the user's Sessions are not visible through this
        // server at all, so a wrong id looks like a wrong id.
        Err(ToolFailure::new(
            "session_not_owned",
            format!(
                "Session {session_id} was not created by this MCP server, so it is not visible \
                 here. Create your own with create_session"
            ),
        ))
    }

    /// Live Sessions this MCP process created and still owns.
    ///
    /// The budget is per process (one server per agent window), so a second
    /// coordinator does not eat into this one's allowance; finished Sessions
    /// free their slot immediately.
    /// `id "title"` for each live Session this process created, oldest first.
    fn live_owned_summary(&mut self) -> String {
        let Ok(sessions) = self.ops.list_sessions(false) else {
            return "ids unavailable".into();
        };
        let live: Vec<String> = sessions
            .iter()
            .filter(|session| {
                self.created_here.contains(&session.id)
                    && matches!(session.lifecycle.as_str(), "running" | "creating")
            })
            .map(|session| format!("{} \"{}\"", session.id, session.title))
            .collect();
        if live.is_empty() {
            "none".into()
        } else {
            live.join(", ")
        }
    }

    fn live_owned_count(&mut self) -> TResult<usize> {
        let sessions = self.ops.list_sessions(false)?;
        Ok(sessions
            .iter()
            .filter(|session| {
                self.created_here.contains(&session.id)
                    && matches!(session.lifecycle.as_str(), "running" | "creating")
            })
            .count())
    }
}

/// Mirror of the service's mapping: an Agent without permission flags cannot be
/// widened, so the requested mode is not what actually runs.
fn effective_permission_mode(agent: AgentType, requested: &str) -> &'static str {
    use agentport_core::models::PermissionMode;
    let core_mode = match requested {
        "auto" => PermissionMode::Auto,
        "bypass" => PermissionMode::Bypass,
        _ => PermissionMode::Native,
    };
    match agent.effective_permission_mode(core_mode) {
        PermissionMode::Auto => "auto",
        PermissionMode::Bypass => "bypass",
        PermissionMode::Native => "native",
    }
}

fn remote_agent(agent: AgentType) -> RemoteAgentType {
    match agent {
        AgentType::Claude => RemoteAgentType::Claude,
        AgentType::Codex => RemoteAgentType::Codex,
        AgentType::Kimi => RemoteAgentType::Kimi,
        AgentType::Qoder => RemoteAgentType::Qoder,
        AgentType::Pi => RemoteAgentType::Pi,
        AgentType::Omp => RemoteAgentType::Omp,
        AgentType::Opencode => RemoteAgentType::Opencode,
        AgentType::Amp => RemoteAgentType::Amp,
        AgentType::Gemini => RemoteAgentType::Gemini,
        AgentType::Cline => RemoteAgentType::Cline,
        AgentType::KiroCli => RemoteAgentType::KiroCli,
        AgentType::CursorAgent => RemoteAgentType::CursorAgent,
        AgentType::EasyPi => RemoteAgentType::EasyPi,
        AgentType::GrokBuild => RemoteAgentType::GrokBuild,
        AgentType::Shell => RemoteAgentType::Shell,
    }
}

/// RFC3339 with second precision: enough for an audit line, no chrono dep.
pub fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    format_rfc3339(secs)
}

fn format_rfc3339(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let seconds_of_day = unix_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's days-to-civil conversion.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn background_outcome_value(session_id: &str, outcome: &crate::ops::WaitOutcome) -> Value {
    let state = match outcome.state {
        "idle" => "completed",
        "needs_input" => "needs_input",
        "exited" => "failed",
        "timeout" => "timeout",
        other => other,
    };
    json!({
        "sessionId": session_id,
        "state": state,
        "agentState": outcome.state,
        "source": outcome.source,
        "confidence": outcome.confidence,
        "evidence": outcome.evidence,
        "waitedMs": outcome.waited_ms,
        "reply": outcome.reply,
        "replyTruncated": outcome.reply_truncated,
        "replyUnavailableReason": outcome.reply_unavailable_reason,
        "outputTail": outcome.tail,
        "outputSource": outcome.tail_source,
        "outputFallbackReason": outcome.fallback_reason,
        "outputIncomplete": outcome.incomplete,
        "continuation": outcome.state == "timeout",
        "stillRunning": if outcome.state == "timeout" {
            Value::Null
        } else {
            Value::Bool(false)
        },
        "nextAction": if outcome.state == "timeout" {
            json!("start_wait_group")
        } else {
            Value::Null
        },
    })
}

fn batch_timeout_continuation(session_id: &str, evidence: &str) -> Value {
    json!({
        "sessionId": session_id,
        "state": "timeout",
        "source": "batch_budget",
        "confidence": "low",
        "evidence": evidence,
        "waitedMs": 0,
        "reply": Value::Null,
        "replyTruncated": false,
        "replyUnavailableReason": "the turn was not observed within this batch request",
        "outputTail": "",
        "outputSource": "stream",
        "outputFallbackReason": Value::Null,
        "outputIncomplete": false,
        "continuation": true,
        "stillRunning": Value::Null,
        "nextAction": "wait_for_task"
    })
}

fn batch_item_success(index: usize, task_id: Option<&str>, value: Value) -> Value {
    let mut result = value.as_object().cloned().unwrap_or_else(Map::new);
    result.insert("index".into(), json!(index));
    if let Some(task_id) = task_id {
        result.insert("taskId".into(), json!(task_id));
    }
    Value::Object(result)
}

fn batch_item_failure(index: usize, task_id: Option<&str>, failure: ToolFailure) -> Value {
    let mut result = Map::new();
    result.insert("index".into(), json!(index));
    if let Some(task_id) = task_id {
        result.insert("taskId".into(), json!(task_id));
    }
    result.insert(
        "error".into(),
        json!({ "code": failure.code, "message": failure.message }),
    );
    Value::Object(result)
}

fn require_str(args: &Map<String, Value>, key: &str) -> TResult<String> {
    match args.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Some(Value::String(_)) => Err(ToolFailure::new(
            "invalid_arguments",
            format!("{key} must not be empty"),
        )),
        Some(_) => Err(ToolFailure::new(
            "invalid_arguments",
            format!("{key} must be a string"),
        )),
        None => Err(ToolFailure::new(
            "invalid_arguments",
            format!("{key} is required"),
        )),
    }
}

fn optional_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_u64(args: &Map<String, Value>, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn wait_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_WAIT_MS)
        .clamp(1_000, MAX_WAIT_MS)
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use agentport_remote_protocol::{
        SecretAddParams, SessionAttachParams, SessionControlParams, SessionDetachParams,
        SessionInputParams, SessionPollParams, SessionStopParams, SessionStructuredPromptParams,
    };
    use agentport_core::agent_roles::AgentRoleMetadata;
    use agentport_service::{
        BootSnapshot, Result as ServiceResult, SecretAddResult, ServiceError, SessionAttachResult,
        SessionControlResult, SessionInputResult, SessionPollResult, SessionStopResult,
        SessionSubscription, SessionSummary,
    };

    /// Minimal service: every protocol path answers "not supported" so dispatch
    /// tests can assert framing and guardrails without a database.
    pub struct StubService;

    impl RemoteService for StubService {
        fn service_snapshot(&self) -> agentport_service::ServiceSnapshot {
            Default::default()
        }
        fn boot(&self) -> ServiceResult<BootSnapshot> {
            Err(ServiceError::InvalidRequest)
        }
        fn list_sessions(&self, _include_archived: bool) -> ServiceResult<Vec<SessionSummary>> {
            Ok(Vec::new())
        }
        fn list_agent_role_metadata(&self) -> ServiceResult<Vec<AgentRoleMetadata>> {
            Ok(vec![AgentRoleMetadata {
                id: "role_test".into(),
                name: "Test Role".into(),
                description: "Use for test delegation".into(),
                output_contract: None,
                enabled: true,
                revision: 1,
                built_in: false,
            }])
        }
        fn attach_session(&self, _: SessionAttachParams) -> ServiceResult<SessionAttachResult> {
            Err(ServiceError::InvalidRequest)
        }
        fn subscribe_session(&self, _: &str) -> ServiceResult<SessionSubscription> {
            Err(ServiceError::InvalidRequest)
        }
        fn input_session(&self, _: SessionInputParams) -> ServiceResult<SessionInputResult> {
            Err(ServiceError::InvalidRequest)
        }
        fn structured_prompt(&self, _: SessionStructuredPromptParams) -> ServiceResult<()> {
            Err(ServiceError::InvalidRequest)
        }
        fn abort_structured_turn(&self, _: SessionDetachParams) -> ServiceResult<()> {
            Err(ServiceError::InvalidRequest)
        }
        fn control_session(&self, _: SessionControlParams) -> ServiceResult<SessionControlResult> {
            Err(ServiceError::InvalidRequest)
        }
        fn poll_session(&self, _: SessionPollParams) -> ServiceResult<SessionPollResult> {
            Err(ServiceError::InvalidRequest)
        }
        fn detach_session(&self, _: SessionDetachParams) -> ServiceResult<()> {
            Ok(())
        }
        fn stop_session(&self, _: SessionStopParams) -> ServiceResult<SessionStopResult> {
            Err(ServiceError::InvalidRequest)
        }
        fn add_secret(&self, _: SecretAddParams) -> ServiceResult<SecretAddResult> {
            Err(ServiceError::InvalidRequest)
        }
    }

    pub fn toolbox() -> Toolbox {
        let root = std::env::temp_dir().join(format!("agentport-mcp-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        Toolbox::new(
            Arc::new(StubService),
            ToolboxConfig {
                root,
                parent_session_id: None,
                max_depth: 2,
                max_sessions: 2,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_a_valid_object_schema() {
        let mut names = std::collections::HashSet::new();
        for tool in TOOLS {
            assert!(names.insert(tool.name), "duplicate tool {}", tool.name);
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert!(schema["properties"].is_object(), "{}", tool.name);
            assert!(schema["required"].is_array(), "{}", tool.name);
        }
    }

    #[test]
    fn agent_names_map_to_remote_variants() {
        assert_eq!(remote_agent(AgentType::EasyPi), RemoteAgentType::EasyPi);
        assert_eq!(remote_agent(AgentType::Shell), RemoteAgentType::Shell);
    }

    #[test]
    fn role_listing_is_metadata_only_and_prompt_is_single_line() {
        let role = AgentRole {
            id: "role_test".into(),
            name: "Test".into(),
            description: "A role".into(),
            instructions: "First line\nSecond line".into(),
            output_contract: Some("Return evidence".into()),
            enabled: true,
            revision: 2,
            built_in: false,
        };
        let metadata = public_role_metadata(AgentRoleMetadata::from(&role));
        assert!(metadata.get("instructions").is_none());
        assert_eq!(metadata["roleId"], "role_test");
        let snapshot = RoleSnapshot::from(&role);
        let prompt = role_prompt(&snapshot, "inspect the change").unwrap();
        assert!(!prompt.contains('\n'));
        assert!(prompt.contains("First line Second line"));
        assert!(prompt.contains("inspect the change"));
    }

    #[test]
    fn handoff_compacts_markdown_and_rejects_invalid_content() {
        let (prompt, changed) = compact_handoff("# Summary\n\n- Keep /repo\n- Run tests").unwrap();
        assert!(changed);
        assert_eq!(prompt, "# Summary - Keep /repo - Run tests");
        assert_eq!(compact_handoff("   ").unwrap_err().code, "invalid_handoff");
        assert_eq!(
            compact_handoff(&"x".repeat(text::MAX_PROMPT_BYTES + 1))
                .unwrap_err()
                .code,
            "invalid_handoff"
        );
        assert_eq!(
            compact_handoff("bad\u{1b}[2J").unwrap_err().code,
            "invalid_handoff"
        );
        let role = RoleSnapshot {
            role_id: "role_test".into(),
            revision: 1,
            name: "Reviewer".into(),
            description: "Review evidence".into(),
            instructions: "Keep the handoff facts grounded".into(),
            output_contract: None,
        };
        let structured = structured_handoff_prompt(Some(&role), "# Summary\n\n- Keep /repo").unwrap();
        assert!(structured.contains("[End role. Handoff follows]"));
        assert!(structured.contains("# Summary\n\n- Keep /repo"));
    }

    #[test]
    fn batch_schemas_align_items_and_bound_work() {
        let create = create_sessions_schema();
        assert_eq!(create["required"], json!(["tasks"]));
        assert_eq!(
            create["properties"]["tasks"]["maxItems"],
            json!(MAX_BATCH_ITEMS)
        );
        assert_eq!(
            create["properties"]["tasks"]["items"]["required"],
            json!(["agent"])
        );

        let wait = wait_for_tasks_schema();
        assert_eq!(wait["required"], json!(["tasks"]));
        assert_eq!(
            wait["properties"]["tasks"]["items"]["required"],
            json!(["sessionId"])
        );
        assert_eq!(
            wait["properties"]["timeoutMs"]["default"],
            json!(DEFAULT_WAIT_MS)
        );
        assert_eq!(
            wait["properties"]["timeoutMs"]["maximum"],
            json!(MAX_WAIT_MS)
        );
        assert_eq!(wait_timeout_ms(Some(600_000)), MAX_WAIT_MS);
        assert_eq!(wait_timeout_ms(Some(0)), 1_000);
    }

    #[test]
    fn batch_dispatch_keeps_independent_item_errors() {
        let mut toolbox = test_support::toolbox();
        let value = toolbox
            .call(
                "create_sessions",
                &json!({
                    "tasks": [
                        { "taskId": "bad-agent", "agent": "not-an-agent" },
                        { "taskId": "missing-agent" }
                    ]
                }),
            )
            .unwrap();
        assert_eq!(value["results"].as_array().unwrap().len(), 2);
        assert_eq!(value["succeeded"], json!(0));
        assert_eq!(value["failed"], json!(2));
        assert_eq!(value["results"][0]["taskId"], json!("bad-agent"));
        assert_eq!(value["results"][0]["error"]["code"], json!("unknown_agent"));
        assert_eq!(value["results"][1]["taskId"], json!("missing-agent"));
        assert_eq!(
            value["results"][1]["error"]["code"],
            json!("invalid_arguments")
        );
    }

    #[test]
    fn batch_wait_dispatch_keeps_ownership_errors_independent() {
        let mut toolbox = test_support::toolbox();
        let value = toolbox
            .call(
                "wait_for_tasks",
                &json!({
                    "timeoutMs": 1_000,
                    "tasks": [
                        { "taskId": "first", "sessionId": "not-owned-1" },
                        { "taskId": "second", "sessionId": "not-owned-2", "sinceSequence": 3 }
                    ]
                }),
            )
            .unwrap();
        assert_eq!(value["results"].as_array().unwrap().len(), 2);
        assert_eq!(value["failed"], json!(2));
        assert_eq!(
            value["results"][0]["error"]["code"],
            json!("session_not_owned")
        );
        assert_eq!(
            value["results"][1]["error"]["code"],
            json!("session_not_owned")
        );
    }

    #[test]
    fn settled_turn_cache_is_bounded() {
        let mut toolbox = test_support::toolbox();
        for index in 0..(MAX_SETTLED_TURNS + 2) {
            let session_id = format!("ses-settled-{index}");
            toolbox.remember_settled(
                &session_id,
                SettledTurn {
                    state: "idle",
                    source: "hook".into(),
                    confidence: "high".into(),
                    evidence: "test".into(),
                    reply: Some("reply".into()),
                    reply_unavailable_reason: None,
                    tail_source: "transcript",
                    fallback_reason: None,
                },
            );
        }
        assert_eq!(toolbox.settled.len(), MAX_SETTLED_TURNS);
        assert_eq!(toolbox.settled_order.len(), MAX_SETTLED_TURNS);
        assert!(!toolbox.settled.contains_key("ses-settled-0"));
        assert!(!toolbox.settled.contains_key("ses-settled-1"));
        assert!(toolbox.settled.contains_key("ses-settled-65"));
    }

    #[test]
    fn rfc3339_matches_known_epochs() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
    }
}
