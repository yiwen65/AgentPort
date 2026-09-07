//! Stdio-only Remote Bridge adapter. Protocol bytes use stdin/stdout; bounded
//! diagnostics use stderr. This crate contains no listener or daemon path.

use agentport_remote_protocol::{
    borrow_request, classify_method, negotiate_version, read_frame, write_frame,
    AgentPreferencesReplaceParams, AgentProbeAllParams, AgentProbeParams, AttentionPollParams,
    Capability, CommitAiConfigSaveParams, DocumentWriteParams, Event, Hello, HelloResult, Limits,
    Precondition, PresetListParams, ProjectAddParams, ProjectIdParams, ProjectLayoutReplaceParams,
    ProjectRemoveParams, ProjectRenameParams, ProtocolError, ProtocolVersion, RemoteError,
    RequestType, ResultStatus, RetryClass, RunCursor, SecretAddParams, SecretDeleteParams,
    ServerEnvelope, ServerIdentity, SessionAttachParams, SessionAutoTitleParams,
    SessionControlParams, SessionCreateParams, SessionDetachParams, SessionIdParams,
    SessionInputParams, SessionPinParams, SessionPollParams, SessionRecoveryContextParams,
    SessionRenameParams, SessionRestartParams, SessionSeenParams, SessionStopParams,
    SessionStructuredPromptParams, SessionUnreadParams, WorktreeCreateParams, WorktreeIdParams,
    WorktreePreviewParams, WorktreeProjectParams, CAPABILITY_SESSION_EVENT_PUSH, EVENT_PUSH_MINOR,
    MAX_FRAME_BYTES,
};
use agentport_service::{
    RemoteService, ServiceError, ServiceSnapshot, SessionEvent, SessionSubscription,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;
use thiserror::Error;

const WRITER_QUEUE_CAPACITY: usize = 128;
const ATTACHMENT_WRITER_QUEUE_CAPACITY: usize = 32;
const WRITER_CONTROL_QUANTUM: usize = 16;
const DISPATCH_TICK: Duration = Duration::from_millis(10);

enum WriterMessage {
    Envelope(ServerEnvelope),
    Register {
        attachment_id: String,
        events: mpsc::Receiver<ServerEnvelope>,
    },
    Unregister {
        attachment_id: String,
    },
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("diagnostic I/O failed: {0}")]
    DiagnosticIo(#[from] std::io::Error),
    #[error("hello must be the first protocol message")]
    HelloRequired,
    #[error("unexpected protocol message")]
    UnexpectedMessage,
    #[error("protocol output writer closed")]
    WriterClosed,
    #[error("protocol output writer panicked")]
    WriterPanicked,
    #[error("request precondition is missing or invalid")]
    InvalidPrecondition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    EndOfInput,
    IncompatibleProtocol,
}

#[derive(Deserialize)]
struct MessageKind {
    #[serde(rename = "type")]
    message_type: String,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListParams {
    #[serde(default)]
    include_archived: bool,
}

enum PreparedRequest {
    Boot,
    AgentSupported,
    AgentProbe(AgentProbeParams),
    AgentProbeAll(AgentProbeAllParams),
    AgentPreferences,
    AgentPreferencesReplace(AgentPreferencesReplaceParams, u64),
    PresetList(PresetListParams),
    ProjectList,
    ProjectAdd(ProjectAddParams),
    ProjectRename(ProjectRenameParams),
    ProjectLayoutReplace(ProjectLayoutReplaceParams),
    ProjectRemovePreflight(ProjectIdParams),
    ProjectRemove(ProjectRemoveParams),
    WorktreePreview(WorktreePreviewParams),
    WorktreeReconcile(WorktreeProjectParams),
    WorktreeCreate(WorktreeCreateParams),
    WorktreeList(WorktreeProjectParams),
    WorktreeRemovePreflight(WorktreeIdParams),
    WorktreeRemove(WorktreeIdParams),
    WorktreeStatus(WorktreeIdParams),
    Extended(String, Value),
    CommitAiConfigSave(CommitAiConfigSaveParams),
    DocumentWrite(DocumentWriteParams),
    SecretStatus,
    SecretList,
    SecretDelete(SecretDeleteParams),
    SessionList(SessionListParams),
    SessionAttach(SessionAttachParams),
    SessionCreate(SessionCreateParams),
    SessionRestart(SessionRestartParams),
    SessionInput(SessionInputParams),
    SessionStructuredPrompt(SessionStructuredPromptParams),
    SessionAbortStructuredTurn(SessionDetachParams),
    SessionControl(SessionControlParams),
    SessionPoll(SessionPollParams),
    SessionDetach(SessionDetachParams),
    SessionStop(SessionStopParams),
    SessionRename(SessionRenameParams),
    SessionPin(SessionPinParams),
    SessionArchive(SessionIdParams),
    SessionUnarchive(SessionIdParams),
    SessionArchivesList,
    SessionArchivesDelete(SessionIdParams),
    SessionArchivesDeleteAll,
    SessionStatusHistory(SessionIdParams),
    SessionSeenMark(SessionSeenParams),
    SessionOutputUnreadMark(SessionUnreadParams),
    AttentionPoll(AttentionPollParams),
    SessionAutoTitle(SessionAutoTitleParams),
    SessionRecoveryContextRead(SessionRecoveryContextParams),
    SecretAdd(SecretAddParams),
}

struct PushDispatcher {
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

struct ConnectionState {
    push_enabled: bool,
    enabled_capabilities: HashSet<String>,
    attachments: HashSet<String>,
    dispatchers: HashMap<String, PushDispatcher>,
}

impl PushDispatcher {
    fn is_finished(&self) -> bool {
        self.worker
            .as_ref()
            .map(|worker| worker.is_finished())
            .unwrap_or(true)
    }

    fn stop(mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl ConnectionState {
    fn prune_finished<S: RemoteService>(&mut self, service: &S) {
        let finished: Vec<String> = self
            .dispatchers
            .iter()
            .filter(|(_, dispatcher)| dispatcher.is_finished())
            .map(|(attachment_id, _)| attachment_id.clone())
            .collect();
        for attachment_id in finished {
            if let Some(dispatcher) = self.dispatchers.remove(&attachment_id) {
                dispatcher.stop();
            }
            self.attachments.remove(&attachment_id);
            // The writer-side receiver drains its already-buffered events and
            // removes itself on channel disconnect; do not unregister early.
            let _ = service.detach_session(SessionDetachParams { attachment_id });
        }
    }
}

/// Serves one framed stdio connection. A dedicated bounded writer is the only
/// owner of `output`; request results and unsolicited events can therefore
/// never interleave at the byte level.
pub fn serve<R: Read, W: Write + Send, E: Write, S: RemoteService + Sync>(
    input: &mut R,
    output: &mut W,
    diagnostics: &mut E,
    service: &S,
) -> Result<CloseReason, BridgeError> {
    diagnostics.write_all(b"agentport remote bridge: stdio mode\n")?;

    let Some(frame) = read_frame(input, MAX_FRAME_BYTES)? else {
        return Ok(CloseReason::EndOfInput);
    };
    let kind: MessageKind =
        serde_json::from_slice(frame.as_bytes()).map_err(ProtocolError::InvalidJson)?;
    if kind.message_type != "hello" {
        return Err(BridgeError::HelloRequired);
    }
    let hello: Hello =
        serde_json::from_slice(frame.as_bytes()).map_err(ProtocolError::InvalidJson)?;

    std::thread::scope(|scope| {
        let (writer_tx, writer_rx) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let writer = scope.spawn(move || writer_loop(output, writer_rx));
        let result = serve_after_hello(input, diagnostics, service, hello, &writer_tx);
        drop(writer_tx);
        let writer_result = writer.join().map_err(|_| BridgeError::WriterPanicked)?;
        match result {
            Err(error) => Err(error),
            Ok(reason) => {
                writer_result?;
                Ok(reason)
            }
        }
    })
}

fn writer_loop<W: Write>(
    output: &mut W,
    receiver: mpsc::Receiver<WriterMessage>,
) -> Result<(), BridgeError> {
    let mut subscriptions: Vec<(String, mpsc::Receiver<ServerEnvelope>)> = Vec::new();
    let mut next_subscription = 0_usize;
    let mut controls_closed = false;
    loop {
        for _ in 0..WRITER_CONTROL_QUANTUM {
            match receiver.try_recv() {
                Ok(message) => handle_writer_message(output, &mut subscriptions, message)?,
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
            }
        }
        let mut made_progress = false;
        if !subscriptions.is_empty() {
            next_subscription %= subscriptions.len();
            for checked in 0..subscriptions.len() {
                let index = (next_subscription + checked) % subscriptions.len();
                match subscriptions[index].1.try_recv() {
                    Ok(envelope) => {
                        write_frame(output, &envelope, MAX_FRAME_BYTES)?;
                        next_subscription = index.saturating_add(1);
                        made_progress = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(mpsc::TryRecvError::Disconnected) => {
                        subscriptions.remove(index);
                        next_subscription = index;
                        made_progress = true;
                        break;
                    }
                }
            }
        }
        if made_progress {
            continue;
        }
        if controls_closed {
            break;
        }
        match receiver.recv_timeout(DISPATCH_TICK) {
            Ok(message) => handle_writer_message(output, &mut subscriptions, message)?,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => controls_closed = true,
        }
    }
    Ok(())
}

fn handle_writer_message<W: Write>(
    output: &mut W,
    subscriptions: &mut Vec<(String, mpsc::Receiver<ServerEnvelope>)>,
    message: WriterMessage,
) -> Result<(), BridgeError> {
    match message {
        WriterMessage::Envelope(envelope) => write_frame(output, &envelope, MAX_FRAME_BYTES)?,
        WriterMessage::Register {
            attachment_id,
            events,
        } => {
            subscriptions.retain(|(existing, _)| existing != &attachment_id);
            subscriptions.push((attachment_id, events));
        }
        WriterMessage::Unregister { attachment_id } => {
            subscriptions.retain(|(existing, _)| existing != &attachment_id);
        }
    }
    Ok(())
}

fn serve_after_hello<R: Read, E: Write, S: RemoteService + Sync>(
    input: &mut R,
    diagnostics: &mut E,
    service: &S,
    hello: Hello,
    writer: &mpsc::SyncSender<WriterMessage>,
) -> Result<CloseReason, BridgeError> {
    let protocol = match negotiate_version(hello.protocol) {
        Ok(protocol) => protocol,
        Err(ProtocolError::IncompatibleMajor { .. }) => {
            enqueue(
                writer,
                ServerEnvelope::Incompatible {
                    supported: ProtocolVersion::V1,
                    message:
                        "incompatible protocol major; upgrade AgentPort Mobile or the remote host"
                            .into(),
                },
            )?;
            diagnostics.write_all(b"agentport remote bridge: incompatible protocol\n")?;
            return Ok(CloseReason::IncompatibleProtocol);
        }
        Err(error) => return Err(error.into()),
    };

    let hello_result = hello_result(
        protocol,
        service.service_snapshot(),
        &hello.requested_capabilities,
    );
    let push_requested = hello
        .requested_capabilities
        .iter()
        .any(|name| name == CAPABILITY_SESSION_EVENT_PUSH);
    let push_enabled = push_requested
        && hello_result.capabilities.iter().any(|capability| {
            capability.name == CAPABILITY_SESSION_EVENT_PUSH && capability.enabled
        });
    let enabled_capabilities = hello_result
        .capabilities
        .iter()
        .filter(|capability| capability.enabled)
        .map(|capability| capability.name.clone())
        .collect();
    enqueue(writer, ServerEnvelope::Hello(hello_result))?;

    let mut server_sequence = 0_u64;
    let mut connection = ConnectionState {
        push_enabled,
        enabled_capabilities,
        attachments: HashSet::new(),
        dispatchers: HashMap::new(),
    };
    let request_result = loop {
        let frame = match read_frame(input, MAX_FRAME_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => break Ok(CloseReason::EndOfInput),
            Err(error) => break Err(error.into()),
        };
        let kind: MessageKind = match serde_json::from_slice(frame.as_bytes()) {
            Ok(kind) => kind,
            Err(error) => break Err(ProtocolError::InvalidJson(error).into()),
        };
        if kind.message_type != "request" {
            break Err(BridgeError::UnexpectedMessage);
        }
        let request = match borrow_request(frame.as_bytes()) {
            Ok(request) => request,
            Err(error) => break Err(error.into()),
        };
        if request.message_type != RequestType::Request {
            break Err(BridgeError::UnexpectedMessage);
        }
        server_sequence = server_sequence.saturating_add(1);
        if let Err(error) = handle_request(
            writer,
            diagnostics,
            service,
            request,
            server_sequence,
            &mut connection,
        ) {
            break Err(error);
        }
    };

    // A stdio connection owns only its remote Host attachments. Detaching them
    // closes those subscriptions but never stops the underlying Sessions.
    for (attachment_id, dispatcher) in connection.dispatchers.drain() {
        dispatcher.stop();
        let _ = writer.send(WriterMessage::Unregister { attachment_id });
    }
    for attachment_id in connection.attachments.drain() {
        let _ = service.detach_session(SessionDetachParams { attachment_id });
    }
    if matches!(request_result, Ok(CloseReason::EndOfInput)) {
        diagnostics.write_all(b"agentport remote bridge: input closed\n")?;
    }
    request_result
}

fn hello_result(
    protocol: ProtocolVersion,
    service: ServiceSnapshot,
    requested: &[String],
) -> HelloResult {
    let mut capabilities: Vec<Capability> = service
        .capabilities
        .into_iter()
        .filter(|capability| {
            if capability.name == CAPABILITY_SESSION_EVENT_PUSH {
                requested
                    .iter()
                    .any(|name| name == CAPABILITY_SESSION_EVENT_PUSH)
            } else {
                requested.is_empty() || requested.iter().any(|name| name == &capability.name)
            }
        })
        .map(|capability| {
            if capability.name == CAPABILITY_SESSION_EVENT_PUSH && protocol.minor < EVENT_PUSH_MINOR
            {
                Capability {
                    name: capability.name,
                    enabled: false,
                    disabled_reason: Some("capability requires protocol 1.1 or newer".into()),
                }
            } else {
                Capability {
                    name: capability.name,
                    enabled: capability.enabled,
                    disabled_reason: capability.disabled_reason,
                }
            }
        })
        .collect();

    for requested_name in requested {
        if !capabilities
            .iter()
            .any(|capability| &capability.name == requested_name)
        {
            capabilities.push(Capability {
                name: requested_name.clone(),
                enabled: false,
                disabled_reason: Some("capability is not supported by this host".into()),
            });
        }
    }

    HelloResult {
        protocol,
        server: ServerIdentity {
            agentport_version: env!("CARGO_PKG_VERSION").into(),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        },
        capabilities,
        limits: Limits {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_subscriptions: service.limits.max_subscriptions,
            max_host_clients: service.limits.max_host_clients,
        },
    }
}

fn handle_request<E: Write, S: RemoteService + Sync>(
    writer: &mpsc::SyncSender<WriterMessage>,
    diagnostics: &mut E,
    service: &S,
    request: agentport_remote_protocol::BorrowedRequest<'_>,
    server_sequence: u64,
    connection: &mut ConnectionState,
) -> Result<(), BridgeError> {
    connection.prune_finished(service);
    let retry_class = classify_method(request.method);
    if retry_class == RetryClass::Unknown {
        return write_result(
            writer,
            request.request_id,
            None,
            ResultStatus::NotExecuted,
            retry_class,
            None,
            Some(RemoteError {
                code: "unknown_method".into(),
                message: "method is not supported by this bridge".into(),
            }),
        );
    }

    let prepared = match prepare_request(
        request.method,
        request.params.get(),
        request.precondition.as_ref(),
    )? {
        Some(prepared) => prepared,
        None => {
            return write_result(
                writer,
                request.request_id,
                None,
                ResultStatus::NotExecuted,
                retry_class,
                None,
                Some(RemoteError {
                    code: "capability_disabled".into(),
                    message: "method is defined but its service slice is not available".into(),
                }),
            );
        }
    };

    if matches!(
        &prepared,
        PreparedRequest::SessionControl(SessionControlParams {
            expected_revision: Some(_),
            ..
        })
    ) && !connection
        .enabled_capabilities
        .contains(agentport_remote_protocol::CAPABILITY_TERMINAL_GEOMETRY)
    {
        return write_result(
            writer,
            request.request_id,
            None,
            ResultStatus::NotExecuted,
            retry_class,
            None,
            Some(RemoteError {
                code: "capability_disabled".into(),
                message: "terminal geometry capability was not negotiated".into(),
            }),
        );
    }

    let operation_id = format!("op-{server_sequence}");
    enqueue(
        writer,
        ServerEnvelope::Accepted {
            request_id: request.request_id.into(),
            operation_id: operation_id.clone(),
            server_sequence,
            retry_class: retry_class.clone(),
        },
    )?;

    if let PreparedRequest::SessionDetach(params) = prepared {
        connection.attachments.remove(&params.attachment_id);
        if let Some(dispatcher) = connection.dispatchers.remove(&params.attachment_id) {
            dispatcher.stop();
        }
        writer
            .send(WriterMessage::Unregister {
                attachment_id: params.attachment_id.clone(),
            })
            .map_err(|_| BridgeError::WriterClosed)?;
        let result = service
            .detach_session(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded));
        return finish_result(
            writer,
            diagnostics,
            request.request_id,
            operation_id,
            retry_class,
            result,
        );
    }

    if let PreparedRequest::SessionAttach(params) = prepared {
        let result = service.attach_session(params).and_then(|value| {
            let subscription = if connection.push_enabled {
                match service.subscribe_session(&value.attachment_id) {
                    Ok(subscription) => Some(subscription),
                    Err(error) => {
                        let _ = service.detach_session(SessionDetachParams {
                            attachment_id: value.attachment_id,
                        });
                        return Err(error);
                    }
                }
            } else {
                None
            };
            serialize_service_value(value, ResultStatus::Succeeded)
                .map(|serialized| (serialized, subscription))
        });
        return match result {
            Ok(((value, status), subscription)) => {
                let attachment_id = value
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .ok_or(BridgeError::UnexpectedMessage)?
                    .to_string();
                write_result(
                    writer,
                    request.request_id,
                    Some(operation_id),
                    status,
                    retry_class,
                    Some(value),
                    None,
                )?;
                // Starting only after the Result is queued is the publication
                // barrier: even an already-buffered Host event follows it.
                connection.attachments.insert(attachment_id.clone());
                if let Some(subscription) = subscription {
                    connection.dispatchers.insert(
                        attachment_id.clone(),
                        spawn_dispatcher(attachment_id, subscription, writer.clone())?,
                    );
                }
                Ok(())
            }
            Err(error) => finish_service_error(
                writer,
                diagnostics,
                request.request_id,
                operation_id,
                retry_class,
                error,
            ),
        };
    }

    let result: agentport_service::Result<(Value, ResultStatus)> = match prepared {
        PreparedRequest::Boot => service
            .boot()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::AgentSupported => service
            .supported_agents()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::AgentProbe(params) => service
            .probe_agent(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::AgentProbeAll(params) => service
            .probe_all_agents(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::AgentPreferences => service
            .agent_preferences()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::AgentPreferencesReplace(params, revision) => service
            .replace_agent_preferences(params, revision)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::PresetList(params) => service
            .list_presets(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectList => service
            .list_projects()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectAdd(params) => service
            .add_project(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectRename(params) => service
            .rename_project(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectLayoutReplace(params) => service
            .replace_project_layout(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectRemovePreflight(params) => service
            .project_remove_preflight(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::ProjectRemove(params) => service
            .remove_project(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreePreview(params) => service
            .preview_worktree(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeReconcile(params) => service
            .reconcile_worktrees(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeCreate(params) => service
            .create_worktree(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeList(params) => service
            .list_worktrees(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeRemovePreflight(params) => service
            .worktree_remove_preflight(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeRemove(params) => service
            .remove_worktree(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::WorktreeStatus(params) => service
            .worktree_status(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::Extended(method, params) => service
            .extended_facade(&method, params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::CommitAiConfigSave(params) => service
            .save_commit_ai_config(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::DocumentWrite(params) => service
            .write_document(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SecretStatus => service
            .secret_backend_status()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SecretList => service
            .list_secrets()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SecretDelete(params) => service
            .delete_secret(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionList(params) => service
            .list_sessions(params.include_archived)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionCreate(params) => service
            .create_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionRestart(params) => service
            .restart_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionInput(params) => service.input_session(params).and_then(|value| {
            let status = if value.phase == "not_executed" {
                ResultStatus::NotExecuted
            } else {
                ResultStatus::Succeeded
            };
            serialize_service_value(value, status)
        }),
        PreparedRequest::SessionStructuredPrompt(params) => service
            .structured_prompt(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionAbortStructuredTurn(params) => service
            .abort_structured_turn(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionControl(params) => service
            .control_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionPoll(params) => service
            .poll_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionStop(params) => service
            .stop_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionRename(params) => service
            .rename_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionPin(params) => service
            .pin_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionArchive(params) => service
            .archive_session(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionUnarchive(params) => service
            .unarchive_session(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionArchivesList => service
            .list_archived_sessions()
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionArchivesDelete(params) => service
            .delete_archived_session(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionArchivesDeleteAll => service
            .delete_all_archived_sessions()
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionStatusHistory(params) => service
            .session_status_history(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionSeenMark(params) => service
            .mark_session_seen(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::SessionOutputUnreadMark(params) => service
            .mark_session_output_unread(params)
            .and_then(|()| serialize_service_value(serde_json::json!({}), ResultStatus::Succeeded)),
        PreparedRequest::AttentionPoll(params) => service
            .poll_attention(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionAutoTitle(params) => service
            .auto_title_session(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionRecoveryContextRead(params) => service
            .read_recovery_context(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SecretAdd(params) => service
            .add_secret(params)
            .and_then(|value| serialize_service_value(value, ResultStatus::Succeeded)),
        PreparedRequest::SessionAttach(_) | PreparedRequest::SessionDetach(_) => unreachable!(),
    };

    finish_result(
        writer,
        diagnostics,
        request.request_id,
        operation_id,
        retry_class,
        result,
    )
}

fn spawn_dispatcher(
    attachment_id: String,
    subscription: SessionSubscription,
    writer: mpsc::SyncSender<WriterMessage>,
) -> Result<PushDispatcher, BridgeError> {
    let (event_writer, event_reader) = mpsc::sync_channel(ATTACHMENT_WRITER_QUEUE_CAPACITY);
    writer
        .send(WriterMessage::Register {
            attachment_id: attachment_id.clone(),
            events: event_reader,
        })
        .map_err(|_| BridgeError::WriterClosed)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker = std::thread::spawn(move || {
        'dispatch: loop {
            if worker_cancel.load(Ordering::Acquire) {
                break;
            }
            match subscription.recv_timeout(DISPATCH_TICK) {
                Ok(event) => {
                    let mut pending = event_envelope(&attachment_id, event);
                    loop {
                        if worker_cancel.load(Ordering::Acquire) {
                            break 'dispatch;
                        }
                        match event_writer.try_send(pending) {
                            Ok(()) => break,
                            Err(mpsc::TrySendError::Full(envelope)) => {
                                // Hold one event and stop reading upstream. A replay
                                // burst must apply backpressure, not become a gap.
                                pending = envelope;
                                std::thread::sleep(Duration::from_millis(1));
                            }
                            Err(mpsc::TrySendError::Disconnected(_)) => break 'dispatch,
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(PushDispatcher {
        cancel,
        worker: Some(worker),
    })
}

fn event_envelope(attachment_id: &str, event: SessionEvent) -> ServerEnvelope {
    ServerEnvelope::Event(Event {
        subscription_id: attachment_id.into(),
        event_type: event.event_type,
        cursor: event.cursor,
        payload: event.payload,
    })
}

fn prepare_request(
    method: &str,
    params: &str,
    precondition: Option<&Precondition>,
) -> Result<Option<PreparedRequest>, BridgeError> {
    let empty = || -> Result<(), BridgeError> {
        serde_json::from_str::<EmptyParams>(params)
            .map(|_| ())
            .map_err(|error| ProtocolError::InvalidJson(error).into())
    };
    let revision = || -> Result<u64, BridgeError> {
        precondition
            .filter(|value| value.cursor.is_none())
            .and_then(|value| value.revision.as_ref())
            .and_then(|value| value.as_u64())
            .ok_or(BridgeError::InvalidPrecondition)
    };
    let parsed = match method {
        // Preserve v1.0 behavior: boot historically ignored additive params.
        "boot" => PreparedRequest::Boot,
        "agent.supported" => {
            empty()?;
            PreparedRequest::AgentSupported
        }
        "agent.probe" => PreparedRequest::AgentProbe(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "agent.probe_all" => PreparedRequest::AgentProbeAll(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "agent.preferences" => {
            empty()?;
            PreparedRequest::AgentPreferences
        }
        "agent.preferences.replace" => PreparedRequest::AgentPreferencesReplace(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
            revision()?,
        ),
        "preset.list" => PreparedRequest::PresetList(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "project.list" => {
            empty()?;
            PreparedRequest::ProjectList
        }
        "project.add" => PreparedRequest::ProjectAdd(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "project.rename" => PreparedRequest::ProjectRename(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "project.layout.replace" => PreparedRequest::ProjectLayoutReplace(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "project.remove.preflight" => PreparedRequest::ProjectRemovePreflight(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "project.remove" => {
            let value: ProjectRemoveParams =
                serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?;
            if revision()?.to_string() != value.revision {
                return Err(BridgeError::InvalidPrecondition);
            }
            PreparedRequest::ProjectRemove(value)
        }
        "worktree.preview" => PreparedRequest::WorktreePreview(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.reconcile" => PreparedRequest::WorktreeReconcile(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.create" => PreparedRequest::WorktreeCreate(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.list" => PreparedRequest::WorktreeList(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.remove.preflight" => PreparedRequest::WorktreeRemovePreflight(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.remove" => PreparedRequest::WorktreeRemove(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "worktree.status" => PreparedRequest::WorktreeStatus(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        method @ ("git.context.resolve"
        | "git.worktree.branch.adopt"
        | "git.changes"
        | "git.diff"
        | "git.history"
        | "git.commit.detail"
        | "git.commit.diff"
        | "git.stage"
        | "git.unstage"
        | "git.discard"
        | "git.ignore"
        | "git.trash"
        | "git.file.resolve"
        | "git.remote.sync"
        | "git.commit.prepare"
        | "git.commit.execute"
        | "git.commit.reconcile"
        | "branch.status"
        | "branch.list"
        | "branch.create"
        | "branch.create_switch"
        | "branch.switch"
        | "branch.delete"
        | "branch.autostash.list"
        | "branch.autostash.restore"
        | "branch.autostash.cleanup"
        | "commit_ai.config.get"
        | "commit_ai.key.clear"
        | "commit_ai.generate"
        | "search.global"
        | "search.session"
        | "history.page"
        | "storage.legacy.inventory"
        | "storage.legacy.delete"
        | "search.index.rebuild"
        | "timeline.get"
        | "timeline.ack"
        | "settings.get"
        | "settings.save"
        | "diagnostics.hosts"
        | "diagnostics.summary"
        | "diagnostics.capabilities"
        | "export.session"
        | "backup.create"
        | "backup.list"
        | "backup.verify"
        | "backup.restore"
        | "document.read"
        | "document.list"
        | "document.create") => PreparedRequest::Extended(
            method.into(),
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "commit_ai.config.save" => PreparedRequest::CommitAiConfigSave(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "document.write" => PreparedRequest::DocumentWrite(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "secret.status" => {
            empty()?;
            PreparedRequest::SecretStatus
        }
        "secret.list" => {
            empty()?;
            PreparedRequest::SecretList
        }
        "secret.delete" => PreparedRequest::SecretDelete(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.list" => PreparedRequest::SessionList(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.attach" => PreparedRequest::SessionAttach(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.create" => PreparedRequest::SessionCreate(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.restart" => PreparedRequest::SessionRestart(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.input" => PreparedRequest::SessionInput(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.structured_input" => PreparedRequest::SessionStructuredPrompt(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.turn.abort" => PreparedRequest::SessionAbortStructuredTurn(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.control" => PreparedRequest::SessionControl(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.poll" => PreparedRequest::SessionPoll(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.detach" => PreparedRequest::SessionDetach(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.stop" => PreparedRequest::SessionStop(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.rename" => PreparedRequest::SessionRename(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.pin" => PreparedRequest::SessionPin(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.archive" => PreparedRequest::SessionArchive(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.unarchive" => PreparedRequest::SessionUnarchive(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.archives.list" => {
            empty()?;
            PreparedRequest::SessionArchivesList
        }
        "session.archives.delete" => PreparedRequest::SessionArchivesDelete(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.archives.delete_all" => {
            empty()?;
            PreparedRequest::SessionArchivesDeleteAll
        }
        "session.status.history" => PreparedRequest::SessionStatusHistory(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.seen.mark" => PreparedRequest::SessionSeenMark(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.output.unread.mark" => PreparedRequest::SessionOutputUnreadMark(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "attention.poll" => PreparedRequest::AttentionPoll(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.auto_title" => PreparedRequest::SessionAutoTitle(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "session.recovery_context.read" => PreparedRequest::SessionRecoveryContextRead(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        "secret.add" => PreparedRequest::SecretAdd(
            serde_json::from_str(params).map_err(ProtocolError::InvalidJson)?,
        ),
        _ => return Ok(None),
    };
    Ok(Some(parsed))
}

fn serialize_service_value<T: serde::Serialize>(
    value: T,
    status: ResultStatus,
) -> agentport_service::Result<(Value, ResultStatus)> {
    serde_json::to_value(value)
        .map(|value| (value, status))
        .map_err(|_| ServiceError::Serialization)
}

fn finish_result<E: Write>(
    writer: &mpsc::SyncSender<WriterMessage>,
    diagnostics: &mut E,
    request_id: &str,
    operation_id: String,
    retry_class: RetryClass,
    result: agentport_service::Result<(Value, ResultStatus)>,
) -> Result<(), BridgeError> {
    match result {
        Ok((value, status)) => write_result(
            writer,
            request_id,
            Some(operation_id),
            status,
            retry_class,
            Some(value),
            None,
        ),
        Err(error) => finish_service_error(
            writer,
            diagnostics,
            request_id,
            operation_id,
            retry_class,
            error,
        ),
    }
}

fn finish_service_error<E: Write>(
    writer: &mpsc::SyncSender<WriterMessage>,
    diagnostics: &mut E,
    request_id: &str,
    operation_id: String,
    retry_class: RetryClass,
    error: ServiceError,
) -> Result<(), BridgeError> {
    diagnostics.write_all(b"agentport remote bridge: service request failed\n")?;
    let (status, code) = service_error_result(&error, &retry_class);
    write_result(
        writer,
        request_id,
        Some(operation_id),
        status,
        retry_class,
        None,
        Some(RemoteError {
            code: code.into(),
            message: "request failed on the remote host".into(),
        }),
    )
}

fn service_error_result(
    error: &ServiceError,
    retry_class: &RetryClass,
) -> (ResultStatus, &'static str) {
    match error {
        ServiceError::AttachmentNotFound
        | ServiceError::NotExecutedCore(_)
        | ServiceError::InvalidRequest
        | ServiceError::PreconditionFailed
        | ServiceError::RiskAcknowledgementRequired => {
            (ResultStatus::NotExecuted, "request_not_executed")
        }
        ServiceError::InputOutcomeUnknown | ServiceError::CommitAiOutcomeUnknown => {
            (ResultStatus::Unknown, "result_unknown")
        }
        ServiceError::Core(_) if *retry_class == RetryClass::NonIdempotentWrite => {
            (ResultStatus::Unknown, "result_unknown")
        }
        ServiceError::Core(_)
        | ServiceError::AttachmentState
        | ServiceError::Serialization
        | ServiceError::CommitAi(_) => (ResultStatus::Failed, "service_error"),
    }
}

fn enqueue(
    writer: &mpsc::SyncSender<WriterMessage>,
    envelope: ServerEnvelope,
) -> Result<(), BridgeError> {
    writer
        .send(WriterMessage::Envelope(envelope))
        .map_err(|_| BridgeError::WriterClosed)
}

fn write_result(
    writer: &mpsc::SyncSender<WriterMessage>,
    request_id: &str,
    operation_id: Option<String>,
    status: ResultStatus,
    retry_class: RetryClass,
    value: Option<Value>,
    error: Option<RemoteError>,
) -> Result<(), BridgeError> {
    enqueue(
        writer,
        ServerEnvelope::Result {
            request_id: request_id.into(),
            operation_id,
            status,
            retry_class,
            value,
            error,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentport_remote_protocol::{read_frame, HelloType, METHOD_REGISTRY};
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;
    use std::time::Instant;

    struct FixtureService;

    impl RemoteService for FixtureService {
        fn service_snapshot(&self) -> ServiceSnapshot {
            ServiceSnapshot::default()
        }

        fn boot(&self) -> agentport_service::Result<agentport_service::BootSnapshot> {
            Ok(agentport_service::BootSnapshot {
                reconciled_sessions: 0,
                service: self.service_snapshot(),
                projects: Vec::new(),
                sessions: Vec::new(),
            })
        }

        fn list_sessions(
            &self,
            _include_archived: bool,
        ) -> agentport_service::Result<Vec<agentport_service::SessionSummary>> {
            Ok(Vec::new())
        }

        fn attach_session(
            &self,
            _params: SessionAttachParams,
        ) -> agentport_service::Result<agentport_service::SessionAttachResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn subscribe_session(
            &self,
            _attachment_id: &str,
        ) -> agentport_service::Result<agentport_service::SessionSubscription> {
            Err(ServiceError::InvalidRequest)
        }

        fn input_session(
            &self,
            _params: SessionInputParams,
        ) -> agentport_service::Result<agentport_service::SessionInputResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn structured_prompt(
            &self,
            _params: SessionStructuredPromptParams,
        ) -> agentport_service::Result<()> {
            Err(ServiceError::InvalidRequest)
        }

        fn abort_structured_turn(
            &self,
            _params: SessionDetachParams,
        ) -> agentport_service::Result<()> {
            Err(ServiceError::InvalidRequest)
        }

        fn control_session(
            &self,
            _params: SessionControlParams,
        ) -> agentport_service::Result<agentport_service::SessionControlResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn poll_session(
            &self,
            _params: SessionPollParams,
        ) -> agentport_service::Result<agentport_service::SessionPollResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn detach_session(&self, _params: SessionDetachParams) -> agentport_service::Result<()> {
            Err(ServiceError::InvalidRequest)
        }

        fn stop_session(
            &self,
            _params: SessionStopParams,
        ) -> agentport_service::Result<agentport_service::SessionStopResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn add_secret(
            &self,
            _params: SecretAddParams,
        ) -> agentport_service::Result<agentport_service::SecretAddResult> {
            Err(ServiceError::InvalidRequest)
        }
    }

    fn append<T: serde::Serialize>(target: &mut Vec<u8>, value: &T) {
        write_frame(target, value, MAX_FRAME_BYTES).unwrap();
    }

    fn hello(version: ProtocolVersion) -> Hello {
        Hello {
            message_type: HelloType::Hello,
            protocol: version,
            client: agentport_remote_protocol::ClientIdentity {
                name: "test".into(),
                version: "1".into(),
            },
            requested_capabilities: vec!["session.read".into(), "future.capability".into()],
        }
    }

    #[test]
    fn incompatible_handshake_replies_then_closes() {
        let mut input_bytes = Vec::new();
        append(
            &mut input_bytes,
            &hello(ProtocolVersion { major: 9, minor: 0 }),
        );
        append(
            &mut input_bytes,
            &json!({"type":"request","requestId":"ignored","method":"boot","params":{}}),
        );
        let mut input = Cursor::new(input_bytes);
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        let reason = serve(&mut input, &mut output, &mut diagnostics, &FixtureService).unwrap();
        assert_eq!(reason, CloseReason::IncompatibleProtocol);
        let frame = read_frame(&mut Cursor::new(output), MAX_FRAME_BYTES)
            .unwrap()
            .unwrap();
        let message: ServerEnvelope = serde_json::from_slice(frame.as_bytes()).unwrap();
        assert!(matches!(message, ServerEnvelope::Incompatible { .. }));
    }

    #[test]
    fn secret_payload_never_reaches_stdout_or_stderr() {
        let marker = "SECRET_MARKER_DO_NOT_LOG";
        let mut input_bytes = Vec::new();
        append(&mut input_bytes, &hello(ProtocolVersion::V1));
        append(
            &mut input_bytes,
            &json!({
                "type": "request", "requestId": "r-secret", "method": "secret.add",
                "params": {"envName": "TOKEN", "presetId": "pre_1", "value": marker}
            }),
        );
        let mut input = Cursor::new(input_bytes);
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        serve(&mut input, &mut output, &mut diagnostics, &FixtureService).unwrap();
        assert!(!String::from_utf8_lossy(&output).contains(marker));
        assert!(!String::from_utf8_lossy(&diagnostics).contains(marker));
    }

    #[test]
    fn batch_one_facade_registry_is_fully_prepared_and_dispatched() {
        let requests = vec![
            json!({"type":"request","requestId":"r1","method":"agent.supported","params":{}}),
            json!({"type":"request","requestId":"r2","method":"agent.probe","params":{"agent":"shell"}}),
            json!({"type":"request","requestId":"r3","method":"agent.probe_all","params":{"preserveSelections":true}}),
            json!({"type":"request","requestId":"r4","method":"agent.preferences","params":{}}),
            json!({"type":"request","requestId":"r5","method":"agent.preferences.replace","params":{"agentOrder":["shell"],"agentHidden":[]},"precondition":{"revision":0}}),
            json!({"type":"request","requestId":"r6","method":"preset.list","params":{}}),
            json!({"type":"request","requestId":"r7","method":"project.list","params":{}}),
            json!({"type":"request","requestId":"r8","method":"project.add","params":{"path":"/tmp"}}),
            json!({"type":"request","requestId":"r9","method":"project.rename","params":{"projectId":"prj_1","name":"name"}}),
            json!({"type":"request","requestId":"r10","method":"project.layout.replace","params":{"entries":[]}}),
            json!({"type":"request","requestId":"r11","method":"project.remove.preflight","params":{"projectId":"prj_1"}}),
            json!({"type":"request","requestId":"r12","method":"project.remove","params":{"projectId":"prj_1","revision":"7","sessions":[],"worktreeIds":[],"recoverableOperationIds":[],"pendingCommitOperationIds":[]},"precondition":{"revision":"7"}}),
            json!({"type":"request","requestId":"r13","method":"secret.status","params":{}}),
            json!({"type":"request","requestId":"r14","method":"secret.list","params":{}}),
            json!({"type":"request","requestId":"r15","method":"secret.add","params":{"envName":"TOKEN","presetId":"pre_1","value":"SECRET_DISPATCH_MARKER"}}),
            json!({"type":"request","requestId":"r16","method":"secret.delete","params":{"id":"sec_1"}}),
            json!({"type":"request","requestId":"r17","method":"worktree.preview","params":{"projectId":"prj_1","task":"task"}}),
            json!({"type":"request","requestId":"r18","method":"worktree.reconcile","params":{"projectId":"prj_1"}}),
            json!({"type":"request","requestId":"r19","method":"worktree.create","params":{"projectId":"prj_1","task":"task","branchMode":"auto"}}),
            json!({"type":"request","requestId":"r20","method":"worktree.list","params":{"projectId":"prj_1"}}),
            json!({"type":"request","requestId":"r21","method":"worktree.remove.preflight","params":{"worktreeId":"wt_1"}}),
            json!({"type":"request","requestId":"r22","method":"worktree.remove","params":{"worktreeId":"wt_1"}}),
            json!({"type":"request","requestId":"r23","method":"worktree.status","params":{"worktreeId":"wt_1"}}),
            json!({"type":"request","requestId":"g1","method":"git.context.resolve","params":{}}),
            json!({"type":"request","requestId":"g2","method":"git.worktree.branch.adopt","params":{}}),
            json!({"type":"request","requestId":"g3","method":"git.changes","params":{}}),
            json!({"type":"request","requestId":"g4","method":"git.diff","params":{}}),
            json!({"type":"request","requestId":"g5","method":"git.history","params":{}}),
            json!({"type":"request","requestId":"g6","method":"git.commit.detail","params":{}}),
            json!({"type":"request","requestId":"g7","method":"git.commit.diff","params":{}}),
            json!({"type":"request","requestId":"g8","method":"git.stage","params":{}}),
            json!({"type":"request","requestId":"g9","method":"git.unstage","params":{}}),
            json!({"type":"request","requestId":"g10","method":"git.discard","params":{}}),
            json!({"type":"request","requestId":"g11","method":"git.ignore","params":{}}),
            json!({"type":"request","requestId":"g12","method":"git.trash","params":{}}),
            json!({"type":"request","requestId":"g13","method":"git.file.resolve","params":{}}),
            json!({"type":"request","requestId":"g14","method":"git.remote.sync","params":{}}),
            json!({"type":"request","requestId":"g15","method":"git.commit.prepare","params":{}}),
            json!({"type":"request","requestId":"g16","method":"git.commit.execute","params":{}}),
            json!({"type":"request","requestId":"g17","method":"git.commit.reconcile","params":{}}),
            json!({"type":"request","requestId":"b1","method":"branch.status","params":{}}),
            json!({"type":"request","requestId":"b2","method":"branch.list","params":{}}),
            json!({"type":"request","requestId":"b3","method":"branch.create","params":{}}),
            json!({"type":"request","requestId":"b4","method":"branch.create_switch","params":{}}),
            json!({"type":"request","requestId":"b5","method":"branch.switch","params":{}}),
            json!({"type":"request","requestId":"b6","method":"branch.delete","params":{}}),
            json!({"type":"request","requestId":"b7","method":"branch.autostash.list","params":{}}),
            json!({"type":"request","requestId":"b8","method":"branch.autostash.restore","params":{}}),
            json!({"type":"request","requestId":"b9","method":"branch.autostash.cleanup","params":{}}),
            json!({"type":"request","requestId":"c1","method":"commit_ai.config.get","params":{}}),
            json!({"type":"request","requestId":"c2","method":"commit_ai.config.save","params":{"provider":"openai","baseUrl":"https://example.invalid/v1","model":"model","apiKey":"COMMIT_AI_KEY_DO_NOT_ECHO","language":"en"}}),
            json!({"type":"request","requestId":"c3","method":"commit_ai.key.clear","params":{}}),
            json!({"type":"request","requestId":"c4","method":"commit_ai.generate","params":{}}),
            json!({"type":"request","requestId":"h1","method":"search.global","params":{}}),
            json!({"type":"request","requestId":"h2","method":"search.session","params":{}}),
            json!({"type":"request","requestId":"h3","method":"history.page","params":{}}),
            json!({"type":"request","requestId":"h4","method":"storage.legacy.inventory","params":{}}),
            json!({"type":"request","requestId":"h5","method":"storage.legacy.delete","params":{}}),
            json!({"type":"request","requestId":"h6","method":"search.index.rebuild","params":{}}),
            json!({"type":"request","requestId":"h7","method":"timeline.get","params":{}}),
            json!({"type":"request","requestId":"h8","method":"timeline.ack","params":{}}),
            json!({"type":"request","requestId":"h9","method":"settings.get","params":{}}),
            json!({"type":"request","requestId":"h10","method":"settings.save","params":{}}),
            json!({"type":"request","requestId":"h11","method":"diagnostics.hosts","params":{}}),
            json!({"type":"request","requestId":"h12","method":"diagnostics.summary","params":{}}),
            json!({"type":"request","requestId":"h13","method":"diagnostics.capabilities","params":{}}),
            json!({"type":"request","requestId":"e1","method":"export.session","params":{}}),
            json!({"type":"request","requestId":"e2","method":"backup.create","params":{}}),
            json!({"type":"request","requestId":"e3","method":"backup.list","params":{}}),
            json!({"type":"request","requestId":"e4","method":"backup.verify","params":{}}),
            json!({"type":"request","requestId":"e5","method":"backup.restore","params":{}}),
            json!({"type":"request","requestId":"d1","method":"document.read","params":{}}),
            json!({"type":"request","requestId":"d2","method":"document.write","params":{"path":"/tmp/doc","content":"DOCUMENT_CONTENT_DO_NOT_ECHO"}}),
            json!({"type":"request","requestId":"d3","method":"document.list","params":{}}),
            json!({"type":"request","requestId":"d4","method":"document.create","params":{}}),
        ];
        let facade_methods = requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(facade_methods
            .iter()
            .all(|method| METHOD_REGISTRY.contains(method)));
        let mut input_bytes = Vec::new();
        append(&mut input_bytes, &hello(ProtocolVersion::V1));
        for request in &requests {
            append(&mut input_bytes, request);
        }
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        serve(
            &mut Cursor::new(input_bytes),
            &mut output,
            &mut diagnostics,
            &FixtureService,
        )
        .unwrap();
        let messages = {
            let shared = SharedOutput(Arc::new(Mutex::new(output.clone())));
            frames(&shared)
        };
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message, ServerEnvelope::Accepted { .. }))
                .count(),
            requests.len()
        );
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message, ServerEnvelope::Result { .. }))
                .count(),
            requests.len()
        );
        assert!(!String::from_utf8_lossy(&output).contains("SECRET_DISPATCH_MARKER"));
        assert!(!String::from_utf8_lossy(&diagnostics).contains("SECRET_DISPATCH_MARKER"));
        assert!(!String::from_utf8_lossy(&output).contains("COMMIT_AI_KEY_DO_NOT_ECHO"));
        assert!(!String::from_utf8_lossy(&diagnostics).contains("COMMIT_AI_KEY_DO_NOT_ECHO"));
        assert!(!String::from_utf8_lossy(&output).contains("DOCUMENT_CONTENT_DO_NOT_ECHO"));
        assert!(!String::from_utf8_lossy(&diagnostics).contains("DOCUMENT_CONTENT_DO_NOT_ECHO"));
    }

    #[test]
    fn batch_two_session_facade_is_fully_prepared_and_dispatched_without_secret_echo() {
        let marker = "STRUCTURED_PROMPT_DO_NOT_ECHO";
        let requests = vec![
            json!({"type":"request","requestId":"s0a","method":"session.create","params":{"projectId":"prj_1","agent":"shell","permission":"native","riskAck":false}}),
            json!({"type":"request","requestId":"s0b","method":"session.restart","params":{"sessionId":"ses_1","riskAck":false}}),
            json!({"type":"request","requestId":"s1","method":"session.structured_input","params":{"attachmentId":"att_1","text":marker}}),
            json!({"type":"request","requestId":"s2","method":"session.turn.abort","params":{"attachmentId":"att_1"}}),
            json!({"type":"request","requestId":"s3","method":"session.rename","params":{"sessionId":"ses_1","title":"title"}}),
            json!({"type":"request","requestId":"s4","method":"session.pin","params":{"sessionId":"ses_1","pinned":true}}),
            json!({"type":"request","requestId":"s5","method":"session.archive","params":{"sessionId":"ses_1"}}),
            json!({"type":"request","requestId":"s6","method":"session.unarchive","params":{"sessionId":"ses_1"}}),
            json!({"type":"request","requestId":"s7","method":"session.archives.list","params":{}}),
            json!({"type":"request","requestId":"s8","method":"session.archives.delete","params":{"sessionId":"ses_1"}}),
            json!({"type":"request","requestId":"s9","method":"session.archives.delete_all","params":{}}),
            json!({"type":"request","requestId":"s10","method":"session.status.history","params":{"sessionId":"ses_1"}}),
            json!({"type":"request","requestId":"s11","method":"session.seen.mark","params":{"sessionId":"ses_1","cursor":{"runId":"run_1","runOrdinal":1,"sequence":2}}}),
            json!({"type":"request","requestId":"s12","method":"session.output.unread.mark","params":{"sessionId":"ses_1","cursor":{"runId":"run_1","runOrdinal":1,"generation":0,"offset":3,"statusSequence":2}}}),
            json!({"type":"request","requestId":"s13","method":"session.auto_title","params":{"sessionId":"ses_1","input":"AUTO_TITLE_DO_NOT_ECHO"}}),
            json!({"type":"request","requestId":"s14","method":"session.recovery_context.read","params":{"sessionId":"ses_1","cursor":{"runId":"run_1","runOrdinal":1,"generation":0,"offset":3,"statusSequence":2}}}),
        ];
        let mut input_bytes = Vec::new();
        append(&mut input_bytes, &hello(ProtocolVersion::V1));
        for request in &requests {
            append(&mut input_bytes, request);
        }
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        serve(
            &mut Cursor::new(input_bytes),
            &mut output,
            &mut diagnostics,
            &FixtureService,
        )
        .unwrap();
        let messages = {
            let shared = SharedOutput(Arc::new(Mutex::new(output.clone())));
            frames(&shared)
        };
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message, ServerEnvelope::Accepted { .. }))
                .count(),
            requests.len()
        );
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message, ServerEnvelope::Result { .. }))
                .count(),
            requests.len()
        );
        assert!(!String::from_utf8_lossy(&output).contains(marker));
        assert!(!String::from_utf8_lossy(&output).contains("AUTO_TITLE_DO_NOT_ECHO"));
        assert!(!String::from_utf8_lossy(&diagnostics).contains(marker));
        assert!(!String::from_utf8_lossy(&diagnostics).contains("AUTO_TITLE_DO_NOT_ECHO"));
    }

    #[test]
    fn destructive_facade_preconditions_are_mandatory_and_exact() {
        let preferences = json!({"agentOrder":["shell"],"agentHidden":[]}).to_string();
        assert!(matches!(
            prepare_request("agent.preferences.replace", &preferences, None),
            Err(BridgeError::InvalidPrecondition)
        ));
        let removal = json!({"projectId":"prj_1","revision":"4","sessions":[],"worktreeIds":[],"recoverableOperationIds":[],"pendingCommitOperationIds":[]}).to_string();
        assert!(matches!(
            prepare_request(
                "project.remove",
                &removal,
                Some(&Precondition {
                    revision: Some(agentport_remote_protocol::Revision::Number(5)),
                    cursor: None
                })
            ),
            Err(BridgeError::InvalidPrecondition)
        ));
    }

    #[test]
    fn attach_enters_service_then_reports_proven_not_executed() {
        let mut input_bytes = Vec::new();
        append(&mut input_bytes, &hello(ProtocolVersion::V1));
        append(
            &mut input_bytes,
            &json!({
                "type":"request", "requestId":"r-attach", "method":"session.attach",
                "params":{"sessionId":"missing", "subscribeOutput":true}
            }),
        );
        let mut output = Vec::new();
        serve(
            &mut Cursor::new(input_bytes),
            &mut output,
            &mut Vec::new(),
            &FixtureService,
        )
        .unwrap();
        let mut output = Cursor::new(output);
        let _hello = read_frame(&mut output, MAX_FRAME_BYTES).unwrap().unwrap();
        let accepted: ServerEnvelope = serde_json::from_slice(
            read_frame(&mut output, MAX_FRAME_BYTES)
                .unwrap()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let result: ServerEnvelope = serde_json::from_slice(
            read_frame(&mut output, MAX_FRAME_BYTES)
                .unwrap()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        assert!(matches!(accepted, ServerEnvelope::Accepted { .. }));
        assert!(matches!(
            result,
            ServerEnvelope::Result {
                status: ResultStatus::NotExecuted,
                retry_class: RetryClass::IdempotentWrite,
                ..
            }
        ));
    }

    struct PushFixtureService {
        event_sender: mpsc::SyncSender<SessionEvent>,
        event_receiver: Mutex<Option<mpsc::Receiver<SessionEvent>>>,
        subscribe_calls: AtomicUsize,
        detach_calls: AtomicUsize,
        poll_calls: AtomicUsize,
    }

    impl PushFixtureService {
        fn new() -> Self {
            let (event_sender, event_receiver) = mpsc::sync_channel(8);
            Self {
                event_sender,
                event_receiver: Mutex::new(Some(event_receiver)),
                subscribe_calls: AtomicUsize::new(0),
                detach_calls: AtomicUsize::new(0),
                poll_calls: AtomicUsize::new(0),
            }
        }
    }

    impl RemoteService for PushFixtureService {
        fn service_snapshot(&self) -> ServiceSnapshot {
            ServiceSnapshot::default()
        }

        fn boot(&self) -> agentport_service::Result<agentport_service::BootSnapshot> {
            Ok(agentport_service::BootSnapshot {
                reconciled_sessions: 0,
                service: self.service_snapshot(),
                projects: Vec::new(),
                sessions: Vec::new(),
            })
        }

        fn list_sessions(
            &self,
            _include_archived: bool,
        ) -> agentport_service::Result<Vec<agentport_service::SessionSummary>> {
            Ok(Vec::new())
        }

        fn attach_session(
            &self,
            params: SessionAttachParams,
        ) -> agentport_service::Result<agentport_service::SessionAttachResult> {
            Ok(agentport_service::SessionAttachResult {
                attachment_id: "att-push".into(),
                session_id: params.session_id,
                child_alive: true,
                agent_session_id: None,
                cursor: None,
                features: Vec::new(),
                run_id: "run-push".into(),
                run_ordinal: 1,
                terminal_geometry: None,
            })
        }

        fn subscribe_session(
            &self,
            attachment_id: &str,
        ) -> agentport_service::Result<SessionSubscription> {
            self.subscribe_calls.fetch_add(1, AtomicOrdering::SeqCst);
            let receiver = self
                .event_receiver
                .lock()
                .unwrap()
                .take()
                .ok_or(ServiceError::InvalidRequest)?;
            Ok(SessionSubscription::new(attachment_id.into(), receiver))
        }

        fn input_session(
            &self,
            _params: SessionInputParams,
        ) -> agentport_service::Result<agentport_service::SessionInputResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn structured_prompt(
            &self,
            _params: SessionStructuredPromptParams,
        ) -> agentport_service::Result<()> {
            Err(ServiceError::InvalidRequest)
        }

        fn abort_structured_turn(
            &self,
            _params: SessionDetachParams,
        ) -> agentport_service::Result<()> {
            Err(ServiceError::InvalidRequest)
        }

        fn control_session(
            &self,
            _params: SessionControlParams,
        ) -> agentport_service::Result<agentport_service::SessionControlResult> {
            Ok(agentport_service::SessionControlResult {
                accepted: true,
                terminal_geometry: None,
            })
        }

        fn poll_session(
            &self,
            params: SessionPollParams,
        ) -> agentport_service::Result<agentport_service::SessionPollResult> {
            self.poll_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(agentport_service::SessionPollResult {
                attachment_id: params.attachment_id,
                closed: false,
                events: Vec::new(),
            })
        }

        fn detach_session(&self, _params: SessionDetachParams) -> agentport_service::Result<()> {
            self.detach_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(())
        }

        fn stop_session(
            &self,
            _params: SessionStopParams,
        ) -> agentport_service::Result<agentport_service::SessionStopResult> {
            Err(ServiceError::InvalidRequest)
        }

        fn add_secret(
            &self,
            _params: SecretAddParams,
        ) -> agentport_service::Result<agentport_service::SecretAddResult> {
            Err(ServiceError::InvalidRequest)
        }
    }

    struct BlockingInput {
        current: Cursor<Vec<u8>>,
        receiver: mpsc::Receiver<Vec<u8>>,
    }

    impl Read for BlockingInput {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let read = self.current.read(output)?;
                if read > 0 {
                    return Ok(read);
                }
                let next = self.receiver.recv().unwrap_or_default();
                if next.is_empty() {
                    return Ok(0);
                }
                self.current = Cursor::new(next);
            }
        }
    }

    #[derive(Clone, Default)]
    struct SharedOutput(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedOutput {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn frames(output: &SharedOutput) -> Vec<ServerEnvelope> {
        let bytes = output.0.lock().unwrap().clone();
        let mut input = Cursor::new(bytes);
        let mut frames = Vec::new();
        loop {
            match read_frame(&mut input, MAX_FRAME_BYTES) {
                Ok(Some(frame)) => {
                    if let Ok(envelope) = serde_json::from_slice(frame.as_bytes()) {
                        frames.push(envelope);
                    }
                }
                Ok(None) | Err(ProtocolError::UnexpectedEof) => break,
                Err(error) => panic!("invalid framed output: {error}"),
            }
        }
        frames
    }

    fn wait_for(
        output: &SharedOutput,
        predicate: impl Fn(&[ServerEnvelope]) -> bool,
    ) -> Vec<ServerEnvelope> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let observed = frames(output);
            if predicate(&observed) {
                return observed;
            }
            assert!(Instant::now() < deadline, "timed out waiting for output");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn push_hello(version: ProtocolVersion) -> Hello {
        let mut hello = hello(version);
        hello.requested_capabilities = vec![CAPABILITY_SESSION_EVENT_PUSH.into()];
        hello
    }

    fn attach_request() -> serde_json::Value {
        json!({
            "type":"request", "requestId":"r-attach", "method":"session.attach",
            "params":{"sessionId":"ses-1", "subscribeOutput":true}
        })
    }

    #[test]
    fn negotiated_push_is_unsolicited_and_attach_result_precedes_event() {
        let service = Arc::new(PushFixtureService::new());
        let mut initial = Vec::new();
        append(&mut initial, &push_hello(ProtocolVersion::V1));
        append(&mut initial, &attach_request());
        let (input_tx, input_rx) = mpsc::channel();
        let output = SharedOutput::default();
        let thread_output = output.clone();
        let thread_service = Arc::clone(&service);
        let worker = std::thread::spawn(move || {
            serve(
                &mut BlockingInput {
                    current: Cursor::new(initial),
                    receiver: input_rx,
                },
                &mut thread_output.clone(),
                &mut Vec::new(),
                thread_service.as_ref(),
            )
        });

        wait_for(&output, |messages| {
            messages.iter().any(|message| {
                matches!(message, ServerEnvelope::Result { request_id, .. } if request_id == "r-attach")
            })
        });
        service
            .event_sender
            .send(SessionEvent {
                event_type: "output".into(),
                cursor: test_cursor(1),
                payload: json!({"data":"unsolicited"}),
            })
            .unwrap();
        let observed = wait_for(&output, |messages| {
            messages
                .iter()
                .any(|message| matches!(message, ServerEnvelope::Event(_)))
        });
        let result_index = observed
            .iter()
            .position(|message| matches!(message, ServerEnvelope::Result { request_id, .. } if request_id == "r-attach"))
            .unwrap();
        let event_index = observed
            .iter()
            .position(|message| matches!(message, ServerEnvelope::Event(_)))
            .unwrap();
        assert!(result_index < event_index);
        input_tx.send(Vec::new()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), CloseReason::EndOfInput);
        assert_eq!(service.detach_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn v1_0_push_request_stays_poll_only_and_eof_detaches_it() {
        let service = PushFixtureService::new();
        let mut input = Vec::new();
        append(
            &mut input,
            &push_hello(ProtocolVersion { major: 1, minor: 0 }),
        );
        append(&mut input, &attach_request());
        append(
            &mut input,
            &json!({
                "type":"request", "requestId":"r-poll", "method":"session.poll",
                "params":{"attachmentId":"att-push", "limit":1, "waitMs":1}
            }),
        );
        let mut output = Vec::new();
        serve(
            &mut Cursor::new(input),
            &mut output,
            &mut Vec::new(),
            &service,
        )
        .unwrap();
        assert_eq!(service.subscribe_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(service.poll_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(service.detach_calls.load(AtomicOrdering::SeqCst), 1);
        let messages = {
            let shared = SharedOutput(Arc::new(Mutex::new(output)));
            frames(&shared)
        };
        assert!(matches!(
            &messages[0],
            ServerEnvelope::Hello(HelloResult { protocol, capabilities, .. })
                if protocol.minor == 0
                    && capabilities.iter().any(|capability|
                        capability.name == CAPABILITY_SESSION_EVENT_PUSH && !capability.enabled)
        ));
        assert!(!messages
            .iter()
            .any(|message| matches!(message, ServerEnvelope::Event(_))));
    }

    #[test]
    fn v1_1_without_explicit_capability_remains_poll_only() {
        let service = PushFixtureService::new();
        let mut no_opt_in = hello(ProtocolVersion::V1);
        no_opt_in.requested_capabilities.clear();
        let mut input = Vec::new();
        append(&mut input, &no_opt_in);
        append(&mut input, &attach_request());
        append(
            &mut input,
            &json!({
                "type":"request", "requestId":"r-poll", "method":"session.poll",
                "params":{"attachmentId":"att-push", "limit":1, "waitMs":1}
            }),
        );
        serve(
            &mut Cursor::new(input),
            &mut Vec::new(),
            &mut Vec::new(),
            &service,
        )
        .unwrap();
        assert_eq!(service.subscribe_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(service.poll_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn detach_result_is_a_barrier_against_late_events() {
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let (writer_tx, writer_rx) = mpsc::sync_channel(8);
        let dispatcher = spawn_dispatcher(
            "att-1".into(),
            SessionSubscription::new("att-1".into(), event_rx),
            writer_tx.clone(),
        )
        .unwrap();
        let pushed = match writer_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
            WriterMessage::Register { events, .. } => events,
            _ => panic!("dispatcher did not register its event queue"),
        };
        event_tx
            .send(SessionEvent {
                event_type: "output".into(),
                cursor: test_cursor(1),
                payload: json!({}),
            })
            .unwrap();
        let first = pushed.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(first, ServerEnvelope::Event(_)));
        dispatcher.stop();
        enqueue(
            &writer_tx,
            ServerEnvelope::Result {
                request_id: "r-detach".into(),
                operation_id: Some("op-1".into()),
                status: ResultStatus::Succeeded,
                retry_class: RetryClass::IdempotentWrite,
                value: Some(json!({})),
                error: None,
            },
        )
        .unwrap();
        assert!(event_tx
            .send(SessionEvent {
                event_type: "output".into(),
                cursor: test_cursor(2),
                payload: json!({}),
            })
            .is_err());
        let result = writer_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            result,
            WriterMessage::Envelope(ServerEnvelope::Result { .. })
        ));
        assert!(pushed.try_recv().is_err());
    }

    #[test]
    fn naturally_finished_dispatchers_are_pruned_on_the_next_request() {
        let service = PushFixtureService::new();
        let worker = std::thread::spawn(|| {});
        worker.thread().unpark();
        let mut connection = ConnectionState {
            push_enabled: true,
            enabled_capabilities: HashSet::new(),
            attachments: HashSet::from(["att-closed".into()]),
            dispatchers: HashMap::from([(
                "att-closed".into(),
                PushDispatcher {
                    cancel: Arc::new(AtomicBool::new(false)),
                    worker: Some(worker),
                },
            )]),
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        while !connection.dispatchers["att-closed"].is_finished() {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        connection.prune_finished(&service);
        assert!(connection.attachments.is_empty());
        assert!(connection.dispatchers.is_empty());
        assert_eq!(service.detach_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn sustained_control_traffic_is_quantized_for_event_fairness() {
        let (writer_tx, writer_rx) = mpsc::sync_channel(64);
        let (event_tx, event_rx) = mpsc::sync_channel(1);
        writer_tx
            .send(WriterMessage::Register {
                attachment_id: "att-fair".into(),
                events: event_rx,
            })
            .unwrap();
        event_tx
            .send(ServerEnvelope::Event(Event {
                subscription_id: "att-fair".into(),
                event_type: "output".into(),
                cursor: test_cursor(1),
                payload: json!({}),
            }))
            .unwrap();
        drop(event_tx);
        for sequence in 0..32_u64 {
            enqueue(
                &writer_tx,
                ServerEnvelope::Accepted {
                    request_id: format!("r-{sequence}"),
                    operation_id: format!("op-{sequence}"),
                    server_sequence: sequence,
                    retry_class: RetryClass::Read,
                },
            )
            .unwrap();
        }
        drop(writer_tx);
        let mut output = Vec::new();
        writer_loop(&mut output, writer_rx).unwrap();
        let messages = {
            let shared = SharedOutput(Arc::new(Mutex::new(output)));
            frames(&shared)
        };
        let event_index = messages
            .iter()
            .position(|message| matches!(message, ServerEnvelope::Event(_)))
            .unwrap();
        assert!(event_index < WRITER_CONTROL_QUANTUM);
    }

    #[test]
    fn noisy_attachment_cannot_fill_another_attachments_writer_queue() {
        let (noisy_tx, noisy_rx) = mpsc::sync_channel(64);
        let (quiet_tx, quiet_rx) = mpsc::sync_channel(4);
        let (writer_tx, writer_rx) = mpsc::sync_channel(4);
        let noisy = spawn_dispatcher(
            "att-noisy".into(),
            SessionSubscription::new("att-noisy".into(), noisy_rx),
            writer_tx.clone(),
        )
        .unwrap();
        let noisy_output = match writer_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
            WriterMessage::Register { events, .. } => events,
            _ => panic!("noisy dispatcher did not register"),
        };
        let quiet = spawn_dispatcher(
            "att-quiet".into(),
            SessionSubscription::new("att-quiet".into(), quiet_rx),
            writer_tx,
        )
        .unwrap();
        let quiet_output = match writer_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
            WriterMessage::Register { events, .. } => events,
            _ => panic!("quiet dispatcher did not register"),
        };
        for offset in 0..(ATTACHMENT_WRITER_QUEUE_CAPACITY as u64 + 2) {
            noisy_tx
                .send(SessionEvent {
                    event_type: "output".into(),
                    cursor: test_cursor(offset),
                    payload: json!({}),
                })
                .unwrap();
        }
        quiet_tx
            .send(SessionEvent {
                event_type: "output".into(),
                cursor: test_cursor(1),
                payload: json!({"quiet":true}),
            })
            .unwrap();
        let quiet_event = quiet_output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            quiet_event,
            ServerEnvelope::Event(Event { event_type, .. }) if event_type == "output"
        ));
        assert!(matches!(
            noisy_output.try_recv(),
            Ok(ServerEnvelope::Event(_))
        ));
        noisy.stop();
        quiet.stop();
    }

    #[test]
    fn full_writer_queue_preserves_complete_replay() {
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let (writer_tx, writer_rx) = mpsc::sync_channel(1);
        let dispatcher = spawn_dispatcher(
            "att-1".into(),
            SessionSubscription::new("att-1".into(), event_rx),
            writer_tx,
        )
        .unwrap();
        let pushed = match writer_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
            WriterMessage::Register { events, .. } => events,
            _ => panic!("dispatcher did not register"),
        };
        // A full 4 MiB replay has 64 output chunks followed by ReplayDone.
        let producer = std::thread::spawn(move || {
            for offset in 0..65 {
                event_tx
                    .send(SessionEvent {
                        event_type: if offset == 64 {
                            "replay_done"
                        } else {
                            "output"
                        }
                        .into(),
                        cursor: test_cursor(offset),
                        payload: json!({}),
                    })
                    .unwrap();
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        for offset in 0..65 {
            let ServerEnvelope::Event(event) = pushed.recv_timeout(Duration::from_secs(1)).unwrap()
            else {
                panic!("expected event");
            };
            assert_eq!(event.cursor.offset, offset);
            assert_eq!(
                event.event_type,
                if offset == 64 {
                    "replay_done"
                } else {
                    "output"
                }
            );
        }
        producer.join().unwrap();
        dispatcher.stop();
    }

    #[test]
    fn full_writer_queue_can_be_cancelled_without_drain() {
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let (writer_tx, writer_rx) = mpsc::sync_channel(1);
        let dispatcher = spawn_dispatcher(
            "att-1".into(),
            SessionSubscription::new("att-1".into(), event_rx),
            writer_tx,
        )
        .unwrap();
        let _registration = writer_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for offset in 0..40 {
            event_tx
                .send(SessionEvent {
                    event_type: "output".into(),
                    cursor: test_cursor(offset),
                    payload: json!({}),
                })
                .unwrap();
        }
        drop(event_tx);
        std::thread::sleep(Duration::from_millis(50));
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            dispatcher.stop();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancel must wake a full queue");
    }

    fn test_cursor(offset: u64) -> RunCursor {
        RunCursor {
            run_id: "run-1".into(),
            run_ordinal: 1,
            generation: 0,
            offset,
            status_sequence: 0,
        }
    }

    #[test]
    fn boot_request_has_accepted_then_succeeded_result() {
        let mut input_bytes = Vec::new();
        append(&mut input_bytes, &hello(ProtocolVersion::V1));
        append(
            &mut input_bytes,
            &json!({"type":"request","requestId":"r1","method":"boot","params":{}}),
        );
        let mut output = Vec::new();
        serve(
            &mut Cursor::new(input_bytes),
            &mut output,
            &mut Vec::new(),
            &FixtureService,
        )
        .unwrap();
        let mut output = Cursor::new(output);
        let _: ServerEnvelope = serde_json::from_slice(
            read_frame(&mut output, MAX_FRAME_BYTES)
                .unwrap()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let accepted: ServerEnvelope = serde_json::from_slice(
            read_frame(&mut output, MAX_FRAME_BYTES)
                .unwrap()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let result: ServerEnvelope = serde_json::from_slice(
            read_frame(&mut output, MAX_FRAME_BYTES)
                .unwrap()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        assert!(matches!(accepted, ServerEnvelope::Accepted { .. }));
        assert!(matches!(
            result,
            ServerEnvelope::Result {
                status: ResultStatus::Succeeded,
                retry_class: RetryClass::Read,
                ..
            }
        ));
    }
}
