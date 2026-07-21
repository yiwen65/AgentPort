//! Recovery timeline (PRD 3.6, 4.4): "while you were away" — merges status
//! events, host exits and unread output offsets since the GUI's last-seen
//! sequence per session. Pure derivation from db facts; fully testable.

use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::models::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

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
    pub occurred_at: DateTime<Utc>,
    /// Byte offset in the log to jump to (None when rotated away).
    pub log_offset: Option<u64>,
    pub rotated_away: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryTimeline {
    pub entries: Vec<TimelineEntry>,
    pub completed: u32,
    pub waiting: u32,
    pub failed: u32,
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
        // (session_id, last_seen_sequence) pairs + unread offsets per session.
        let mut pairs: Vec<(String, i64)> = Vec::with_capacity(sessions.len());
        let mut unread_offsets: HashMap<&str, i64> = HashMap::with_capacity(sessions.len());
        for s in &sessions {
            let rs = match self.db.get_recovery_summary(&s.id) {
                Ok(rs) => rs,
                // insert_session/record_status_event always create the row; a
                // missing one means "never seen anything", not a hard failure.
                Err(CoreError::NotFound(_)) => RecoverySummary {
                    session_id: s.id.clone(),
                    last_seen_sequence: 0,
                    latest_sequence: 0,
                    unread_output_offset: 0,
                    summary_state: SummaryState::None,
                    acknowledged_at: None,
                },
                Err(e) => return Err(e),
            };
            pairs.push((s.id.clone(), rs.last_seen_sequence));
            unread_offsets.insert(s.id.as_str(), rs.unread_output_offset);
        }

        let events = self.db.events_since(&pairs)?;
        let sessions_by_id: HashMap<&str, &Session> =
            sessions.iter().map(|s| (s.id.as_str(), s)).collect();
        let mut project_names: HashMap<String, String> = HashMap::new();
        // (log_offset, rotated_away) is a per-session fact; compute it once.
        let mut offsets: HashMap<&str, (Option<u64>, bool)> = HashMap::new();
        // Last new event per session drives the completed/waiting/failed counts.
        let mut last_events: HashMap<&str, &StatusEvent> = HashMap::new();

        let mut timeline = RecoveryTimeline {
            entries: Vec::with_capacity(events.len()),
            ..RecoveryTimeline::default()
        };
        for e in &events {
            let Some(session) = sessions_by_id.get(e.session_id.as_str()).copied() else {
                continue;
            };
            let (log_offset, rotated_away) = match offsets.get(session.id.as_str()) {
                Some(v) => *v,
                None => {
                    // First unread byte vs. the log's current length: beyond the
                    // end, the log rotated since and there is nothing to jump to.
                    let offset = unread_offsets
                        .get(session.id.as_str())
                        .copied()
                        .unwrap_or(0)
                        .max(0) as u64;
                    let len = std::fs::metadata(&session.log_path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    let v = if offset >= len {
                        (None, true)
                    } else {
                        (Some(offset), false)
                    };
                    offsets.insert(session.id.as_str(), v);
                    v
                }
            };
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
                occurred_at: e.occurred_at,
                log_offset,
                rotated_away,
            });
            match last_events.get(e.session_id.as_str()) {
                Some(prev) if prev.sequence >= e.sequence => {}
                _ => {
                    last_events.insert(e.session_id.as_str(), e);
                }
            }
        }

        // Headline counts: one bucket per session, from its last new event.
        // Mirrors `summary_state_for` in db (private there); anything else —
        // plain working/output — is not counted.
        for e in last_events.values() {
            let ev = e.evidence.as_deref().unwrap_or("");
            match e.state {
                AgentState::NeedsInput => timeline.waiting += 1,
                AgentState::Idle if ev.contains("hook:Stop") || ev.contains("TurnEnd") => {
                    timeline.completed += 1
                }
                AgentState::Exited => {
                    if ev == "process:exit:0" {
                        timeline.completed += 1;
                    } else {
                        timeline.failed += 1;
                    }
                }
                _ => {}
            }
        }
        // Newest first; session id breaks ties deterministically.
        timeline.entries.sort_by(|a, b| {
            b.occurred_at
                .cmp(&a.occurred_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        Ok(timeline)
    }

    /// Mark all current entries acknowledged (updates last_seen_sequence +
    /// acknowledged_at per session).
    pub fn acknowledge_all(&self) -> Result<()> {
        let timeline = self.build()?;
        let ids: BTreeSet<&str> = timeline
            .entries
            .iter()
            .map(|e| e.session_id.as_str())
            .collect();
        for id in ids {
            self.db.acknowledge_recovery(id)?;
        }
        Ok(())
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
        }
    }

    fn session(id: &str, project_id: &str, title: &str, adapter: AgentType, log: &str) -> Session {
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
            log_path: log.into(),
            adapter_type: adapter,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
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
            sequence: seq,
            state,
            source,
            confidence: Confidence::High,
            evidence: Some(evidence.into()),
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
            "hook:Notification",
            t0 + Duration::seconds(5),
        ))
        .unwrap();
        (db, dir)
    }

    #[test]
    fn build_merges_counts_sorts_and_marks_offsets() {
        let (db, _dir) = fixture();
        let tl = Timeline { db: &db }.build().unwrap();
        assert_eq!(tl.entries.len(), 5);
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
        // Unread offset inside the log -> jump target.
        assert_eq!(done.log_offset, Some(100));
        assert!(!done.rotated_away);
        assert_eq!(tl.entries[0].log_offset, Some(7));
        assert!(!tl.entries[0].rotated_away);

        // Unread offset beyond the rotated log -> nothing to jump to.
        let fail = tl
            .entries
            .iter()
            .find(|e| e.session_id == "ses_fail" && e.state == AgentState::Exited)
            .unwrap();
        assert_eq!(fail.project_name, "Beta");
        assert_eq!(fail.log_offset, None);
        assert!(fail.rotated_away);
    }

    #[test]
    fn offset_at_log_end_counts_as_rotated() {
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
        db.set_unread_offset("ses_edge", 50).unwrap(); // == current file length
        db.record_status_event(&event(
            "ses_edge",
            1,
            AgentState::NeedsInput,
            StateSource::Hook,
            "hook:Notification",
            Utc::now(),
        ))
        .unwrap();
        let tl = Timeline { db: &db }.build().unwrap();
        assert_eq!(tl.entries.len(), 1);
        assert!(tl.entries[0].rotated_away);
        assert_eq!(tl.entries[0].log_offset, None);
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
        assert_eq!(tl.entries.len(), 104);
        // PRD ch.10: P95 <= 300 ms (verified on the release harness); the
        // debug gate stays generous.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "build took {elapsed:?}"
        );
    }
}
