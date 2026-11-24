//! Durable Project Manager Bot state for the AgentPort MCP sidecar.
//!
//! Bot state intentionally lives outside the main Session schema.  A Bot is an
//! orchestration/control-plane concept layered on top of ordinary AgentPort
//! Sessions; keeping its state in a private, atomically-written file lets the
//! MCP sidecar evolve without coupling every Bot change to a core DB migration.

use agentport_core::ids;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const BOT_DIR: &str = "mcp";
const STATE_FILE: &str = "bots.json";
const LOCK_FILE: &str = "bots.lock";
const LOCK_WAIT: Duration = Duration::from_millis(1500);
const LOCK_STALE: Duration = Duration::from_secs(5);
const STATE_VERSION: u32 = 1;

pub const MAX_BOT_TITLE_BYTES: usize = 200;
pub const MAX_TASK_TITLE_BYTES: usize = 240;
pub const MAX_TASK_PROMPT_BYTES: usize = 32 * 1024;
pub const MAX_MEMORY_BYTES: usize = 16 * 1024;
pub const MAX_BOT_TASKS: usize = 256;
pub const MAX_BOT_RUNNING_TASKS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRecord {
    pub bot_id: String,
    pub manager_session_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub project_path: String,
    pub title: String,
    pub agent: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_control_owner() -> String {
    "bot".into()
}

fn default_task_permission() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotTask {
    pub task_id: String,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    /// Acceptance criteria are persisted separately from the worker prompt so
    /// the manager can verify a result without trusting a free-form reply.
    #[serde(default)]
    pub acceptance_criteria: Option<String>,
    /// Write tasks must be dispatched with an isolated worktree unless the
    /// caller explicitly supplies one.
    #[serde(default)]
    pub write: bool,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default = "default_task_permission")]
    pub permission: String,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub worktree_id: Option<String>,
    /// The durable idempotency key supplied by the manager. Generated
    /// dispatch keys are attempt-scoped and are kept only in `dispatch_key`.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub dispatch_key: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// All child Sessions used by this task, retained for audit/retry history.
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub attempt: u32,
    pub status: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// `bot` owns automatic prompts by default; the desktop can atomically
    /// switch this to `user` while a user observes or takes over the child.
    #[serde(default = "default_control_owner")]
    pub control_owner: String,
    #[serde(default)]
    pub control_lease_id: Option<String>,
    #[serde(default)]
    pub control_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotMemory {
    pub memory_id: String,
    pub bot_id: String,
    pub kind: String,
    pub content: String,
    pub source: String,
    pub confidence: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotState {
    pub version: u32,
    #[serde(default)]
    pub bots: Vec<BotRecord>,
    #[serde(default)]
    pub tasks: Vec<BotTask>,
    #[serde(default)]
    pub memories: Vec<BotMemory>,
}

impl Default for BotState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            bots: vec![],
            tasks: vec![],
            memories: vec![],
        }
    }
}

#[derive(Debug)]
pub struct BotStore {
    dir: PathBuf,
    state: BotState,
}

