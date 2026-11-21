//! Nonblocking wait groups for independent delegated Sessions.
//!
//! The stdio transport remains single-threaded, but waiting for an Agent turn
//! does not have to occupy that transport. Each job owns a small SessionOps
//! reader and waits in short quanta, while the main Toolbox only registers and
//! snapshots job state.

use crate::ops::{SessionOps, StatusMark, ToolFailure, WaitOutcome, MAX_WAIT_MS};
use agentport_service::RemoteService;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_WAIT_GROUP_ITEMS: usize = 32;
pub const DEFAULT_WAIT_GROUP_TIMEOUT_MS: u64 = 600_000;
pub const MAX_WAIT_GROUP_TIMEOUT_MS: u64 = 86_400_000;
const WAIT_QUANTUM_MS: u64 = 5_000;
const MAX_GROUPS: usize = 32;
const MAX_ACTIVE_JOBS: usize = 16;

#[derive(Debug, Clone)]
pub struct WaitSpec {
    pub session_id: String,
    pub task_id: Option<String>,
    pub baseline: Option<StatusMark>,
    pub prompt_fence: Option<String>,
}

#[derive(Debug, Clone)]
pub enum JobState {
    Waiting,
    Cancelling,
    Completed(Result<WaitOutcome, ToolFailure>),
    Cancelled,
}

