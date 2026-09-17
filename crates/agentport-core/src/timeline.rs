//! Recovery timeline (PRD 3.6, 4.4): "while you were away" — merges status
//! events, host exits and unread output offsets since the GUI's last-seen
//! sequence per session. Pure derivation from db facts; fully testable.

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub session_id: String,
    pub session_title: String,
    pub project_name: String,
    pub adapter_type: AgentType,
    pub state: AgentState,
    pub source: StateSource,
    pub confidence: Confidence,
    /// Machine-readable origin.  `recovery:output-during-gui-closed` is a
    /// bounded output interval, not an inferred agent state transition.
    pub evidence: Option<String>,
    pub occurred_at: DateTime<Utc>,
    /// Run-scoped status identity for deterministic ordering and snapshot ACK.
    pub status_cursor: Option<StatusCursor>,
    /// Exact retained-log cursor to jump to (None when no proof remains).
    pub log_cursor: Option<LogCursor>,
    /// Compatibility projection for older renderers. New consumers must use
    /// `log_cursor`, which contains run and generation as well as offset.
    pub log_offset: Option<u64>,
    pub rotated_away: bool,
    /// A conservative, user-visible reason when no precise jump is safe.
    pub location_unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryTimeline {
    pub entries: Vec<TimelineEntry>,
    pub completed: u32,
    pub waiting: u32,
    pub failed: u32,
    /// The exact facts rendered to the GUI. The caller must send these back
    /// when acknowledging; rebuilding at click time would consume new events
    /// that were not in the rendered view.
    #[serde(default)]
    pub ack_snapshots: Vec<RecoveryAckSnapshot>,
    #[serde(skip)]
    snapshots: HashMap<String, TimelineSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAckSnapshot {
    pub session_id: String,
    pub status_cursor: Option<StatusCursor>,
    pub log_cursor: Option<LogCursor>,
}

#[derive(Debug, Clone, Default)]
struct TimelineSnapshot {
    status_cursor: Option<StatusCursor>,
    /// The latest *observed* log cursor at render time. This is intentionally
    /// not the entry's first-unread target: ACK must not erase later bytes.
    log_cursor: Option<LogCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimelineBucket {
    Completed,
    Waiting,
    Failed,
}

pub struct Timeline<'a> {
    pub db: &'a Db,
}

impl<'a> Timeline<'a> {
    /// Build entries for every session with sequence > its last_seen_sequence.
    /// Newest first. Performance target (ch.10): 100 events P95 <= 300 ms.
    pub fn build(&self) -> Result<RecoveryTimeline> {
        let sessions = self.db.list_sessions(None, false)?;
        if sessions.is_empty() {
            return Ok(RecoveryTimeline::default());
        }
        // Both recovery cursors are run-scoped. A sequence is only meaningful
        // within one Host launch, so never reduce either of these to a bare
        // offset before querying or interpreting it.
        let mut cursors: Vec<(String, StatusCursor)> = Vec::with_capacity(sessions.len());
        let mut unread_cursors: HashMap<&str, Option<LogCursor>> =
            HashMap::with_capacity(sessions.len());
        let mut latest_logs: HashMap<&str, Option<(LogCursor, DateTime<Utc>)>> =
            HashMap::with_capacity(sessions.len());
        for s in &sessions {
            let last_seen = match self.db.get_last_seen_status_cursor(&s.id) {
                Ok(cursor) => cursor,
                // insert_session/record_status_event always create the row; a
                // missing one means "never seen anything", not a hard failure.
                Err(CoreError::NotFound(_)) => StatusCursor::default(),
                Err(e) => return Err(e),
            };
            let unread = match self.db.get_unread_log_cursor(&s.id) {
                Ok(cursor) => cursor,
                Err(CoreError::NotFound(_)) => None,
                Err(e) => return Err(e),
            };
            let latest_log = match self.db.get_latest_log_cursor_observed(&s.id) {
                Ok(cursor) => cursor,
                Err(CoreError::NotFound(_)) => None,
                Err(e) => return Err(e),
            };
            cursors.push((s.id.clone(), last_seen));
            unread_cursors.insert(s.id.as_str(), unread);
            latest_logs.insert(s.id.as_str(), latest_log);
        }

        let events = self.db.events_since_cursors(&cursors)?;
        let sessions_by_id: HashMap<&str, &Session> =
            sessions.iter().map(|s| (s.id.as_str(), s)).collect();
        let mut project_names: HashMap<String, String> = HashMap::new();
        let mut timeline = RecoveryTimeline {
            entries: Vec::with_capacity(events.len()),
            ..RecoveryTimeline::default()
        };
        for e in &events {
            let Some(session) = sessions_by_id.get(e.session_id.as_str()).copied() else {
                continue;
            };
            // ACK advances through the exact high-water rendered by this
            // build, including ordinary transitions intentionally omitted from
            // the list. A later event remains unread because its cursor is not
            // part of this snapshot.
            let snapshot = timeline.snapshots.entry(session.id.clone()).or_default();
            if snapshot
                .status_cursor
                .as_ref()
                .is_none_or(|previous| e.cursor().is_after(previous))
            {
                snapshot.status_cursor = Some(e.cursor());
            }
            let Some(bucket) = timeline_bucket(e) else {
                continue;
            };
            let (log_cursor, rotated_away, location_unavailable_reason) = event_log_target(
                e.log_cursor.as_ref(),
                latest_logs
                    .get(session.id.as_str())
                    .and_then(|v| v.as_ref())
                    .map(|v| &v.0),
            );
            let project_name = match project_names.get(&session.project_id) {
                Some(n) => n.clone(),
                None => {
                    let n = self.db.get_project(&session.project_id)?.name;
                    project_names.insert(session.project_id.clone(), n.clone());
                    n
                }
            };
            timeline.entries.push(TimelineEntry {
                session_id: session.id.clone(),
                session_title: session.title.clone(),
                project_name,
                adapter_type: session.adapter_type,
                state: e.state,
                source: e.source,
                confidence: e.confidence,
                evidence: e.evidence.clone(),
                occurred_at: e.occurred_at,
                status_cursor: Some(e.cursor()),
                log_offset: log_cursor.as_ref().map(|cursor| cursor.offset as u64),
                log_cursor,
                rotated_away,
                location_unavailable_reason,
            });
            match bucket {
                TimelineBucket::Completed => timeline.completed += 1,
                TimelineBucket::Waiting => timeline.waiting += 1,
                TimelineBucket::Failed => timeline.failed += 1,
            }
        }

        // A GUI-closed interval can have terminal bytes without any state
        // transition. The first unread cursor was captured at GUI exit (or by
        // the active renderer before it went away); only generate an entry
        // when a verified Host observation proves the same retained run and
        // generation advanced beyond it.
        for session in &sessions {
            let unread = unread_cursors
                .get(session.id.as_str())
                .and_then(|cursor| cursor.as_ref());
            let latest = latest_logs
                .get(session.id.as_str())
                .and_then(|cursor| cursor.as_ref());
            let Some(unread) = unread else { continue };
            let Some((latest, observed_at)) = latest else {
                continue;
            };
            let retained_generation_changed = latest.run_id != unread.run_id
                || latest.run_ordinal != unread.run_ordinal
                || latest.generation != unread.generation;
            if latest.offset <= unread.offset && !retained_generation_changed {
                continue;
            }
            let (target, rotated_away, reason) =
                event_log_target(Some(unread), Some(latest));
            let project_name = match project_names.get(&session.project_id) {
                Some(n) => n.clone(),
                None => {
                    let n = self.db.get_project(&session.project_id)?.name;
                    project_names.insert(session.project_id.clone(), n.clone());
                    n
                }
            };
            timeline.entries.push(TimelineEntry {
                session_id: session.id.clone(),
                session_title: session.title.clone(),
                project_name,
                adapter_type: session.adapter_type,
                state: AgentState::Working,
                source: StateSource::Pty,
                confidence: Confidence::High,
                evidence: Some("recovery:output-during-gui-closed".into()),
                // This is the time the Host reported the high-water cursor;
                // UI copy distinguishes it from an exact output timestamp.
                occurred_at: *observed_at,
                status_cursor: None,
                log_offset: target.as_ref().map(|cursor| cursor.offset as u64),
                log_cursor: target,
                rotated_away,
                location_unavailable_reason: reason,
            });
            timeline
                .snapshots
                .entry(session.id.clone())
                .or_default()
                .log_cursor = Some(latest.clone());
        }

        // Newest first. A timestamp is user-facing wall-clock context, not an
        // ordering key by itself: same-millisecond events use run/sequence.
        timeline.entries.sort_by(|a, b| {
            b.occurred_at
                .cmp(&a.occurred_at)
                .then_with(|| entry_run_ordinal(b).cmp(&entry_run_ordinal(a)))
                .then_with(|| entry_sequence(b).cmp(&entry_sequence(a)))
                .then_with(|| entry_generation(b).cmp(&entry_generation(a)))
                .then_with(|| entry_offset(b).cmp(&entry_offset(a)))
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        timeline.ack_snapshots = timeline
            .snapshots
            .iter()
            .map(|(session_id, snapshot)| RecoveryAckSnapshot {
                session_id: session_id.clone(),
                status_cursor: snapshot.status_cursor.clone(),
                log_cursor: snapshot.log_cursor.clone(),
            })
            .collect();
        timeline
            .ack_snapshots
            .sort_by(|a, b| a.session_id.cmp(&b.session_id));
        Ok(timeline)
    }

    /// Build the user-visible recovery snapshot and consume status chatter only
    /// when it produced no visible recovery item. This prevents permanently
    /// replaying ignored PTY/legacy notification rows without acknowledging a
    /// completion, approval, exit or unread-output item on the user's behalf.
    pub fn build_and_acknowledge_hidden_only(&self) -> Result<RecoveryTimeline> {
        let timeline = self.build()?;
        if timeline.entries.is_empty() && !timeline.ack_snapshots.is_empty() {
            self.acknowledge_snapshot(&timeline.ack_snapshots)?;
        }
        Ok(timeline)
    }

    /// Mark only the facts in this rendered snapshot acknowledged. A status
    /// or output frame arriving between `build` and this transaction remains
    /// unread for the next refresh.
    pub fn acknowledge_all(&self) -> Result<()> {
        let timeline = self.build()?;
        self.acknowledge_snapshot(&timeline.ack_snapshots)
    }

    /// Persist only the caller's rendered recovery snapshot. This is used by
    /// IPC acknowledgement; malformed or stale snapshot items fail closed in
    /// the DB's run-aware validation rather than widening acknowledgement.
    pub fn acknowledge_snapshot(&self, snapshots: &[RecoveryAckSnapshot]) -> Result<()> {
        for snapshot in snapshots {
            self.db.acknowledge_recovery_snapshot(
                &snapshot.session_id,
                snapshot.status_cursor.as_ref(),
                snapshot.log_cursor.as_ref(),
            )?;
        }
        Ok(())
    }
}

/// Return a jump only after proving that the event/first-unread cursor belongs
/// to the same retained run *and log generation* as the last Host observation.
/// The mutable current log path is never enough on its own.
/// Whether a timeline entry's output position can still be located.
///
/// The Host keeps no PTY body copy (docs/user-guide.md), so there is no file to
/// stat: the durable cursor tuple is the only evidence, and a matching
/// run/generation/offset is reported as locatable in the retained tail.
fn event_log_target(
    target: Option<&LogCursor>,
    latest: Option<&LogCursor>,
) -> (Option<LogCursor>, bool, Option<String>) {
    let Some(target) = target else {
        return (None, false, Some("no_verified_output_position".into()));
    };
    let Some(latest) = latest else {
        return (None, true, Some("output_generation_unverified".into()));
    };
    if target.run_id != latest.run_id
        || target.run_ordinal != latest.run_ordinal
        || target.generation != latest.generation
        || target.offset < 0
        || target.offset > latest.offset
    {
        return (None, true, Some("output_rotated".into()));
    }
    if latest.offset < 0 || target.offset > latest.offset {
        (None, true, Some("output_rotated".into()))
    } else {
        (Some(target.clone()), false, None)
    }
}

fn entry_run_ordinal(entry: &TimelineEntry) -> i64 {
    entry
        .status_cursor
        .as_ref()
        .map(|cursor| cursor.run_ordinal)
        .or_else(|| entry.log_cursor.as_ref().map(|cursor| cursor.run_ordinal))
        .unwrap_or(0)
}

fn entry_sequence(entry: &TimelineEntry) -> i64 {
    entry
        .status_cursor
        .as_ref()
        .map(|cursor| cursor.sequence)
        .unwrap_or(-1)
}

fn entry_generation(entry: &TimelineEntry) -> i64 {
    entry
        .log_cursor
        .as_ref()
        .map(|cursor| cursor.generation)
        .unwrap_or(-1)
}

fn entry_offset(entry: &TimelineEntry) -> i64 {
    entry
        .log_cursor
        .as_ref()
        .map(|cursor| cursor.offset)
        .unwrap_or(-1)
}

/// The default recovery list is intentionally attention-first: normal
/// activity and ordinary idle transitions are noisy while a GUI was closed.
/// Only precise completion/approval semantics and process exits remain.
fn timeline_bucket(event: &StatusEvent) -> Option<TimelineBucket> {
    match (event.attention_kind(), event.state) {
        (Some(AttentionKind::ApprovalRequested), _) => Some(TimelineBucket::Waiting),
        (Some(AttentionKind::TurnCompleted), _) => Some(TimelineBucket::Completed),
        (Some(AttentionKind::ExecutionFailed), _) => Some(TimelineBucket::Failed),
        (None, AgentState::Exited) if event.evidence.as_deref() == Some("process:exit:0") => {
            Some(TimelineBucket::Completed)
        }
        (None, AgentState::Exited) => Some(TimelineBucket::Failed),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn project(id: &str, name: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            root_path: format!("/tmp/{id}"),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        }
    }

    fn session(id: &str, project_id: &str, title: &str, adapter: AgentType, _log: &str) -> Session {
        Session {
            id: id.into(),
            project_id: project_id.into(),
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: title.into(),
            cwd: "/tmp".into(),
            host_pid: None,
            host_socket: None,
            host_token: format!("tok_{id}"),
            lifecycle: Lifecycle::Running,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            adapter_type: adapter,
            transport: AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        }
    }

    fn event(
        session_id: &str,
        seq: i64,
        state: AgentState,
        source: StateSource,
        evidence: &str,
        at: DateTime<Utc>,
    ) -> StatusEvent {
        StatusEvent {
            session_id: session_id.into(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: seq,
            state,
            source,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: at,
        }
    }

    fn event_for_run(
        session_id: &str,
        run: &SessionRun,
        seq: i64,
        state: AgentState,
        source: StateSource,
        evidence: &str,
        at: DateTime<Utc>,
    ) -> StatusEvent {
        StatusEvent {
            session_id: session_id.into(),
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            sequence: seq,
            state,
            source,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
            log_cursor: None,
            occurred_at: at,
        }
    }

    fn write_log(dir: &std::path::Path, id: &str, bytes: usize) -> String {
        let p = dir.join(format!("{id}.log"));
        std::fs::write(&p, vec![b'x'; bytes]).unwrap();
        p.to_string_lossy().into_owned()
    }

    /// 2 projects / 3 sessions: one exits 0 (completed), one needs input
    /// (waiting), one dies by signal (failed). recovery_summary rows are
    /// created by insert_session with last_seen_sequence = 0.
    fn fixture() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_a", "Alpha")).unwrap();
        db.add_project(&project("prj_b", "Beta")).unwrap();
        db.insert_session(&session(
            "ses_done",
            "prj_a",
            "更新部署文档",
            AgentType::Kimi,
            &write_log(dir.path(), "ses_done", 4096),
        ))
        .unwrap();
        db.insert_session(&session(
            "ses_wait",
            "prj_a",
            "修复登录超时",
            AgentType::Claude,
            &write_log(dir.path(), "ses_wait", 2048),
        ))
        .unwrap();
        // ses_fail's log was rotated: only 64 bytes remain of the current
        // generation, below the unread offset set below.
        db.insert_session(&session(
            "ses_fail",
            "prj_b",
            "构建前端",
            AgentType::Shell,
            &write_log(dir.path(), "ses_fail", 64),
        ))
        .unwrap();
        db.set_unread_offset("ses_done", 100).unwrap();
        db.set_unread_offset("ses_wait", 7).unwrap();
        db.set_unread_offset("ses_fail", 512).unwrap();
        let t0 = Utc::now() - Duration::seconds(60);
        db.record_status_event(&event(
            "ses_done",
            1,
            AgentState::Working,
            StateSource::Hook,
            "hook:PreToolUse",
            t0,
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_done",
            2,
            AgentState::Exited,
            StateSource::Process,
            "process:exit:0",
            t0 + Duration::seconds(3),
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_fail",
            1,
            AgentState::Working,
            StateSource::Pty,
            "pty:activity",
            t0 + Duration::seconds(1),
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_fail",
            2,
            AgentState::Exited,
            StateSource::Process,
            "process:signal:9",
            t0 + Duration::seconds(2),
        ))
        .unwrap();
        // Newest event overall.
        db.record_status_event(&event(
            "ses_wait",
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            t0 + Duration::seconds(5),
        ))
        .unwrap();
        (db, dir)
    }

    #[test]
    fn build_merges_counts_sorts_and_marks_offsets() {
        let (db, _dir) = fixture();
        let tl = Timeline { db: &db }.build().unwrap();
        assert_eq!(tl.entries.len(), 3);
        // Newest first.
        assert!(tl
            .entries
            .windows(2)
            .all(|w| w[0].occurred_at >= w[1].occurred_at));
        assert_eq!(tl.entries[0].session_id, "ses_wait");
        // One bucket per session from its last new event.
        assert_eq!((tl.completed, tl.waiting, tl.failed), (1, 1, 1));

        // Enrichment from the sessions/projects tables.
        let done = tl
            .entries
            .iter()
            .find(|e| e.session_id == "ses_done" && e.state == AgentState::Exited)
            .unwrap();
        assert_eq!(done.session_title, "更新部署文档");
        assert_eq!(done.project_name, "Alpha");
        assert_eq!(done.adapter_type, AgentType::Kimi);
        assert_eq!(done.source, StateSource::Process);
        assert_eq!(done.confidence, Confidence::High);
        // Sessions whose latest status is exited are included ("谁退出了").
        assert_eq!(
            db.latest_status("ses_done").unwrap().unwrap().state,
            AgentState::Exited
        );
        // A per-Session unread marker is not an event location. Old journals
        // without an event cursor remain metadata-only instead of pointing at
        // unrelated output.
        assert_eq!(done.log_offset, None);
        assert!(!done.rotated_away);
        assert_eq!(tl.entries[0].log_offset, None);
        assert!(!tl.entries[0].rotated_away);

        // Missing event cursor is unrelated to the Session-wide unread marker.
        let fail = tl
            .entries
            .iter()
            .find(|e| e.session_id == "ses_fail" && e.state == AgentState::Exited)
            .unwrap();
        assert_eq!(fail.project_name, "Beta");
        assert_eq!(fail.log_offset, None);
        assert!(!fail.rotated_away);
    }

    #[test]
    fn default_list_filters_normal_working_and_idle_but_keeps_attention_idle() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_filter", "Filter")).unwrap();
        db.insert_session(&session(
            "ses_filter",
            "prj_filter",
            "普通状态过滤",
            AgentType::Shell,
            &write_log(dir.path(), "ses_filter", 32),
        ))
        .unwrap();
        let at = Utc::now();
        for (sequence, state, evidence) in [
            (1, AgentState::Working, "hook:PreToolUse"),
            (2, AgentState::Idle, "pty:silence:3000ms"),
            (3, AgentState::Idle, "hook:Stop"),
            (4, AgentState::NeedsInput, "hook:Notification"),
        ] {
            db.record_status_event(&event(
                "ses_filter",
                sequence,
                state,
                StateSource::Hook,
                evidence,
                at + Duration::milliseconds(sequence),
            ))
            .unwrap();
        }

        let timeline = Timeline { db: &db }.build().unwrap();
        let sequences: Vec<i64> = timeline
            .entries
            .iter()
            .map(|entry| entry.status_cursor.as_ref().unwrap().sequence)
            .collect();
        assert_eq!(sequences, vec![3]);
        assert_eq!(
            (timeline.completed, timeline.waiting, timeline.failed),
            (1, 0, 0)
        );
    }

    #[test]
    fn informational_hook_notification_is_not_a_recovery_event() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_info", "Info")).unwrap();
        db.insert_session(&session(
            "ses_info",
            "prj_info",
            "普通通知",
            AgentType::Claude,
            &write_log(dir.path(), "ses_info", 32),
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_info",
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:Notification",
            Utc::now(),
        ))
        .unwrap();

        let timeline = Timeline { db: &db }.build().unwrap();
        assert!(timeline.entries.is_empty());
        assert_eq!(
            (timeline.completed, timeline.waiting, timeline.failed),
            (0, 0, 0)
        );
    }

    #[test]
    fn visible_completion_remains_in_the_completed_count() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_count", "Count")).unwrap();
        db.insert_session(&session(
            "ses_count",
            "prj_count",
            "完成后出现终端活动",
            AgentType::Claude,
            &write_log(dir.path(), "ses_count", 32),
        ))
        .unwrap();
        let at = Utc::now();
        db.record_status_event(&event(
            "ses_count",
            1,
            AgentState::Idle,
            StateSource::Hook,
            "hook:Stop",
            at,
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_count",
            2,
            AgentState::Working,
            StateSource::Pty,
            "pty:activity",
            at + Duration::milliseconds(1),
        ))
        .unwrap();

        let timeline = Timeline { db: &db }.build().unwrap();
        assert_eq!(timeline.entries.len(), 1);
        assert_eq!(timeline.entries[0].evidence.as_deref(), Some("hook:Stop"));
        assert_eq!(
            timeline.ack_snapshots[0]
                .status_cursor
                .as_ref()
                .unwrap()
                .sequence,
            2
        );
        assert_eq!(
            (timeline.completed, timeline.waiting, timeline.failed),
            (1, 0, 0)
        );
    }

    #[test]
    fn hidden_only_status_chatter_is_acknowledged_without_a_visible_item() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_hidden", "Hidden")).unwrap();
        db.insert_session(&session(
            "ses_hidden",
            "prj_hidden",
            "只有终端噪声",
            AgentType::Shell,
            &write_log(dir.path(), "ses_hidden", 32),
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_hidden",
            1,
            AgentState::Working,
            StateSource::Pty,
            "pty:activity",
            Utc::now(),
        ))
        .unwrap();

        let timeline = Timeline { db: &db }
            .build_and_acknowledge_hidden_only()
            .unwrap();
        assert!(timeline.entries.is_empty());
        assert_eq!(
            db.get_recovery_summary("ses_hidden")
                .unwrap()
                .last_seen_sequence,
            1
        );
    }

    #[test]
    fn status_event_log_cursor_at_eof_is_retained() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_a", "Alpha")).unwrap();
        db.insert_session(&session(
            "ses_edge",
            "prj_a",
            "边界",
            AgentType::Shell,
            &write_log(dir.path(), "ses_edge", 50),
        ))
        .unwrap();
        let run = db.create_session_run("ses_edge", "run_edge").unwrap();
        let cursor = LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 0,
            offset: 50,
        };
        let mut status_event = event_for_run(
            "ses_edge",
            &run,
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            Utc::now(),
        );
        status_event.log_cursor = Some(cursor.clone());
        db.record_status_event(&status_event).unwrap();
        db.set_latest_log_cursor("ses_edge", &cursor).unwrap();

        let tl = Timeline { db: &db }.build().unwrap();
        assert_eq!(tl.entries.len(), 1);
        assert!(!tl.entries[0].rotated_away);
        assert_eq!(tl.entries[0].log_cursor.as_ref(), Some(&cursor));
        assert_eq!(tl.entries[0].log_offset, Some(50));
        assert_eq!(tl.entries[0].location_unavailable_reason, None);
    }

    #[test]
    fn acknowledge_all_marks_sessions_seen() {
        let (db, _dir) = fixture();
        let tl = Timeline { db: &db };
        assert!(!tl.build().unwrap().entries.is_empty());
        tl.acknowledge_all().unwrap();
        let after = tl.build().unwrap();
        assert!(after.entries.is_empty());
        assert_eq!((after.completed, after.waiting, after.failed), (0, 0, 0));
        for id in ["ses_done", "ses_wait", "ses_fail"] {
            let rs = db.get_recovery_summary(id).unwrap();
            assert_eq!(rs.last_seen_sequence, rs.latest_sequence);
            assert!(rs.acknowledged_at.is_some());
        }
    }

    #[test]
    fn build_uses_run_cursor_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_runs", "Runs")).unwrap();
        db.insert_session(&session(
            "ses_runs",
            "prj_runs",
            "跨运行恢复",
            AgentType::Shell,
            &write_log(dir.path(), "ses_runs", 512),
        ))
        .unwrap();
        let first = db.create_session_run("ses_runs", "run_first").unwrap();
        let second = db.create_session_run("ses_runs", "run_second").unwrap();
        let t0 = Utc::now();
        // Sequence values restart for each run. The lower sequence in the
        // second run is nevertheless a newer recovery event.
        db.record_status_event(&event_for_run(
            "ses_runs",
            &first,
            99,
            AgentState::Exited,
            StateSource::Process,
            "process:signal:9",
            t0,
        ))
        .unwrap();
        db.record_status_event(&event_for_run(
            "ses_runs",
            &second,
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            t0 + Duration::seconds(1),
        ))
        .unwrap();

        let initial = Timeline { db: &db }.build().unwrap();
        assert_eq!(initial.entries.len(), 2);
        assert_eq!(
            (initial.completed, initial.waiting, initial.failed),
            (0, 1, 1)
        );
        assert!(initial
            .entries
            .iter()
            .all(|entry| entry.log_offset.is_none()));
        assert!(initial.entries.iter().all(|entry| !entry.rotated_away));

        // Seeing the first run must not replay it merely because the next run
        // begins again at sequence one.
        db.set_last_seen_status_cursor(
            "ses_runs",
            &StatusCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                sequence: 99,
            },
        )
        .unwrap();
        let resumed = Timeline { db: &db }.build().unwrap();
        assert_eq!(resumed.entries.len(), 1);
        assert_eq!(resumed.entries[0].state, AgentState::NeedsInput);
        assert_eq!(
            (resumed.completed, resumed.waiting, resumed.failed),
            (0, 1, 0)
        );
    }

    #[test]
    fn stale_unread_cursor_is_not_applied_to_current_run_log() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_stale", "Stale")).unwrap();
        db.insert_session(&session(
            "ses_stale",
            "prj_stale",
            "旧输出",
            AgentType::Shell,
            &write_log(dir.path(), "ses_stale", 512),
        ))
        .unwrap();
        let first = db.create_session_run("ses_stale", "run_first").unwrap();
        let second = db.create_session_run("ses_stale", "run_second").unwrap();
        let t0 = Utc::now();
        db.record_status_event(&event_for_run(
            "ses_stale",
            &first,
            1,
            AgentState::Working,
            StateSource::Pty,
            "pty:activity",
            t0,
        ))
        .unwrap();
        db.mark_output_unread_at(
            "ses_stale",
            &LogCursor {
                run_id: first.run_id.clone(),
                run_ordinal: first.run_ordinal,
                generation: 0,
                offset: 10,
            },
        )
        .unwrap();
        db.record_status_event(&event_for_run(
            "ses_stale",
            &second,
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            t0 + Duration::seconds(1),
        ))
        .unwrap();

        let timeline = Timeline { db: &db }.build().unwrap();
        assert_eq!(timeline.entries.len(), 1);
        // Session-wide unread state never substitutes for an event cursor.
        assert!(timeline
            .entries
            .iter()
            .all(|entry| entry.log_offset.is_none()));
        assert!(timeline.entries.iter().all(|entry| !entry.rotated_away));
    }

    #[test]
    fn ack_snapshot_preserves_status_event_inserted_after_render() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_ack", "Ack")).unwrap();
        db.insert_session(&session(
            "ses_ack",
            "prj_ack",
            "确认竞态",
            AgentType::Shell,
            &write_log(dir.path(), "ses_ack", 128),
        ))
        .unwrap();
        let first = event(
            "ses_ack",
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            Utc::now(),
        );
        db.record_status_event(&first).unwrap();
        let rendered = Timeline { db: &db }.build().unwrap();

        db.record_status_event(&event(
            "ses_ack",
            2,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            Utc::now(),
        ))
        .unwrap();
        Timeline { db: &db }
            .acknowledge_snapshot(&rendered.ack_snapshots)
            .unwrap();

        let after = Timeline { db: &db }.build().unwrap();
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].status_cursor.as_ref().unwrap().sequence, 2);
    }

    #[test]
    fn ack_snapshot_advances_unread_to_rendered_high_water_when_output_arrives() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_ack_output", "Ack output"))
            .unwrap();
        db.insert_session(&session(
            "ses_ack_output",
            "prj_ack_output",
            "并发输出确认",
            AgentType::Shell,
            &write_log(dir.path(), "ses_ack_output", 120),
        ))
        .unwrap();
        let run = db
            .create_session_run("ses_ack_output", "run_ack_output")
            .unwrap();
        let first = LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 0,
            offset: 10,
        };
        db.set_unread_log_cursor("ses_ack_output", &first).unwrap();
        db.set_latest_log_cursor(
            "ses_ack_output",
            &LogCursor {
                offset: 80,
                ..first.clone()
            },
        )
        .unwrap();
        let rendered = Timeline { db: &db }.build().unwrap();
        assert_eq!(rendered.entries[0].log_cursor.as_ref(), Some(&first));
        db.set_latest_log_cursor(
            "ses_ack_output",
            &LogCursor {
                offset: 120,
                ..first.clone()
            },
        )
        .unwrap();

        Timeline { db: &db }
            .acknowledge_snapshot(&rendered.ack_snapshots)
            .unwrap();
        assert_eq!(
            db.get_unread_log_cursor("ses_ack_output").unwrap(),
            Some(LogCursor {
                offset: 80,
                ..first.clone()
            }),
        );
        let after = Timeline { db: &db }.build().unwrap();
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].log_cursor.as_ref().unwrap().offset, 80);
    }

    #[test]
    fn gui_closed_pure_output_keeps_first_unread_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_output", "Output")).unwrap();
        db.insert_session(&session(
            "ses_output",
            "prj_output",
            "纯输出",
            AgentType::Shell,
            &write_log(dir.path(), "ses_output", 64),
        ))
        .unwrap();
        let run = db.create_session_run("ses_output", "run_output").unwrap();
        let start = LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 2,
            offset: 12,
        };
        let latest = LogCursor {
            offset: 64,
            ..start.clone()
        };
        db.set_unread_log_cursor("ses_output", &start).unwrap();
        db.set_latest_log_cursor("ses_output", &latest).unwrap();

        let timeline = Timeline { db: &db }.build().unwrap();
        assert_eq!(timeline.entries.len(), 1);
        let output = &timeline.entries[0];
        assert_eq!(
            output.evidence.as_deref(),
            Some("recovery:output-during-gui-closed")
        );
        assert_eq!(output.log_cursor.as_ref(), Some(&start));
        assert!(!output.rotated_away);
    }

    #[test]
    fn old_generation_is_never_mapped_into_newer_longer_log() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_generation", "Generation"))
            .unwrap();
        db.insert_session(&session(
            "ses_generation",
            "prj_generation",
            "日志代际",
            AgentType::Shell,
            &write_log(dir.path(), "ses_generation", 200),
        ))
        .unwrap();
        let run = db
            .create_session_run("ses_generation", "run_generation")
            .unwrap();
        let mut event = event_for_run(
            "ses_generation",
            &run,
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            Utc::now(),
        );
        event.log_cursor = Some(LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 0,
            offset: 10,
        });
        db.record_status_event(&event).unwrap();
        db.set_latest_log_cursor(
            "ses_generation",
            &LogCursor {
                generation: 1,
                offset: 200,
                ..event.log_cursor.clone().unwrap()
            },
        )
        .unwrap();

        let entry = &Timeline { db: &db }.build().unwrap().entries[0];
        assert!(entry.rotated_away);
        assert_eq!(entry.log_cursor, None);
        assert_eq!(
            entry.location_unavailable_reason.as_deref(),
            Some("output_rotated")
        );
    }

    #[test]
    fn rotated_gui_closed_output_is_visible_with_an_explicit_degradation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_rotation", "Rotation"))
            .unwrap();
        db.insert_session(&session(
            "ses_rotation",
            "prj_rotation",
            "轮转输出",
            AgentType::Shell,
            &write_log(dir.path(), "ses_rotation", 50),
        ))
        .unwrap();
        let run = db
            .create_session_run("ses_rotation", "run_rotation")
            .unwrap();
        let old = LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 0,
            offset: 100,
        };
        db.set_unread_log_cursor("ses_rotation", &old).unwrap();
        db.set_latest_log_cursor(
            "ses_rotation",
            &LogCursor {
                generation: 1,
                offset: 50,
                ..old.clone()
            },
        )
        .unwrap();

        let timeline = Timeline { db: &db }.build().unwrap();
        assert_eq!(timeline.entries.len(), 1);
        assert!(timeline.entries[0].rotated_away);
        assert_eq!(
            timeline.entries[0].location_unavailable_reason.as_deref(),
            Some("output_rotated")
        );
    }

    #[test]
    fn same_millisecond_events_sort_by_run_and_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory().unwrap();
        db.add_project(&project("prj_sort", "Sort")).unwrap();
        db.insert_session(&session(
            "ses_sort",
            "prj_sort",
            "稳定排序",
            AgentType::Shell,
            &write_log(dir.path(), "ses_sort", 64),
        ))
        .unwrap();
        let at = Utc::now();
        db.record_status_event(&event(
            "ses_sort",
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            at,
        ))
        .unwrap();
        db.record_status_event(&event(
            "ses_sort",
            2,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:PermissionRequest",
            at,
        ))
        .unwrap();
        let entries = Timeline { db: &db }.build().unwrap().entries;
        assert_eq!(entries[0].status_cursor.as_ref().unwrap().sequence, 2);
        assert_eq!(entries[1].status_cursor.as_ref().unwrap().sequence, 1);
    }

    #[test]
    fn build_100_events_is_fast_enough_in_debug() {
        let (db, _dir) = fixture();
        let t0 = Utc::now();
        for seq in 2..=100 {
            let (state, ev) = if seq == 100 {
                (AgentState::Exited, "process:exit:0")
            } else {
                (AgentState::Working, "hook:PreToolUse")
            };
            db.record_status_event(&event(
                "ses_wait",
                seq,
                state,
                StateSource::Hook,
                ev,
                t0 + Duration::milliseconds(seq),
            ))
            .unwrap();
        }
        let start = std::time::Instant::now();
        let tl = Timeline { db: &db }.build().unwrap();
        let elapsed = start.elapsed();
        assert_eq!(tl.entries.len(), 4);
        // PRD ch.10: P95 <= 300 ms (verified on the release harness); the
        // debug gate stays generous.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "build took {elapsed:?}"
        );
    }
}
