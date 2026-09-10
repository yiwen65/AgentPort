//! Probe-triggered notification integration. Provider code is declarative; this
//! module owns filesystem changes and only activates verified installed assets.
use crate::{
    adapters::LaunchPlan,
    error::{CoreError, Result},
    models::{AdapterInstall, AgentType},
    paths::AppPaths,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
mod providers_cli;
mod providers_pi;
#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Hook,
    Native,
    Process,
    Heuristic,
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCoverage {
    pub completed: EventSource,
    pub needs_input: EventSource,
    pub failed: EventSource,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupState {
    Ready,
    Degraded,
    Failed,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSetup {
    pub agent: AgentType,
    pub state: SetupState,
    pub strategy: String,
    pub events: EventCoverage,
    pub detail: String,
    pub checked_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ManagedAsset {
    pub name: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GlobalAsset {
    pub relative_path: String,
    pub content: String,
}
/// Strict JSON only. Pointer identifies an array; missing object ancestors are created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct JsonRegistration {
    pub relative_path: String,
    pub pointer: String,
    pub entries: Vec<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct IntegrationPlan {
    pub strategy: String,
    pub events: EventCoverage,
    pub detail: String,
    pub assets: Vec<ManagedAsset>,
    pub launch_args: Vec<String>,
    pub launch_env: Vec<(String, String)>,
    pub global_assets: Vec<GlobalAsset>,
    pub json_registrations: Vec<JsonRegistration>,
    pub required_commands: Vec<String>,
}

const RELAY: &str = include_str!("relay.sh");
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Change {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    capability_hash: String,
    /// Hash the unexpanded provider plan and bundled relay, not only CLI help.
    /// Older manifests remain readable for rollback but cannot imply readiness.
    #[serde(default)]
    source_hash: String,
    status: NotificationSetup,
    plan: IntegrationPlan,
    changes: Vec<Change>,
}
fn err(message: impl Into<String>) -> CoreError {
    CoreError::Validation(message.into())
}
fn base(paths: &AppPaths, agent: AgentType) -> PathBuf {
    paths.root().join("notification-setup").join(agent.as_str())
}
fn no_symlinks(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(err("notification setup refuses symbolic links"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    no_symlinks(path)?;
    match fs::read(path) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn atomic(path: &Path, data: &[u8]) -> Result<()> {
    no_symlinks(path)?;
    let parent = path.parent().ok_or_else(|| err("missing parent"))?;
    fs::create_dir_all(parent)?;
    no_symlinks(path)?;
    let tmp = parent.join(format!(".agentport-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        no_symlinks(path)?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
struct Lock(fs::File);
impl Drop for Lock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn lock(dir: &Path) -> Result<Lock> {
    no_symlinks(dir)?;
    fs::create_dir_all(dir)?;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let p = dir.join("install.lock");
    no_symlinks(&p)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&p)?;
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(err(
            "notification setup is busy; refusing concurrent modification",
        ));
    }
    Ok(Lock(file))
}
fn relative(root: &Path, part: &str) -> Result<PathBuf> {
    if part.is_empty()
        || Path::new(part)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(err("unsafe notification asset path"));
    }
    Ok(root.join(part))
}
fn unavailable(agent: AgentType, detail: &str) -> NotificationSetup {
    NotificationSetup {
        agent,
        state: SetupState::Unavailable,
        strategy: "none".into(),
        events: EventCoverage {
            completed: EventSource::Unavailable,
            needs_input: EventSource::Unavailable,
            failed: EventSource::Unavailable,
        },
        detail: detail.into(),
        checked_at: Utc::now(),
    }
}
fn load(dir: &Path) -> Result<Option<Manifest>> {
    bytes(&dir.join("manifest.json"))?
        .map(|v| {
            let m: Manifest = serde_json::from_slice(&v)
                .map_err(|_| err("notification manifest is not supported JSON"))?;
            if m.version != 1 {
                return Err(err("unknown notification manifest version"));
            }
            Ok(m)
        })
        .transpose()
}
fn verify(m: &Manifest) -> Result<()> {
    for c in &m.changes {
        if bytes(&c.path)?.as_deref() != Some(c.after.as_slice()) {
            return Err(err(
                "notification files changed since installation; preserving user edits",
            ));
        }
    }
    Ok(())
}
fn add_change(changes: &mut Vec<Change>, path: PathBuf, after: Vec<u8>) -> Result<()> {
    if changes.iter().any(|c| c.path == path) {
        return Err(err("conflicting notification registration targets"));
    }
    let before = bytes(&path)?;
    changes.push(Change {
        path,
        before,
        after,
    });
    Ok(())
}
fn merge_array(
    value: &mut serde_json::Value,
    pointer: &str,
    entries: Vec<serde_json::Value>,
) -> Result<()> {
    if !pointer.starts_with('/') {
        return Err(err("invalid registration pointer"));
    }
    let parts: Vec<String> = pointer[1..]
        .split('/')
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut at = value;
    for (i, key) in parts.iter().enumerate() {
        let object = at
            .as_object_mut()
            .ok_or_else(|| err("notification registration requires JSON object ancestors"))?;
        at = object.entry(key.clone()).or_insert_with(|| {
            if i == parts.len() - 1 {
                serde_json::json!([])
            } else {
                serde_json::json!({})
            }
        });
    }
    let array = at
        .as_array_mut()
        .ok_or_else(|| err("notification registration target is not an array"))?;
    for entry in entries {
        if !array.contains(&entry) {
            array.push(entry);
        }
    }
    Ok(())
}
/// Absent CLIs never trigger writes or main-program installation.
pub fn for_probe(
    paths: &AppPaths,
    agent: AgentType,
    install: Option<&AdapterInstall>,
) -> NotificationSetup {
    match install {
        Some(install) => setup(paths, install),
        None => unavailable(agent, "CLI unavailable; no notification setup attempted"),
    }
}
/// Installation errors are represented separately from CLI capability availability.
pub fn setup(paths: &AppPaths, install: &AdapterInstall) -> NotificationSetup {
    let home = dirs::home_dir();
    let override_key = match install.agent_type {
        AgentType::Amp | AgentType::Opencode => Some("XDG_CONFIG_HOME"),
        AgentType::GrokBuild => Some("GROK_HOME"),
        AgentType::Gemini => Some("GEMINI_CLI_HOME"),
        _ => None,
    };
    let result = if override_key
        .is_some_and(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()))
    {
        Err(err("Custom provider configuration root is not supported for safe automatic registration; default HOME files were not changed"))
    } else {
        setup_inner(paths, install, home.as_deref())
    };
    match result {
        Ok(s) => s,
        Err(e) => {
            let mut s = unavailable(
                install.agent_type,
                &format!("Notification setup failed: {e}"),
            );
            s.state = SetupState::Failed;
            let dir = base(paths, install.agent_type);
            if let Ok(_guard) = lock(&dir) {
                if let Ok(data) = serde_json::to_vec(&s) {
                    let _ = atomic(&dir.join("failure.json"), &data);
                }
            }
            s
        }
    }
}
fn setup_inner(
    paths: &AppPaths,
    install: &AdapterInstall,
    home: Option<&Path>,
) -> Result<NotificationSetup> {
    let agent = install.agent_type;
    let Some(plan) = providers_pi::plan(install).or_else(|| providers_cli::plan(install)) else {
        return Ok(unavailable(
            agent,
            "No notification integration for this agent",
        ));
    };
    install_plan(paths, install, home, plan)
}
fn install_plan(
    paths: &AppPaths,
    install: &AdapterInstall,
    home: Option<&Path>,
    mut plan: IntegrationPlan,
) -> Result<NotificationSetup> {
    let agent = install.agent_type;
    if !Path::new("/bin/sh").is_file() {
        return Err(err("/bin/sh relay runtime unavailable"));
    }
    let dir = base(paths, agent);
    let _lock = lock(&dir)?;
    if bytes(&dir.join("failure.json"))?.is_some() {
        fs::remove_file(dir.join("failure.json"))?;
    }
    if bytes(&dir.join("pending.json"))?.is_some() {
        return Err(err(
            "interrupted notification transaction requires recovery; files preserved",
        ));
    }
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&plan)?);
    digest.update(RELAY.as_bytes());
    let source_hash = format!("{:x}", digest.finalize());
    let previous = load(&dir)?;
    if let Some(m) = &previous {
        verify(m)?;
        if m.capability_hash != install.capability_hash || m.source_hash != source_hash {
            return Err(err(
                "Agent capabilities or notification provider assets changed; existing files were preserved. Roll back the old integration, then probe again to install the updated integration",
            ));
        }
    }
    // Cached installation does not prove a runtime is still on PATH.
    for command in &plan.required_commands {
        if command.is_empty()
            || command
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_')
        {
            return Err(err("invalid required runtime name"));
        }
        let found = std::process::Command::new("/bin/sh")
            // GUI launchd PATH may omit a runtime discovered by the same
            // login-shell/version-manager lookup used for the Agent probe.
            .env("PATH", crate::adapters::capability::effective_path_env())
            .args([
                "-c",
                "command -v \"$1\" >/dev/null 2>&1",
                "agentport-runtime",
                command,
            ])
            .status()?;
        if !found.success() {
            return Err(err(format!(
                "Required notification runtime {command} is unavailable"
            )));
        }
    }
    if let Some(mut m) = previous {
        m.status.checked_at = Utc::now();
        atomic(&dir.join("manifest.json"), &serde_json::to_vec_pretty(&m)?)?;
        return Ok(m.status);
    }
    let assets = dir.join("assets");
    let relay = assets.join("relay.sh");
    let render = |s: &str| {
        s.replace("{{asset_dir}}", &assets.to_string_lossy())
            .replace("{{relay}}", &relay.to_string_lossy())
    };
    let mut changes = Vec::new();
    add_change(&mut changes, relay.clone(), RELAY.as_bytes().to_vec())?;
    for a in &plan.assets {
        add_change(
            &mut changes,
            relative(&assets, &a.name)?,
            render(&a.content).into_bytes(),
        )?;
    }
    for a in &plan.global_assets {
        let path = relative(
            home.ok_or_else(|| err("no home directory"))?,
            &a.relative_path,
        )?;
        // An unrelated existing standalone plugin is never adopted or overwritten.
        if bytes(&path)?.is_some() {
            return Err(err(
                "global notification asset already exists without ownership",
            ));
        }
        add_change(&mut changes, path, render(&a.content).into_bytes())?;
    }
    for r in &plan.json_registrations {
        let path = relative(
            home.ok_or_else(|| err("no home directory"))?,
            &r.relative_path,
        )?;
        let existing = changes.iter().position(|c| c.path == path);
        let original = match existing {
            Some(i) => Some(changes[i].after.clone()),
            None => bytes(&path)?,
        };
        let mut value = match original.as_deref() {
            Some(b) => serde_json::from_slice(b)
                .map_err(|_| err("only strict JSON settings can be safely merged"))?,
            None => serde_json::json!({}),
        };
        if agent == AgentType::Gemini {
            let hooks_disabled =
                value.pointer("/hooksConfig/enabled") == Some(&serde_json::json!(false));
            let observer_disabled = value
                .pointer("/hooksConfig/disabled")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|names| {
                    names
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .any(|disabled| {
                            disabled == "agentport-notifications"
                                || r.entries
                                    .iter()
                                    .filter_map(|entry| {
                                        entry.get("hooks").and_then(serde_json::Value::as_array)
                                    })
                                    .flatten()
                                    .filter_map(|hook| {
                                        hook.get("command").and_then(serde_json::Value::as_str)
                                    })
                                    .any(|command| render(command) == disabled)
                        })
                });
            if hooks_disabled || observer_disabled {
                return Err(err(
                    "Gemini notification hooks are disabled by user settings; settings preserved",
                ));
            }
        }
        fn render_json(v: &mut serde_json::Value, render: &impl Fn(&str) -> String) {
            match v {
                serde_json::Value::String(s) => *s = render(s),
                serde_json::Value::Array(a) => a.iter_mut().for_each(|v| render_json(v, render)),
                serde_json::Value::Object(o) => o.values_mut().for_each(|v| render_json(v, render)),
                _ => {}
            }
        }
        let mut entries = r.entries.clone();
        entries.iter_mut().for_each(|v| render_json(v, &render));
        merge_array(&mut value, &r.pointer, entries)?;
        let after = serde_json::to_vec_pretty(&value)?;
        if let Some(i) = existing {
            changes[i].after = after;
        } else {
            add_change(&mut changes, path, after)?;
        }
    }
    for c in &changes {
        if bytes(&c.path)? != c.before {
            return Err(err("notification config changed concurrently"));
        }
    }
    // Write-ahead ownership journal permits safe rollback after interruption.
    plan.launch_args = plan.launch_args.iter().map(|s| render(s)).collect();
    plan.launch_env = plan
        .launch_env
        .iter()
        .map(|(k, v)| (k.clone(), render(v)))
        .collect();
    // Process exit is crash-only coverage, not recoverable tool/model errors.
    let precise = |s| matches!(s, EventSource::Hook | EventSource::Native);
    let status = NotificationSetup {
        agent,
        state: if precise(plan.events.completed)
            && precise(plan.events.needs_input)
            && precise(plan.events.failed)
        {
            SetupState::Ready
        } else {
            SetupState::Degraded
        },
        strategy: plan.strategy.clone(),
        events: plan.events.clone(),
        detail: plan.detail.clone(),
        checked_at: Utc::now(),
    };
    let manifest = Manifest {
        version: 1,
        capability_hash: install.capability_hash.clone(),
        source_hash,
        status: status.clone(),
        plan,
        changes,
    };
    atomic(
        &dir.join("pending.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    let mut written = 0;
    let result = (|| -> Result<()> {
        for c in &manifest.changes {
            if bytes(&c.path)? != c.before {
                return Err(err("notification file changed concurrently"));
            }
            atomic(&c.path, &c.after)?;
            written += 1;
        }
        let check = std::process::Command::new("/bin/sh")
            .arg(&relay)
            .arg("completed")
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !check.success() {
            return Err(err("Installed notification relay self-test failed"));
        }
        atomic(
            &dir.join("manifest.json"),
            &serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(())
    })();
    if result.is_err() {
        for c in manifest.changes[..written].iter().rev() {
            if bytes(&c.path)?.as_deref() == Some(&c.after) {
                if let Some(before) = &c.before {
                    atomic(&c.path, before)?;
                } else {
                    fs::remove_file(&c.path)?;
                }
            }
        }
    }
    fs::remove_file(dir.join("pending.json"))?;
    result?;
    Ok(status)
}
pub fn list_status(paths: &AppPaths) -> Result<Vec<NotificationSetup>> {
    AgentType::all().iter().filter(|a|**a!=AgentType::Shell).map(|&a|{
        if let Some(data)=bytes(&base(paths,a).join("failure.json"))? { return serde_json::from_slice(&data).map_err(Into::into); }
        let Some(m)=load(&base(paths,a))? else {return Ok(unavailable(a,"Not configured; probe the agent to prepare notifications"));};
        let mut s=m.status.clone();if verify(&m).is_err(){s.state=SetupState::Failed;s.detail="Installed notification files changed or are missing; rollback/retry requires resolving the conflict".into();}Ok(s)
    }).collect()
}
pub fn apply_to_launch(paths: &AppPaths, agent: AgentType, launch: &mut LaunchPlan) -> Result<()> {
    if agent == AgentType::Shell {
        return Ok(());
    }
    if let Err(e) = apply_verified(paths, agent, launch) {
        launch.notices.push(crate::adapters::LaunchNotice::new("notification_setup_degraded", format!("Notification integration not activated: {e}. Basic agent startup remains available.")));
    }
    Ok(())
}
fn apply_verified(paths: &AppPaths, agent: AgentType, launch: &mut LaunchPlan) -> Result<()> {
    let dir = base(paths, agent);
    if bytes(&dir.join("failure.json"))?.is_some() || bytes(&dir.join("pending.json"))?.is_some() {
        return Err(err("notification integration is not verified; retry setup"));
    }
    let Some(m) = load(&dir)? else {
        return Err(err(
            "Notification setup is absent or rolled back; probe the agent to configure it",
        ));
    };
    verify(&m)?;
    launch.argv.extend(m.plan.launch_args);
    for (k, v) in m.plan.launch_env {
        launch.env.retain(|(key, _)| key != &k);
        launch.env.push((k, v));
    }
    launch
        .env
        .retain(|(k, _)| k != "AGENTPORT_NOTIFICATION_RELAY");
    launch.env.push((
        "AGENTPORT_NOTIFICATION_RELAY".into(),
        dir.join("assets/relay.sh").to_string_lossy().into_owned(),
    ));
    if let Some(id) = &launch.assigned_agent_session_id {
        launch
            .env
            .retain(|(k, _)| k != "AGENTPORT_NOTIFICATION_NATIVE_SESSION_ID");
        launch.env.push((
            "AGENTPORT_NOTIFICATION_NATIVE_SESSION_ID".into(),
            id.clone(),
        ));
    }
    Ok(())
}
pub fn rollback(paths: &AppPaths, agent: AgentType) -> Result<NotificationSetup> {
    let dir = base(paths, agent);
    let _lock = lock(&dir)?;
    let pending = bytes(&dir.join("pending.json"))?;
    let m = match load(&dir)? {
        Some(m) => m,
        None => match &pending {
            Some(data) => {
                let m: Manifest = serde_json::from_slice(data)?;
                if m.version != 1 {
                    return Err(err("unsupported recovery manifest"));
                }
                m
            }
            None => {
                if bytes(&dir.join("failure.json"))?.is_some() {
                    fs::remove_file(dir.join("failure.json"))?;
                }
                return Ok(unavailable(agent, "No installed notification integration"));
            }
        },
    };
    // Preflight every target before restoring anything. Accept already-restored
    // originals so an interrupted rollback can be safely retried.
    for c in &m.changes {
        let current = bytes(&c.path)?;
        if current.as_deref() != Some(c.after.as_slice()) && current != c.before {
            return Err(err(
                "notification files changed since installation; preserving user edits",
            ));
        }
    }
    for c in m.changes.iter().rev() {
        let current = bytes(&c.path)?;
        if current == c.before {
            continue;
        }
        if current.as_deref() != Some(c.after.as_slice()) {
            return Err(err("notification file changed during rollback"));
        }
        if let Some(before) = &c.before {
            atomic(&c.path, before)?;
        } else {
            fs::remove_file(&c.path)?;
        }
    }
    if bytes(&dir.join("manifest.json"))?.is_some() {
        fs::remove_file(dir.join("manifest.json"))?;
    }
    if pending.is_some() {
        fs::remove_file(dir.join("pending.json"))?;
    }
    if bytes(&dir.join("failure.json"))?.is_some() {
        fs::remove_file(dir.join("failure.json"))?;
    }
    Ok(unavailable(
        agent,
        "Notification integration rolled back; existing sessions are unchanged",
    ))
}