struct JobRecord {
    state: Mutex<JobState>,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct WaitItem {
    pub session_id: String,
    pub task_id: Option<String>,
    pub job_id: String,
}

struct WaitGroup {
    items: Vec<WaitItem>,
}

struct Inner {
    groups: HashMap<String, WaitGroup>,
    jobs: HashMap<String, Arc<JobRecord>>,
    active_by_session: HashMap<String, String>,
}

#[derive(Clone)]
pub struct WaitRegistry {
    inner: Arc<Mutex<Inner>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
pub struct GroupSnapshot {
    pub group_id: String,
    pub items: Vec<SnapshotItem>,
    pub all_done: bool,
}

#[derive(Debug, Clone)]
pub struct SnapshotItem {
    pub session_id: String,
    pub task_id: Option<String>,
    pub state: JobState,
}

impl Default for WaitRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                groups: HashMap::new(),
                jobs: HashMap::new(),
                active_by_session: HashMap::new(),
            })),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl WaitRegistry {
    pub fn is_active(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .is_some_and(|inner| inner.active_by_session.contains_key(session_id))
    }

    pub fn start_group(
        &self,
        service: Arc<dyn RemoteService>,
        specs: Vec<WaitSpec>,
        timeout_ms: u64,
    ) -> Result<(String, Vec<WaitItem>), ToolFailure> {
        if specs.is_empty() {
            return Err(ToolFailure::new(
                "invalid_arguments",
                "tasks must contain at least one Session",
            ));
        }
        if specs.len() > MAX_WAIT_GROUP_ITEMS {
            return Err(ToolFailure::new(
                "invalid_arguments",
                format!("tasks must contain at most {MAX_WAIT_GROUP_ITEMS} items"),
            ));
        }
        let timeout_ms = timeout_ms.clamp(1_000, MAX_WAIT_GROUP_TIMEOUT_MS);
        let group_id = self.next_id("wait-group");
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut items = Vec::with_capacity(specs.len());
        let mut records = Vec::with_capacity(specs.len());
        {
            let mut inner = self.inner.lock().map_err(|_| {
                ToolFailure::new("wait_registry_failed", "wait registry lock poisoned")
            })?;
            prune_finished_groups(&mut inner);
            if inner.groups.len() >= MAX_GROUPS {
                return Err(ToolFailure::new(
                    "too_many_wait_groups",
                    format!("the MCP already tracks {MAX_GROUPS} wait groups; collect or cancel one first"),
                ));
            }
            if specs.len() + inner.active_by_session.len() > MAX_ACTIVE_JOBS {
                return Err(ToolFailure::new(
                    "too_many_waits",
                    format!("the MCP already monitors {MAX_ACTIVE_JOBS} active Session turns"),
                ));
            }
            let mut seen_sessions = HashSet::new();
            for spec in &specs {
                if !seen_sessions.insert(spec.session_id.clone())
                    || inner.active_by_session.contains_key(&spec.session_id)
                {
                    return Err(ToolFailure::new(
                        "wait_already_active",
                        format!(
                            "a background wait is already active for Session {}",
                            spec.session_id
                        ),
                    ));
                }
            }
            for spec in &specs {
                let job_id = self.next_id("wait-job");
                let record = Arc::new(JobRecord {
                    state: Mutex::new(JobState::Waiting),
                    cancel: Arc::new(AtomicBool::new(false)),
                });
                inner.jobs.insert(job_id.clone(), Arc::clone(&record));
                inner
                    .active_by_session
                    .insert(spec.session_id.clone(), job_id.clone());
                items.push(WaitItem {
                    session_id: spec.session_id.clone(),
                    task_id: spec.task_id.clone(),
                    job_id,
                });
                records.push(record);
            }
            inner.groups.insert(
                group_id.clone(),
                WaitGroup {
                    items: items.clone(),
                },
            );
        }

        for (spec, item, record) in specs
            .into_iter()
            .zip(items.iter().cloned())
            .zip(records.into_iter())
            .map(|((spec, item), record)| (spec, item, record))
        {
            let service = Arc::clone(&service);
            let registry = self.clone();
            let job_id = item.job_id.clone();
            let thread_name = format!("mcp-wait-{}", job_id);
            let worker_job_id = job_id.clone();
            let result = thread::Builder::new().name(thread_name).spawn(move || {
                run_waiter(registry, worker_job_id, service, spec, record, deadline);
            });
            if let Err(error) = result {
                self.finish(
                    &job_id,
                    Err(ToolFailure::new(
                        "wait_worker_failed",
                        format!("could not start wait worker: {error}"),
                    )),
                );
            }
        }
        Ok((group_id, items))
    }

    pub fn snapshot(&self, group_id: &str) -> Result<GroupSnapshot, ToolFailure> {
        let (items, jobs) = {
            let inner = self.inner.lock().map_err(|_| {
                ToolFailure::new("wait_registry_failed", "wait registry lock poisoned")
            })?;
            let group = inner.groups.get(group_id).ok_or_else(|| {
                ToolFailure::new("wait_group_not_found", format!("no wait group {group_id}"))
            })?;
            let jobs = group
                .items
                .iter()
                .filter_map(|item| {
                    inner
                        .jobs
                        .get(&item.job_id)
                        .map(|job| (item.clone(), Arc::clone(job)))
                })
                .collect::<Vec<_>>();
            (group.items.clone(), jobs)
        };
        let mut snapshots = Vec::with_capacity(jobs.len());
        for (item, job) in jobs {
            let state = job
                .state
                .lock()
                .map_err(|_| ToolFailure::new("wait_registry_failed", "wait job lock poisoned"))?
                .clone();
            let state = if matches!(state, JobState::Waiting) && job.cancel.load(Ordering::Acquire)
            {
                JobState::Cancelling
            } else {
                state
            };
            snapshots.push(SnapshotItem {
                session_id: item.session_id,
                task_id: item.task_id,
                state,
            });
        }
        let all_done = snapshots
            .iter()
            .all(|item| !matches!(item.state, JobState::Waiting | JobState::Cancelling));
        Ok(GroupSnapshot {
            group_id: group_id.to_string(),
            items: if snapshots.len() == items.len() {
                snapshots
            } else {
                Vec::new()
            },
            all_done,
        })
    }

    /// Release prompt ownership after a terminal result has been observed,
    /// while retaining the terminal snapshot for idempotent polling.
    pub fn release_sessions(&self, group_id: &str) -> Result<(), ToolFailure> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ToolFailure::new("wait_registry_failed", "wait registry lock poisoned"))?;
        let items = inner
            .groups
            .get(group_id)
            .ok_or_else(|| {
                ToolFailure::new("wait_group_not_found", format!("no wait group {group_id}"))
            })?
            .items
            .clone();
        for item in items {
            if inner.active_by_session.get(&item.session_id) == Some(&item.job_id) {
                inner.active_by_session.remove(&item.session_id);
            }
        }
        Ok(())
    }

    pub fn cancel(&self, group_id: &str) -> Result<GroupSnapshot, ToolFailure> {
        let job_ids = {
            let inner = self.inner.lock().map_err(|_| {
                ToolFailure::new("wait_registry_failed", "wait registry lock poisoned")
            })?;
            let group = inner.groups.get(group_id).ok_or_else(|| {
                ToolFailure::new("wait_group_not_found", format!("no wait group {group_id}"))
            })?;
            group
                .items
                .iter()
                .map(|item| item.job_id.clone())
                .collect::<Vec<_>>()
        };
        let inner = self
            .inner
            .lock()
            .map_err(|_| ToolFailure::new("wait_registry_failed", "wait registry lock poisoned"))?;
        for job_id in job_ids {
            if let Some(job) = inner.jobs.get(&job_id) {
                job.cancel.store(true, Ordering::Release);
            }
        }
        drop(inner);
        self.snapshot(group_id)
    }

    fn next_id(&self, prefix: &str) -> String {
        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{sequence}", std::process::id())
    }

    fn finish(&self, job_id: &str, result: Result<WaitOutcome, ToolFailure>) {
        let job = {
            let Ok(inner) = self.inner.lock() else { return };
            inner.jobs.get(job_id).cloned()
        };
        let Some(job) = job else { return };
        if job.cancel.load(Ordering::Acquire) {
            {
                let Ok(mut state) = job.state.lock() else {
                    return;
                };
                *state = JobState::Cancelled;
            }
            return;
        }
        {
            let Ok(mut state) = job.state.lock() else {
                return;
            };
            *state = JobState::Completed(result);
        }
    }
}