impl BotStore {
    pub fn load(root: &Path) -> Self {
        let dir = root.join(BOT_DIR);
        let path = dir.join(STATE_FILE);
        let state = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<BotState>(&bytes) {
                Ok(mut state) if state.version == STATE_VERSION => {
                    state.bots.sort_by(|a, b| a.bot_id.cmp(&b.bot_id));
                    state.tasks.sort_by(|a, b| a.task_id.cmp(&b.task_id));
                    state.memories.sort_by(|a, b| a.memory_id.cmp(&b.memory_id));
                    state
                }
                Ok(_) | Err(_) => {
                    let backup = path.with_extension(format!("corrupt-{}", std::process::id()));
                    let _ = fs::rename(&path, backup);
                    BotState::default()
                }
            },
            Err(_) => BotState::default(),
        };
        Self { dir, state }
    }

    pub fn bots(&self) -> &[BotRecord] {
        &self.state.bots
    }

    pub fn tasks(&self) -> &[BotTask] {
        &self.state.tasks
    }

    pub fn memories(&self) -> &[BotMemory] {
        &self.state.memories
    }

    pub fn bot(&self, bot_id: &str) -> Option<&BotRecord> {
        self.state.bots.iter().find(|bot| bot.bot_id == bot_id)
    }

    pub fn bot_for_manager(&self, session_id: &str) -> Option<&BotRecord> {
        self.state
            .bots
            .iter()
            .find(|bot| bot.manager_session_id == session_id)
    }

    pub fn task(&self, bot_id: &str, task_id: &str) -> Option<&BotTask> {
        self.state
            .tasks
            .iter()
            .find(|task| task.bot_id == bot_id && task.task_id == task_id)
    }

    pub fn tasks_for_bot(&self, bot_id: &str) -> Vec<BotTask> {
        self.state
            .tasks
            .iter()
            .filter(|task| task.bot_id == bot_id)
            .cloned()
            .collect()
    }

    pub fn memories_for_bot(&self, bot_id: &str) -> Vec<BotMemory> {
        self.state
            .memories
            .iter()
            .filter(|memory| memory.bot_id == bot_id)
            .cloned()
            .collect()
    }

    pub fn task_by_dispatch_key(&self, bot_id: &str, key: &str) -> Option<BotTask> {
        self.state
            .tasks
            .iter()
            .find(|task| {
                task.bot_id == bot_id
                    && (task.dispatch_key.as_deref() == Some(key)
                        || task.idempotency_key.as_deref() == Some(key))
            })
            .cloned()
    }

    /// Reserve an attempt under the same lock that writes the state. The
    /// caller may then create the child Session; another MCP process cannot
    /// reserve the same task/dispatch key in the meantime.
    pub fn reserve_task(
        &mut self,
        bot_id: &str,
        task_id: &str,
        attempt: u32,
        dispatch_key: &str,
    ) -> io::Result<Result<(), String>> {
        let mut outcome = Ok(());
        self.mutate(|state| {
            let Some(index) = state
                .tasks
                .iter()
                .position(|item| item.bot_id == bot_id && item.task_id == task_id)
            else {
                outcome = Err("task_not_found".into());
                return;
            };
            let task = &state.tasks[index];
            if task.status == "completed" {
                outcome = Err("already_completed".into());
                return;
            }
            if task.control_owner == "user" {
                outcome = Err("intervention_lease_held".into());
                return;
            }
            if task.session_id.is_some() || task.status == "dispatching" {
                outcome = Err("already_dispatched".into());
                return;
            }
            if state.tasks.iter().any(|other| {
                other.bot_id == bot_id
                    && other.task_id != task_id
                    && (other.dispatch_key.as_deref() == Some(dispatch_key)
                        || other.idempotency_key.as_deref() == Some(dispatch_key))
            }) {
                outcome = Err("dispatch_key_exists".into());
                return;
            }
            if task.dependencies.iter().any(|dependency| {
                state
                    .tasks
                    .iter()
                    .find(|other| other.bot_id == bot_id && other.task_id == *dependency)
                    .is_none_or(|dependency| dependency.status != "completed")
            }) {
                outcome = Err("dependencies_blocked".into());
                return;
            }
            let task = &mut state.tasks[index];
            task.status = "dispatching".into();
            task.attempt = attempt;
            task.dispatch_key = Some(dispatch_key.into());
            task.error = None;
            task.updated_at = now();
        })?;
        Ok(outcome)
    }

    pub fn create_bot(&mut self, record: BotRecord) -> io::Result<()> {
        self.mutate(|state| {
            state.bots.retain(|bot| bot.bot_id != record.bot_id);
            state.bots.push(record);
        })
    }

    pub fn update_bot<F>(&mut self, bot_id: &str, update: F) -> io::Result<bool>
    where
        F: FnOnce(&mut BotRecord),
    {
        let mut changed = false;
        self.mutate(|state| {
            if let Some(bot) = state.bots.iter_mut().find(|bot| bot.bot_id == bot_id) {
                update(bot);
                bot.updated_at = now();
                changed = true;
            }
        })?;
        Ok(changed)
    }

    pub fn upsert_task(&mut self, task: BotTask) -> io::Result<()> {
        self.mutate(|state| {
            if let Some(existing) = state
                .tasks
                .iter_mut()
                .find(|item| item.bot_id == task.bot_id && item.task_id == task.task_id)
            {
                *existing = task;
            } else {
                state.tasks.push(task);
            }
        })
    }

    pub fn insert_task(&mut self, task: BotTask) -> io::Result<Result<(), String>> {
        let mut outcome = Ok(());
        self.mutate(|state| {
            if state
                .tasks
                .iter()
                .any(|item| item.bot_id == task.bot_id && item.task_id == task.task_id)
            {
                outcome = Err("task_exists".into());
            } else {
                state.tasks.push(task);
            }
        })?;
        Ok(outcome)
    }

    pub fn update_task<F>(&mut self, bot_id: &str, task_id: &str, update: F) -> io::Result<bool>
    where
        F: FnOnce(&mut BotTask),
    {
        let mut changed = false;
        self.mutate(|state| {
            if let Some(task) = state
                .tasks
                .iter_mut()
                .find(|item| item.bot_id == bot_id && item.task_id == task_id)
            {
                update(task);
                task.updated_at = now();
                changed = true;
            }
        })?;
        Ok(changed)
    }

    pub fn propose_memory(&mut self, memory: BotMemory) -> io::Result<()> {
        self.mutate(|state| {
            state
                .memories
                .retain(|item| item.memory_id != memory.memory_id);
            state.memories.push(memory);
        })
    }

    pub fn update_memory<F>(&mut self, bot_id: &str, memory_id: &str, update: F) -> io::Result<bool>
    where
        F: FnOnce(&mut BotMemory),
    {
        let mut changed = false;
        self.mutate(|state| {
            if let Some(memory) = state
                .memories
                .iter_mut()
                .find(|item| item.bot_id == bot_id && item.memory_id == memory_id)
            {
                update(memory);
                memory.updated_at = now();
                changed = true;
            }
        })?;
        Ok(changed)
    }

    pub fn remove_memory(&mut self, bot_id: &str, memory_id: &str) -> io::Result<bool> {
        let mut changed = false;
        self.mutate(|state| {
            let before = state.memories.len();
            state
                .memories
                .retain(|item| !(item.bot_id == bot_id && item.memory_id == memory_id));
            changed = before != state.memories.len();
        })?;
        Ok(changed)
    }

    fn mutate<F>(&mut self, apply: F) -> io::Result<()>
    where
        F: FnOnce(&mut BotState),
    {
        fs::create_dir_all(&self.dir)?;
        let _guard = FileLock::acquire(&self.dir.join(LOCK_FILE))?;
        let path = self.dir.join(STATE_FILE);
        let mut state = match fs::read(&path) {
            Ok(bytes) => {
                let state = serde_json::from_slice::<BotState>(&bytes).map_err(|error| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("invalid Bot state: {error}"),
                    )
                })?;
                if state.version != STATE_VERSION {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unsupported Bot state version {}", state.version),
                    ));
                }
                state
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => BotState::default(),
            Err(error) => return Err(error),
        };
        apply(&mut state);
        state.version = STATE_VERSION;
        state.bots.sort_by(|a, b| a.bot_id.cmp(&b.bot_id));
        state.tasks.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        state.memories.sort_by(|a, b| a.memory_id.cmp(&b.memory_id));
        write_state(&self.dir, &state)?;
        self.state = state;
        Ok(())
    }
}

