use crate::db::Db;
use crate::error::{CoreError, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::Digest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchOperationPhase {
    Prepared,
    Stashed,
    Switched,
    Applying,
    RestoredVerified,
    Cleaning,
    Completed,
    RecoveryRequired,
    Failed,
}

impl BranchOperationPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Stashed => "stashed",
            Self::Switched => "switched",
            Self::Applying => "applying",
            Self::RestoredVerified => "restored_verified",
            Self::Cleaning => "cleaning",
            Self::Completed => "completed",
            Self::RecoveryRequired => "recovery_required",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "prepared" => Self::Prepared,
            "stashed" => Self::Stashed,
            "switched" => Self::Switched,
            "applying" => Self::Applying,
            "restored_verified" => Self::RestoredVerified,
            "cleaning" => Self::Cleaning,
            "completed" => Self::Completed,
            "recovery_required" => Self::RecoveryRequired,
            "failed" => Self::Failed,
            other => {
                return Err(CoreError::Internal(format!(
                    "unknown branch operation phase: {other}"
                )))
            }
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStrategy {
    Target,
    Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchOperationKind {
    Create,
    Switch,
    Delete,
}

impl BranchOperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Switch => "switch",
            Self::Delete => "delete",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "create" => Ok(Self::Create),
            "switch" => Ok(Self::Switch),
            "delete" => Ok(Self::Delete),
            other => Err(CoreError::Internal(format!(
                "unknown branch operation kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOperation {
    pub id: String,
    pub kind: BranchOperationKind,
    pub project_id: String,
    pub repo_key: String,
    pub checkout_root: String,
    pub source_branch: Option<String>,
    pub source_commit: String,
    pub target_branch: String,
    pub target_oid: String,
    pub phase: BranchOperationPhase,
    pub stash_oid: Option<String>,
    pub stash_selector: Option<String>,
    pub stash_marker: Option<String>,
    pub snapshot_json: Option<String>,
    pub error_json: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOperationStep {
    pub operation_id: String,
    pub sequence: i64,
    pub phase: BranchOperationPhase,
    pub head_json: Option<serde_json::Value>,
    pub status_token: Option<String>,
    pub detail: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub incomplete: Vec<BranchOperation>,
    pub orphan_marker_stashes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStash {
    pub operation_id: String,
    pub phase: BranchOperationPhase,
    pub selector: String,
    pub oid: String,
    pub marker: String,
    pub source_branch: Option<String>,
    pub source_commit: String,
    pub target_branch: String,
    pub created_at: DateTime<Utc>,
}

pub(crate) struct OperationJournal<'a> {
    db: &'a Db,
}

impl<'a> OperationJournal<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn insert(&self, operation: &BranchOperation) -> Result<()> {
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO branch_operations(
                id,kind,project_id,repo_key,checkout_root,source_branch,source_commit,target_branch,
                target_oid,phase,stash_oid,stash_selector,stash_marker,snapshot_json,error_json,
                created_at,updated_at,completed_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![
                operation.id,
                operation.kind.as_str(),
                operation.project_id,
                operation.repo_key,
                operation.checkout_root,
                operation.source_branch,
                operation.source_commit,
                operation.target_branch,
                operation.target_oid,
                operation.phase.as_str(),
                operation.stash_oid,
                operation.stash_selector,
                operation.stash_marker,
                operation.snapshot_json,
                operation
                    .error_json
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                timestamp(&operation.created_at),
                timestamp(&operation.updated_at),
                operation.completed_at.as_ref().map(timestamp),
            ],
        )?;
        let head_json = serde_json::json!({
            "branch": operation.source_branch,
            "oid": operation.source_commit,
        });
        let status_token = operation
            .snapshot_json
            .as_ref()
            .map(|snapshot| format!("sha256:{:x}", sha2::Sha256::digest(snapshot.as_bytes())));
        Self::append_step_tx(
            &tx,
            operation.id.as_str(),
            operation.phase,
            Some(&head_json),
            status_token.as_deref(),
            Some("operation created"),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn update(
        &self,
        id: &str,
        phase: BranchOperationPhase,
        stash: Option<(&str, &str, &str)>,
        error: Option<&str>,
        detail: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        let error_json = error.map(|message| serde_json::json!({"message": message}).to_string());
        let completed_at = phase.is_terminal().then(|| timestamp(&now));
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = if let Some((oid, selector, marker)) = stash {
            tx.execute(
                "UPDATE branch_operations
                 SET phase=?2,stash_oid=?3,stash_selector=?4,stash_marker=?5,error_json=?6,
                     updated_at=?7,completed_at=?8
                 WHERE id=?1",
                params![
                    id,
                    phase.as_str(),
                    oid,
                    selector,
                    marker,
                    error_json,
                    timestamp(&now),
                    completed_at
                ],
            )?
        } else {
            tx.execute(
                "UPDATE branch_operations
                 SET phase=?2,error_json=?3,updated_at=?4,completed_at=?5 WHERE id=?1",
                params![
                    id,
                    phase.as_str(),
                    error_json,
                    timestamp(&now),
                    completed_at
                ],
            )?
        };
        if changed == 0 {
            return Err(CoreError::NotFound(format!("branch operation {id}")));
        }
        Self::append_step_tx(&tx, id, phase, None, None, detail)?;
        tx.commit()?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<BranchOperation> {
        let conn = self.db.conn().lock().unwrap();
        conn.query_row(
            "SELECT id,kind,project_id,repo_key,checkout_root,source_branch,source_commit,target_branch,
                    target_oid,phase,stash_oid,stash_selector,stash_marker,snapshot_json,error_json,
                    created_at,updated_at,completed_at
             FROM branch_operations WHERE id=?1",
            params![id],
            row_operation,
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                CoreError::NotFound(format!("branch operation {id}"))
            }
            other => CoreError::Sqlite(other),
        })
    }

    pub fn incomplete(&self, project_id: Option<&str>) -> Result<Vec<BranchOperation>> {
        let conn = self.db.conn().lock().unwrap();
        let base = "SELECT id,kind,project_id,repo_key,checkout_root,source_branch,source_commit,target_branch,
                           target_oid,phase,stash_oid,stash_selector,stash_marker,snapshot_json,error_json,
                           created_at,updated_at,completed_at
                    FROM branch_operations
                    WHERE phase NOT IN ('completed','failed')";
        let mut operations = if let Some(project_id) = project_id {
            let mut statement =
                conn.prepare(&format!("{base} AND project_id=?1 ORDER BY created_at"))?;
            let rows = statement
                .query_map(params![project_id], row_operation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        } else {
            let mut statement = conn.prepare(&format!("{base} ORDER BY created_at"))?;
            let rows = statement
                .query_map([], row_operation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        operations.sort_by_key(|operation| operation.created_at);
        Ok(operations)
    }

    pub fn steps(&self, id: &str) -> Result<Vec<BranchOperationStep>> {
        let conn = self.db.conn().lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT operation_id,sequence,phase,head_json,status_token,detail,occurred_at
             FROM branch_operation_steps WHERE operation_id=?1 ORDER BY sequence",
        )?;
        let rows = statement.query_map(params![id], |row| {
            let phase: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                phase,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (operation_id, sequence, phase, head_json, status_token, detail, occurred_at) =
                row?;
            Ok(BranchOperationStep {
                operation_id,
                sequence,
                phase: BranchOperationPhase::parse(&phase)?,
                head_json: head_json
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?,
                status_token,
                detail,
                occurred_at: parse_timestamp(&occurred_at)?,
            })
        })
        .collect()
    }

    pub fn record_observation(
        &self,
        id: &str,
        phase: BranchOperationPhase,
        head_json: &serde_json::Value,
        status_token: &str,
        detail: &str,
    ) -> Result<()> {
        self.append_step(id, phase, Some(head_json), Some(status_token), Some(detail))
    }

    fn append_step(
        &self,
        id: &str,
        phase: BranchOperationPhase,
        head_json: Option<&serde_json::Value>,
        status_token: Option<&str>,
        detail: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.db.conn().lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::append_step_tx(&tx, id, phase, head_json, status_token, detail)?;
        tx.commit()?;
        Ok(())
    }

    fn append_step_tx(
        tx: &Transaction<'_>,
        id: &str,
        phase: BranchOperationPhase,
        head_json: Option<&serde_json::Value>,
        status_token: Option<&str>,
        detail: Option<&str>,
    ) -> Result<()> {
        tx.execute(
            "INSERT INTO branch_operation_steps(
                operation_id,sequence,phase,head_json,status_token,detail,occurred_at
             )
             SELECT ?1,COALESCE(MAX(sequence),0)+1,?2,?3,?4,?5,?6
             FROM branch_operation_steps WHERE operation_id=?1",
            params![
                id,
                phase.as_str(),
                head_json.map(serde_json::to_string).transpose()?,
                status_token,
                detail,
                timestamp(&Utc::now())
            ],
        )?;
        Ok(())
    }

    pub fn operation_for_marker(&self, marker: &str) -> Result<Option<String>> {
        let conn = self.db.conn().lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT id FROM branch_operations WHERE stash_marker=?1",
                params![marker],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn auto_stashes(&self, project_id: &str) -> Result<Vec<AutoStash>> {
        Ok(self
            .incomplete(Some(project_id))?
            .into_iter()
            .filter_map(|operation| {
                Some(AutoStash {
                    operation_id: operation.id,
                    phase: operation.phase,
                    selector: operation.stash_selector?,
                    oid: operation.stash_oid?,
                    marker: operation.stash_marker?,
                    source_branch: operation.source_branch,
                    source_commit: operation.source_commit,
                    target_branch: operation.target_branch,
                    created_at: operation.created_at,
                })
            })
            .collect())
    }
}

fn row_operation(row: &rusqlite::Row<'_>) -> rusqlite::Result<BranchOperation> {
    let kind: String = row.get(1)?;
    let phase: String = row.get(9)?;
    let error_json: Option<String> = row.get(14)?;
    let created: String = row.get(15)?;
    let updated: String = row.get(16)?;
    let completed: Option<String> = row.get(17)?;
    Ok(BranchOperation {
        id: row.get(0)?,
        kind: BranchOperationKind::parse(&kind).map_err(to_sql_error)?,
        project_id: row.get(2)?,
        repo_key: row.get(3)?,
        checkout_root: row.get(4)?,
        source_branch: row.get(5)?,
        source_commit: row.get(6)?,
        target_branch: row.get(7)?,
        target_oid: row.get(8)?,
        phase: BranchOperationPhase::parse(&phase).map_err(to_sql_error)?,
        stash_oid: row.get(10)?,
        stash_selector: row.get(11)?,
        stash_marker: row.get(12)?,
        snapshot_json: row.get(13)?,
        error_json: error_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| to_sql_error(CoreError::Json(error)))?,
        created_at: parse_timestamp(&created).map_err(to_sql_error)?,
        updated_at: parse_timestamp(&updated).map_err(to_sql_error)?,
        completed_at: completed
            .map(|value| parse_timestamp(&value))
            .transpose()
            .map_err(to_sql_error)?,
    })
}

fn timestamp(value: &DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)
        .map_err(|error| CoreError::Internal(format!("invalid operation timestamp: {error}")))?
        .with_timezone(&Utc))
}

fn to_sql_error(error: CoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Project;

    fn fixture() -> (Db, BranchOperation) {
        let db = Db::open_memory().unwrap();
        db.add_project(&Project {
            id: "prj_journal".into(),
            name: "journal".into(),
            root_path: "/tmp/journal".into(),
            git_root_path: Some("/tmp/journal".into()),
            created_at: Utc::now(),
        })
        .unwrap();
        let now = Utc::now();
        let operation = BranchOperation {
            id: "op_atomic".into(),
            kind: BranchOperationKind::Switch,
            project_id: "prj_journal".into(),
            repo_key: "repo-key".into(),
            checkout_root: "/tmp/journal".into(),
            source_branch: Some("main".into()),
            source_commit: "1111111111111111111111111111111111111111".into(),
            target_branch: "feature".into(),
            target_oid: "2222222222222222222222222222222222222222".into(),
            phase: BranchOperationPhase::Prepared,
            stash_oid: None,
            stash_selector: None,
            stash_marker: None,
            snapshot_json: Some("{}".into()),
            error_json: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        };
        (db, operation)
    }

    fn reject_step_inserts(db: &Db) {
        db.conn()
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_branch_operation_step
                 BEFORE INSERT ON branch_operation_steps
                 BEGIN
                   SELECT RAISE(ABORT, 'injected step failure');
                 END;",
            )
            .unwrap();
    }

    #[test]
    fn insert_rolls_back_operation_when_initial_step_fails() {
        let (db, operation) = fixture();
        reject_step_inserts(&db);
        let journal = OperationJournal::new(&db);

        assert!(journal.insert(&operation).is_err());
        assert!(matches!(
            journal.get(&operation.id),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn update_rolls_back_phase_when_step_fails() {
        let (db, operation) = fixture();
        let journal = OperationJournal::new(&db);
        journal.insert(&operation).unwrap();
        reject_step_inserts(&db);

        assert!(journal
            .update(
                &operation.id,
                BranchOperationPhase::Switched,
                None,
                None,
                Some("switched"),
            )
            .is_err());
        assert_eq!(
            journal.get(&operation.id).unwrap().phase,
            BranchOperationPhase::Prepared
        );
        assert_eq!(journal.steps(&operation.id).unwrap().len(), 1);
    }
}