fn prune_finished_groups(inner: &mut Inner) {
    let finished = inner
        .groups
        .iter()
        .filter_map(|(group_id, group)| {
            let done = group.items.iter().all(|item| {
                inner
                    .jobs
                    .get(&item.job_id)
                    .and_then(|job| job.state.lock().ok())
                    .is_some_and(|state| {
                        !matches!(*state, JobState::Waiting | JobState::Cancelling)
                    })
            });
            done.then_some(group_id.clone())
        })
        .collect::<Vec<_>>();
    for group_id in finished {
        if let Some(group) = inner.groups.remove(&group_id) {
            for item in group.items {
                inner.jobs.remove(&item.job_id);
                inner.active_by_session.remove(&item.session_id);
            }
        }
    }
}

fn run_waiter(
    registry: WaitRegistry,
    job_id: String,
    service: Arc<dyn RemoteService>,
    spec: WaitSpec,
    record: Arc<JobRecord>,
    deadline: Instant,
) {
    let mut ops = SessionOps::new(service);
    if let Some(fence) = spec.prompt_fence.as_deref() {
        ops.remember_prompt(&spec.session_id, fence);
    }
    loop {
        if record.cancel.load(Ordering::Acquire) {
            ops.detach(&spec.session_id);
            registry.finish(
                &job_id,
                Err(ToolFailure::new(
                    "wait_cancelled",
                    "background wait was cancelled",
                )),
            );
            return;
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining == 0 {
            let outcome = ops.wait_for_task(&spec.session_id, 1_000, spec.baseline);
            ops.detach(&spec.session_id);
            match outcome {
                Ok(outcome) => registry.finish(&job_id, Ok(outcome)),
                Err(error) => registry.finish(&job_id, Err(error)),
            }
            return;
        }
        let quantum = remaining.min(WAIT_QUANTUM_MS).min(MAX_WAIT_MS).max(1_000);
        match ops.wait_for_task(&spec.session_id, quantum, spec.baseline) {
            Ok(outcome) if outcome.state == "timeout" && remaining > quantum => {
                continue;
            }
            Ok(outcome) => {
                ops.detach(&spec.session_id);
                registry.finish(&job_id, Ok(outcome));
                return;
            }
            Err(error) => {
                ops.detach(&spec.session_id);
                registry.finish(&job_id, Err(error));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::StubService;

    #[test]
    fn duplicate_sessions_in_one_group_are_rejected_before_workers_start() {
        let registry = WaitRegistry::default();
        let spec = || WaitSpec {
            session_id: "ses_duplicate".into(),
            task_id: None,
            baseline: None,
            prompt_fence: None,
        };
        let error = registry
            .start_group(Arc::new(StubService), vec![spec(), spec()], 1_000)
            .unwrap_err();
        assert_eq!(error.code, "wait_already_active");
        assert!(!registry.is_active("ses_duplicate"));
    }
}