pub fn new_bot_id() -> String {
    ids::new_id("bot")
}

pub fn new_task_id() -> String {
    ids::new_id("task")
}

pub fn new_memory_id() -> String {
    ids::new_id("mem")
}

pub fn new_lease_id() -> String {
    ids::new_id("lease")
}

pub fn now() -> String {
    Utc::now().to_rfc3339()
}

/// Memory is deliberately more restrictive than an ordinary task prompt.
/// Candidate memories are durable data, so obvious credentials and secret
/// material must be rejected before they can be confirmed or backed up.
pub fn validate_memory_text(field: &str, value: &str) -> io::Result<()> {
    validate_text(field, value, MAX_MEMORY_BYTES, true)?;
    let lower = value.to_ascii_lowercase();
    const SECRET_MARKERS: &[&str] = &[
        "-----begin ",
        "authorization: bearer",
        "api_key=",
        "apikey=",
        "password=",
        "passwd=",
        "secret=",
        "token=",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "sk-",
    ];
    if SECRET_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} appears to contain secret material"),
        ));
    }
    Ok(())
}

pub fn validate_text(
    field: &str,
    value: &str,
    max_bytes: usize,
    allow_newlines: bool,
) -> io::Result<()> {
    if value.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} must not be empty"),
        ));
    }
    if value.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} exceeds {max_bytes} bytes"),
        ));
    }
    if value.contains('\0') || value.contains('\u{1b}') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} must not contain NUL or ESC"),
        ));
    }
    if !allow_newlines && value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} must be one line"),
        ));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{field} contains unsupported control characters"),
        ));
    }
    Ok(())
}

fn write_state(dir: &Path, state: &BotState) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(STATE_FILE);
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    let body = serde_json::to_vec_pretty(state)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&tmp)?;
    io::Write::write_all(&mut file, &body)?;
    file.sync_all()?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(tmp, path)
}

struct FileLock {
    path: PathBuf,
}

impl FileLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        let deadline = SystemTime::now() + LOCK_WAIT;
        loop {
            match fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)
            {
                Ok(_) => {
                    return Ok(Self {
                        path: path.to_path_buf(),
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if let Ok(metadata) = fs::metadata(path) {
                        if let Ok(modified) = metadata.modified() {
                            if SystemTime::now()
                                .duration_since(modified)
                                .map(|age| age > LOCK_STALE)
                                .unwrap_or(false)
                            {
                                let _ = fs::remove_file(path);
                                continue;
                            }
                        }
                    }
                    if SystemTime::now() > deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "timed out waiting for the Bot state lock",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_round_trips_and_merges_external_writers() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = BotStore::load(dir.path());
        let mut second = BotStore::load(dir.path());
        let record = BotRecord {
            bot_id: "bot_a".into(),
            manager_session_id: "ses_a".into(),
            project_id: None,
            project_path: "/repo".into(),
            title: "PM".into(),
            agent: "claude".into(),
            status: "running".into(),
            created_at: now(),
            updated_at: now(),
        };
        first.create_bot(record.clone()).unwrap();
        second
            .create_bot(BotRecord {
                bot_id: "bot_b".into(),
                manager_session_id: "ses_b".into(),
                ..record
            })
            .unwrap();
        let loaded = BotStore::load(dir.path());
        assert_eq!(loaded.bots().len(), 2);
        assert_eq!(loaded.bot_for_manager("ses_a").unwrap().bot_id, "bot_a");
    }

    #[test]
    fn task_dispatch_key_is_idempotently_findable() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = BotStore::load(dir.path());
        store
            .create_bot(BotRecord {
                bot_id: "bot_a".into(),
                manager_session_id: "ses_a".into(),
                project_id: None,
                project_path: "/repo".into(),
                title: "PM".into(),
                agent: "claude".into(),
                status: "running".into(),
                created_at: now(),
                updated_at: now(),
            })
            .unwrap();
        let task = BotTask {
            task_id: "task_a".into(),
            bot_id: "bot_a".into(),
            title: "test".into(),
            prompt: "do it".into(),
            dependencies: vec![],
            acceptance_criteria: None,
            write: false,
            agent: Some("claude".into()),
            permission: "auto".into(),
            role_id: None,
            project_path: None,
            worktree_id: None,
            idempotency_key: None,
            dispatch_key: Some("bot_a/task_a/1".into()),
            session_id: None,
            session_ids: vec![],
            attempt: 1,
            status: "planned".into(),
            result: None,
            evidence: None,
            error: None,
            control_owner: "bot".into(),
            control_lease_id: None,
            control_updated_at: None,
            created_at: now(),
            updated_at: now(),
        };
        store.upsert_task(task).unwrap();
        assert_eq!(
            store
                .task_by_dispatch_key("bot_a", "bot_a/task_a/1")
                .unwrap()
                .task_id,
            "task_a"
        );
    }

    #[test]
    fn reserve_task_is_atomic_across_store_instances() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = BotStore::load(dir.path());
        first
            .create_bot(BotRecord {
                bot_id: "bot_a".into(),
                manager_session_id: "ses_a".into(),
                project_id: None,
                project_path: "/repo".into(),
                title: "PM".into(),
                agent: "claude".into(),
                status: "running".into(),
                created_at: now(),
                updated_at: now(),
            })
            .unwrap();
        first
            .upsert_task(BotTask {
                task_id: "task_a".into(),
                bot_id: "bot_a".into(),
                title: "test".into(),
                prompt: "do it".into(),
                dependencies: vec![],
                acceptance_criteria: None,
                write: false,
                agent: Some("claude".into()),
                permission: "auto".into(),
                role_id: None,
                project_path: None,
                worktree_id: None,
                idempotency_key: None,
                dispatch_key: None,
                session_id: None,
                session_ids: vec![],
                attempt: 0,
                status: "planned".into(),
                result: None,
                evidence: None,
                error: None,
                control_owner: "bot".into(),
                control_lease_id: None,
                control_updated_at: None,
                created_at: now(),
                updated_at: now(),
            })
            .unwrap();
        let mut second = BotStore::load(dir.path());
        assert_eq!(
            first
                .reserve_task("bot_a", "task_a", 1, "bot_a/task_a/1")
                .unwrap(),
            Ok(())
        );
        assert_eq!(
            second
                .reserve_task("bot_a", "task_a", 1, "bot_a/task_a/1")
                .unwrap(),
            Err("already_dispatched".into())
        );
    }

    #[test]
    fn invalid_text_is_rejected() {
        assert!(validate_text("prompt", "bad\u{1b}", 100, true).is_err());
        assert!(validate_text("title", "bad\nline", 100, false).is_err());
        assert!(validate_memory_text("memory", "token=do-not-store").is_err());
        assert!(validate_memory_text("memory", "Use the repository's stable API").is_ok());
    }
}
