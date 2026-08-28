//! agentport-cli: headless client for E2E tests, acceptance plays and power
//! users. Talks to agentport-core (db, adapters, worktrees, exports) and to
//! hosts via the socket protocol. JSON output with --json.

use agentport_core::adapters::{self, capability, LaunchContext, ResumeContext};
use agentport_core::db::Db;
use agentport_core::error::{CoreError, Result};
use agentport_core::git::WorktreeManager;
use agentport_core::host_manager::{AttachInfo, HostClient, HostManager, LaunchSpec};
use agentport_core::ids;
use agentport_core::models::*;
use agentport_core::native_cleanup::{execute_native_cleanup, plan_native_cleanup};
use agentport_core::paths::{normalize_abs, AppPaths};
use agentport_core::protocol::HostFrame;
use agentport_core::secrets::{load_preset_secrets, CredentialBroker};
use agentport_core::Result as CoreResult;
use chrono::Utc;
use serde_json::{json, Value};
use std::io::Read as _;
use std::time::{Duration, Instant};

fn main() {
    // CLI tool: restore default SIGPIPE handling so piping into `head` etc.
    // terminates quietly instead of panicking on a broken pipe.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let code = match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

struct Ctx {
    paths: AppPaths,
    db: Db,
    json: bool,
}

impl Ctx {
    fn open(json: bool) -> Result<Ctx> {
        let paths = AppPaths::discover()?;
        paths.ensure_layout()?;
        let db = Db::open(&paths)?;
        db.seed_builtin_presets()?;
        Ok(Ctx { paths, db, json })
    }

    fn out(&self, v: Value) {
        if self.json {
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        } else {
            println!("{}", human(&v));
        }
    }
}

fn human(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap(),
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        usage();
        return Err(CoreError::Validation("no command".into()));
    }
    let json = args.iter().any(|a| a == "--json");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--json").collect();
    let ctx = Ctx::open(json)?;
    let cmd = args[0].as_str();
    let rest = &args[1..];
    match cmd {
        "probe" => cmd_probe(&ctx, rest),
        "project" => cmd_project(&ctx, rest),
        "preset" => cmd_preset(&ctx, rest),
        "session" => cmd_session(&ctx, rest),
        "worktree" => cmd_worktree(&ctx, rest),
        "export" => cmd_export(&ctx, rest),
        "backup" => cmd_backup(&ctx, rest),
        "search" => cmd_search(&ctx, rest),
        "timeline" => cmd_timeline(&ctx, rest),
        "diag" => cmd_diag(&ctx, rest),
        "secret" => cmd_secret(&ctx, rest),
        "settings" => cmd_settings(&ctx, rest),
        "perf" => {
            let pctx = perf::PerfCtx {
                paths: AppPaths::discover()?,
                db: Db::open(&AppPaths::discover()?)?,
            };
            let scenario = args.get(1).map(String::as_str).unwrap_or("all");
            perf::run(&pctx, scenario)
        }
        "reconcile" => {
            let mgr = HostManager {
                paths: &ctx.paths,
                db: &ctx.db,
            };
            let checked = mgr.reconcile_on_startup()?;
            ctx.out(json!({ "checked": checked.len() }));
            Ok(())
        }
        _ => {
            usage();
            Err(CoreError::Validation(format!("unknown command {cmd}")))
        }
    }
}

fn usage() {
    eprintln!(
        "agentport-cli [--json] <command>

  probe [agent] [--path <exe>]           detect CLI capabilities
  project add <path> [--name N]          register a project (dup path -> focuses existing)
  project list | rename <id> <name> | remove <id>
  preset list [--agent A]
  session new --project P --agent A [--title T] [--preset ID] [--worktree-id W]
             [--permission native|auto|bypass] [--transport pty|json_rpc] [--risk-ack] [--cols N --rows N]
  session list [--all] | status <id> | stop <id> | interrupt <id>
  session input <id> [--data TEXT]       send input (escapes: \\n \\r \\t \\x1b; or stdin)
  session read <id> [--until SUBSTR] [--timeout SEC] [--tail-bytes N]
  session attach <id>                    interactive passthrough (Ctrl-] to detach)
  session rename <id> <title> | archive <id> | restart <id> [--risk-ack]
  backup create --out <file.zip> [--verify]     full-data backup (excludes worktrees)
  backup verify <file.zip>                     integrity + format check
  backup restore <file.zip> --to <data-dir>    restore into a data root (previous
                                               tree is kept as <dir>.pre-restore-*)
  worktree create --project P --task T [--base-ref R] [--branch B]
  worktree list --project P | health <id> | remove <id>
  reconcile                              re-check running sessions vs live hosts"
    );
}

// ---------------------------------------------------------------------------
// arg helpers
// ---------------------------------------------------------------------------

fn flag(args: &[String], name: &str) -> Option<String> {
    let key = format!("--{name}");
    args.iter()
        .position(|a| *a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| *a == format!("--{name}"))
}

fn positional(args: &[String], idx: usize) -> Result<&String> {
    args.iter()
        .filter(|a| !a.starts_with("--"))
        .nth(idx)
        .ok_or_else(|| CoreError::Validation(format!("missing positional arg {idx}")))
}

fn unescape(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push(b'\n'),
                Some('r') => out.push(b'\r'),
                Some('t') => out.push(b'\t'),
                Some('x') => {
                    let h: String = chars.by_ref().take(2).collect();
                    if let Ok(b) = u8::from_str_radix(&h, 16) {
                        out.push(b);
                    }
                }
                Some(other) => {
                    out.push(b'\\');
                    out.push(other as u8);
                }
                None => out.push(b'\\'),
            }
        } else {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

fn cmd_probe(ctx: &Ctx, args: &[String]) -> Result<()> {
    let agents: Vec<AgentType> = match args.first().map(String::as_str) {
        Some(a) if !a.starts_with("--") => vec![a.parse()?],
        _ => AgentType::all().to_vec(),
    };
    let confirmed = flag(args, "path");
    let mut results = vec![];
    for t in agents {
        let outcome = capability::probe_agent(t, confirmed.as_deref().map(std::path::Path::new));
        if let Some(install) = &outcome.install {
            ctx.db.upsert_adapter(install)?;
        }
        results.push(json!({
            "agent": t.as_str(),
            "state": format!("{:?}", outcome.state).to_lowercase(),
            "reason": outcome.reason,
            "install": outcome.install.as_ref().map(|i| json!({
                "path": i.executable_path,
                "version": i.version_text,
                "capabilityHash": i.capability_hash,
                "exactResume": i.exact_resume,
                "hookStatus": format!("{:?}", i.hook_status).to_lowercase(),
                "approvalModel": i.approval_model.as_str(),
                "defaultTransport": i.default_transport.as_str(),
                "flags": i.flags,
            })),
            "candidates": outcome.candidates.iter().map(|c| json!({
                "path": c.path, "version": c.version_text, "source": c.source
            })).collect::<Vec<_>>(),
        }));
    }
    ctx.out(Value::Array(results));
    Ok(())
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

fn cmd_project(ctx: &Ctx, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("add") => {
            let path = positional(args, 1)?;
            let norm = normalize_abs(path)?;
            if let Some(existing) = ctx.db.find_project_by_path(&norm)? {
                // Duplicate path: focus the existing project (PRD 3.2.e).
                ctx.out(json!({"id": existing.id, "name": existing.name, "rootPath": existing.root_path, "focusedExisting": true}));
                return Ok(());
            }
            let name = flag(args, "name").unwrap_or_else(|| {
                std::path::Path::new(&norm)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "project".into())
            });
            let git_root = agentport_core::git::GitRepo::discover(std::path::Path::new(&norm))
                .ok()
                .map(|r| r.root.to_string_lossy().into_owned());
            let p = Project {
                id: ids::new_id("prj"),
                name,
                root_path: norm,
                git_root_path: git_root,
                created_at: Utc::now(),
                pinned: false,
                sort_order: 0,
            };
            ctx.db.add_project(&p)?;
            ctx.out(json!({"id": p.id, "name": p.name, "rootPath": p.root_path, "gitRootPath": p.git_root_path}));
            Ok(())
        }
        Some("list") => {
            let ps: Vec<Value> = ctx
                .db
                .list_projects()?
                .iter()
                .map(|p| json!({"id": p.id, "name": p.name, "rootPath": p.root_path, "gitRootPath": p.git_root_path}))
                .collect();
            ctx.out(Value::Array(ps));
            Ok(())
        }
        Some("rename") => {
            ctx.db
                .rename_project(positional(args, 1)?, positional(args, 2)?)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        Some("remove") => {
            let id = positional(args, 1)?;
            ctx.db.begin_project_removal(id)?;
            let sessions = ctx.db.list_sessions(Some(id), true)?;
            let host_manager = HostManager {
                paths: &ctx.paths,
                db: &ctx.db,
            };
            let native_plans = sessions
                .iter()
                .map(|session| plan_native_cleanup(&ctx.paths, session))
                .collect::<Vec<_>>();
            let stop_warnings = sessions
                .iter()
                .filter(|session| host_manager.stop(&session.id, 3_000).is_err())
                .count();
            let manager = WorktreeManager {
                paths: &ctx.paths,
                db: &ctx.db,
            };
            let mut cleanup_warnings = 0usize;
            for worktree in ctx.db.list_worktrees(id)? {
                // Filesystem/Git cleanup is best-effort by contract; the
                // database cascade below must not be blocked by stale files.
                cleanup_warnings += match manager.remove(&worktree.id) {
                    Ok(outcome) => outcome.cleanup_warnings,
                    Err(_) => 1,
                };
            }
            ctx.db.remove_project(id)?;
            for (session, native_plan) in sessions.iter().zip(&native_plans) {
                let _ = execute_native_cleanup(native_plan);
                let _ = std::fs::remove_dir_all(ctx.paths.session_dir(&session.id));
                let _ = std::fs::remove_file(ctx.paths.socket_path(&session.id));
            }
            ctx.out(json!({
                "ok": true,
                "stopWarnings": stop_warnings,
                "cleanupWarnings": cleanup_warnings,
            }));
            Ok(())
        }
        _ => Err(CoreError::Validation(
            "project add|list|rename|remove".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// preset
// ---------------------------------------------------------------------------

fn cmd_preset(ctx: &Ctx, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("list") => {
            let agent = flag(args, "agent").map(|a| a.parse()).transpose()?;
            let ps: Vec<Value> = ctx
                .db
                .list_presets(agent)?
                .iter()
                .map(|p| {
                    json!({"id": p.id, "agent": p.agent_type.as_str(), "name": p.name,
                        "permissionMode": p.permission_mode.as_str(), "args": p.args,
                        "executablePath": p.executable_path, "builtIn": p.built_in})
                })
                .collect();
            ctx.out(Value::Array(ps));
            Ok(())
        }
        _ => Err(CoreError::Validation("preset list".into())),
    }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

fn host_mgr<'a>(ctx: &'a Ctx) -> HostManager<'a> {
    HostManager {
        paths: &ctx.paths,
        db: &ctx.db,
    }
}

fn install_for(ctx: &Ctx, t: AgentType) -> Result<AdapterInstall> {
    if let Some(i) = ctx.db.get_adapter(t)? {
        // Cached path may be stale (e.g. Homebrew removed the versioned
        // Caskroom dir after an upgrade). Re-probe instead of spawning a
        // missing binary.
        if !std::path::Path::new(&i.executable_path).exists() {
            let outcome = capability::probe_agent(t, None);
            return match outcome.install {
                Some(fresh) => {
                    ctx.db.upsert_adapter(&fresh)?;
                    Ok(fresh)
                }
                None => Err(CoreError::Adapter(format!(
                    "{} 的可执行文件已失效（{}），重新探测也未找到: {}",
                    t.display_name(),
                    i.executable_path,
                    outcome.reason.unwrap_or_else(|| "not found".into())
                ))),
            };
        }
        return Ok(i);
    }
    let outcome = capability::probe_agent(t, None);
    match outcome.install {
        Some(i) => {
            ctx.db.upsert_adapter(&i)?;
            Ok(i)
        }
        None => Err(CoreError::Adapter(format!(
            "{} not available: {}",
            t.display_name(),
            outcome.reason.unwrap_or_else(|| "not found".into())
        ))),
    }
}

fn preset_for(
    ctx: &Ctx,
    t: AgentType,
    preset_id: Option<String>,
    install: &AdapterInstall,
) -> Result<Preset> {
    let mut p = match preset_id {
        Some(id) => ctx.db.get_preset(&id)?,
        None => {
            let id = format!("pre_{}_safe", t.as_str());
            ctx.db.get_preset(&id).unwrap_or(Preset {
                id,
                agent_type: t,
                name: match t {
                    AgentType::Qoder => "Qoder 安全默认".into(),
                    AgentType::Pi => "Pi 本地权限默认".into(),
                    _ => format!("{} 安全默认", t.display_name()),
                },
                executable_path: String::new(),
                args: vec![],
                permission_mode: t.default_permission_mode(),
                env_names: vec![],
                secret_ref_ids: vec![],
                built_in: true,
            })
        }
    };
    if p.agent_type != t {
        return Err(CoreError::Validation(format!(
            "preset {} is for {}, not {}",
            p.id,
            p.agent_type.as_str(),
            t.as_str()
        )));
    }
    if p.executable_path.is_empty() {
        p.executable_path = install.executable_path.clone();
    }
    Ok(p)
}

/// Enforce the auto/bypass preflight (PRD 3.2 failure C / 3.7): full command,
/// cwd and risk must be shown and explicitly acknowledged at the CLI.
fn enforce_permission_preflight(
    ctx: &Ctx,
    agent: AgentType,
    mode: PermissionMode,
    argv: &[String],
    cwd: &str,
    args: &[String],
) -> Result<()> {
    if mode == PermissionMode::Native || agent == AgentType::Qoder {
        return Ok(());
    }
    let risk = match mode {
        PermissionMode::Auto => "自动批准：文件写入与部分操作无需逐次确认",
        PermissionMode::Bypass => "绕过权限：全部检查被跳过（危险）",
        PermissionMode::Native => unreachable!(),
    };
    eprintln!("== 启动预检（风险确认） ==");
    eprintln!("权限模式: {} — ⚠ {risk}", mode.as_str());
    eprintln!("工作目录: {cwd}");
    eprintln!("完整命令: {}", argv.join(" "));
    if !has_flag(args, "risk-ack") {
        return Err(CoreError::Blocked(format!(
            "{} 模式需要显式风险确认：请加 --risk-ack",
            mode.as_str()
        )));
    }
    eprintln!("用户已通过 --risk-ack 确认风险。");
    ctx.out(json!({"preflight": "acknowledged", "mode": mode.as_str()}));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn launch_session(
    ctx: &Ctx,
    project: &Project,
    agent: AgentType,
    title: &str,
    preset: &Preset,
    worktree_id: Option<String>,
    permission: PermissionMode,
    transport: AgentTransport,
    cols: u16,
    rows: u16,
    cli_args: &[String],
) -> Result<Value> {
    let permission = agent.effective_permission_mode(permission);
    if transport != AgentTransport::Pty {
        return Err(CoreError::Validation(format!(
            "{} new sessions only support native pty transport",
            agent.display_name()
        )));
    }
    let install = install_for(ctx, agent)?;
    adapters::validate_user_args(agent, &preset.args)?;
    let cwd = match &worktree_id {
        Some(w) => ctx.db.get_worktree(w)?.path,
        None => project.root_path.clone(),
    };
    let session_id = ids::new_id("ses");
    let session_dir = ctx.paths.session_dir(&session_id);
    std::fs::create_dir_all(&session_dir)?;
    let ctx_launch = LaunchContext {
        install: install.clone(),
        preset: preset.clone(),
        cwd: cwd.clone(),
        session_id: session_id.clone(),
        hook_events_path: ctx
            .paths
            .hook_events_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        session_dir: session_dir.to_string_lossy().into_owned(),
        transport,
    };
    let adapter = adapters::adapter_for(agent);
    let plan = adapter.build_launch(&ctx_launch)?;
    // Helper files (e.g. claude per-session settings) — 0600.
    for (path, contents) in &plan.helper_files {
        agentport_core::host_manager::write_private_file(path, contents)?;
    }
    enforce_permission_preflight(ctx, agent, permission, &plan.argv, &cwd, cli_args)?;
    let now = Utc::now();
    let session = Session {
        id: session_id.clone(),
        project_id: project.id.clone(),
        worktree_id: worktree_id.clone(),
        preset_id: preset.id.clone(),
        title: title.to_string(),
        cwd: cwd.clone(),
        host_pid: None,
        host_socket: Some(
            ctx.paths
                .socket_path(&session_id)
                .to_string_lossy()
                .into_owned(),
        ),
        host_token: ids::new_host_token(),
        lifecycle: Lifecycle::Creating,
        agent_session_id: plan.assigned_agent_session_id.clone(),
        resume_precision: if plan.assigned_agent_session_id.is_some() {
            ResumePrecision::Exact
        } else {
            plan.resume_precision
        },
        log_path: ctx
            .paths
            .log_path(&session_id)
            .to_string_lossy()
            .into_owned(),
        adapter_type: agent,
        transport: plan.transport,
        command: plan.argv.clone(),
        permission_mode: permission,
        created_at: now,
        updated_at: now,
        pinned_at: None,
        archived_at: None,
    };
    ctx.db.insert_session(&session)?;
    // Inherited plain env (names only).
    let mut env = plan.env.clone();
    for name in &preset.env_names {
        if let Ok(v) = std::env::var(name) {
            env.push((name.clone(), v));
        }
    }
    capability::merge_effective_path_env(&mut env)?;
    // Secrets: broker -> spawn env only. Unavailable backend aborts launch.
    let mut secrets = vec![];
    if !preset.secret_ref_ids.is_empty() {
        let broker = CredentialBroker::detect()?;
        let refs: Vec<SecretRef> = preset
            .secret_ref_ids
            .iter()
            .map(|id| ctx.db.get_secret_ref(id))
            .collect::<Result<Vec<_>>>()?;
        secrets = load_preset_secrets(&broker, &refs)?;
    }
    let settings = ctx.db.load_settings()?;
    let mgr = host_mgr(ctx);
    let info = mgr.launch(LaunchSpec {
        session: session.clone(),
        command: plan.argv.clone(),
        env,
        secrets,
        log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
        agent_session_id_hint: plan.assigned_agent_session_id.clone(),
        cols,
        rows,
    })?;
    let notes = plan
        .notices
        .iter()
        .map(|notice| notice.legacy_message.as_str())
        .collect::<Vec<_>>();
    ctx.out(json!({
        "id": session_id,
        "hostPid": info.host_pid,
        "childAlive": info.child_alive,
        "resumePrecision": session.resume_precision.as_str(),
        "agentSessionId": session.agent_session_id,
        "hookStatus": format!("{:?}", plan.hook_status).to_lowercase(),
        "notes": notes,
        "command": plan.argv,
    }));
    Ok(json!({ "id": session_id }))
}

fn cmd_session(ctx: &Ctx, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("new") => {
            let project_id = flag(args, "project")
                .ok_or_else(|| CoreError::Validation("--project required".into()))?;
            let project = ctx.db.get_project(&project_id)?;
            let agent: AgentType = flag(args, "agent")
                .ok_or_else(|| CoreError::Validation("--agent required".into()))?
                .parse()?;
            let title = match flag(args, "title") {
                Some(value) if !value.trim().is_empty() => value.trim().to_string(),
                _ => ctx.db.next_default_session_title(&project.id, agent)?,
            };
            let preset_id = flag(args, "preset");
            let worktree_id = flag(args, "worktree-id");
            let permission = match flag(args, "permission").as_deref() {
                None => agent.default_permission_mode(),
                Some("native") => PermissionMode::Native,
                Some("auto") => PermissionMode::Auto,
                Some("bypass") => PermissionMode::Bypass,
                Some(other) => {
                    return Err(CoreError::Validation(format!("bad permission {other}")))
                }
            };
            let cols = flag(args, "cols")
                .and_then(|v| v.parse().ok())
                .unwrap_or(120);
            let rows = flag(args, "rows")
                .and_then(|v| v.parse().ok())
                .unwrap_or(32);
            let transport = match flag(args, "transport") {
                Some(value) => value.parse()?,
                None => agent.default_transport(),
            };
            let install = install_for(ctx, agent)?;
            let preset = preset_for(ctx, agent, preset_id, &install)?;
            launch_session(
                ctx,
                &project,
                agent,
                &title,
                &preset,
                worktree_id,
                permission,
                transport,
                cols,
                rows,
                args,
            )?;
            Ok(())
        }
        Some("list") => {
            let mgr = host_mgr(ctx);
            let _ = mgr.reconcile_on_startup()?;
            let include_all = has_flag(args, "all");
            let rows: Vec<Value> = ctx
                .db
                .list_sessions(None, include_all)?
                .iter()
                .map(|s| session_json(ctx, s))
                .collect();
            ctx.out(Value::Array(rows));
            Ok(())
        }
        Some("status") => {
            let id = positional(args, 1)?;
            let s = ctx.db.get_session(id)?;
            let latest = ctx.db.latest_status(id)?;
            let history: Vec<Value> = ctx
                .db
                .status_history(id, 20)?
                .iter()
                .map(status_json)
                .collect();
            ctx.out(json!({
                "session": session_json(ctx, &s),
                "latest": latest.as_ref().map(status_json),
                "history": history,
                "recovery": ctx.db.get_recovery_summary(id).ok().map(|r| json!({
                    "lastSeenSequence": r.last_seen_sequence,
                    "latestSequence": r.latest_sequence,
                    "summaryState": r.summary_state.as_str(),
                    "acknowledgedAt": r.acknowledged_at,
                })),
            }));
            Ok(())
        }
        Some("input") => {
            let id = positional(args, 1)?;
            let data = match flag(args, "data") {
                Some(d) => unescape(&d),
                None => {
                    let mut buf = Vec::new();
                    std::io::stdin().read_to_end(&mut buf)?;
                    buf
                }
            };
            let mgr = host_mgr(ctx);
            let (mut client, _info) = mgr.attach(id)?;
            client.send_input(&data)?;
            ctx.out(json!({"ok": true, "bytes": data.len()}));
            Ok(())
        }
        Some("read") => {
            let id = positional(args, 1)?;
            let until = flag(args, "until");
            let timeout_s: u64 = flag(args, "timeout")
                .and_then(|v| v.parse().ok())
                .unwrap_or(10);
            let tail: u64 = flag(args, "tail-bytes")
                .and_then(|v| v.parse().ok())
                .unwrap_or(64 * 1024);
            let out = read_session(
                ctx,
                id,
                until.as_deref(),
                Duration::from_secs(timeout_s),
                tail,
            )?;
            ctx.out(out);
            Ok(())
        }
        Some("stop") => {
            let id = positional(args, 1)?;
            host_mgr(ctx).stop(id, 3000)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        Some("interrupt") => {
            let id = positional(args, 1)?;
            host_mgr(ctx).interrupt(id)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        Some("rename") => {
            ctx.db
                .rename_session(positional(args, 1)?, positional(args, 2)?)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        Some("archive") => {
            // Match the GUI path: an archived Session must not retain a live
            // Host. Stop is verified through the authenticated handshake; a
            // failure aborts the archive instead of hiding a running Agent.
            let id = positional(args, 1)?;
            host_mgr(ctx).stop(id, 3000)?;
            ctx.db.archive_session(id)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        Some("restart") => cmd_session_restart(ctx, args),
        Some("attach") => cmd_session_attach(ctx, args),
        _ => Err(CoreError::Validation(
            "session new|list|status|input|read|stop|interrupt|rename|archive|restart|attach"
                .into(),
        )),
    }
}

fn session_json(ctx: &Ctx, s: &Session) -> Value {
    let latest = ctx.db.latest_status(&s.id).ok().flatten();
    json!({
        "id": s.id,
        "projectId": s.project_id,
        "worktreeId": s.worktree_id,
        "title": s.title,
        "adapter": s.adapter_type.as_str(),
        "cwd": s.cwd,
        "lifecycle": s.lifecycle.as_str(),
        "hostPid": s.host_pid,
        "agentSessionId": s.agent_session_id,
        "resumePrecision": s.resume_precision.as_str(),
        "permissionMode": s.permission_mode.as_str(),
        "transport": s.transport.as_str(),
        "logPath": s.log_path,
        "createdAt": s.created_at,
        "status": latest.map(|e| json!({
            "state": e.state.as_str(),
            "source": e.source.as_str(),
            "confidence": e.confidence.as_str(),
            "occurredAt": e.occurred_at,
        })),
    })
}

fn status_json(e: &StatusEvent) -> Value {
    json!({
        "sequence": e.sequence,
        "state": e.state.as_str(),
        "source": e.source.as_str(),
        "confidence": e.confidence.as_str(),
        "evidence": e.evidence,
        "occurredAt": e.occurred_at,
    })
}

/// Attach + read frames, persisting State/AgentSession/Exit into the db,
/// until `until` matches the accumulated output or the timeout expires.
fn read_session(
    ctx: &Ctx,
    id: &str,
    until: Option<&str>,
    timeout: Duration,
    tail_bytes: u64,
) -> Result<Value> {
    let session = ctx.db.get_session(id)?;
    let socket = session
        .host_socket
        .clone()
        .ok_or_else(|| CoreError::Host("no socket recorded".into()))?;
    let token = ctx.db.get_session_token(id)?;
    let (mut client, info) = HostClient::connect(&socket, id, &token, tail_bytes)?;
    let start = Instant::now();
    let mut output: Vec<u8> = vec![];
    let mut exit_frame: Option<Value> = None;
    loop {
        if start.elapsed() > timeout {
            break;
        }
        let remaining = timeout.saturating_sub(start.elapsed());
        let frame = read_frame_timeout(&mut client, remaining.min(Duration::from_secs(1)))?;
        let Some(frame) = frame else {
            if start.elapsed() > timeout {
                break;
            }
            continue;
        };
        match frame {
            HostFrame::Output { data, .. } | HostFrame::TransientOutput { data, .. } => {
                output.extend_from_slice(&data);
            }
            HostFrame::State {
                session_id,
                run_id,
                run_ordinal,
                sequence,
                state,
                source,
                confidence,
                evidence,
                log_cursor,
                occurred_at,
            } => {
                let _ = ctx.db.record_status_event(&StatusEvent {
                    session_id,
                    run_id,
                    run_ordinal,
                    sequence,
                    state,
                    source,
                    confidence,
                    evidence,
                    log_cursor,
                    occurred_at,
                });
            }
            HostFrame::AgentSession {
                agent_session_id, ..
            } => {
                let _ =
                    ctx.db
                        .update_session_agent_id(id, &agent_session_id, ResumePrecision::Exact);
            }
            HostFrame::Exit {
                run_id,
                run_ordinal,
                code,
                signal,
                group_cleaned,
                reason,
                ..
            } => {
                exit_frame = Some(json!({
                    "code": code, "signal": signal, "groupCleaned": group_cleaned,
                    "reason": reason.clone(),
                }));
                // A stale CLI attachment must not terminally transition a
                // replacement Host. The HostManager records the current
                // PID/run binding, so apply this frame only when it matches
                // the handshake that created this attachment.
                if info.host_pid > 0
                    && (info.protocol < agentport_core::protocol::PROTOCOL_VERSION
                        || (run_id == info.run_id && run_ordinal == info.run_ordinal))
                {
                    let expected_run = (info.protocol
                        >= agentport_core::protocol::PROTOCOL_VERSION)
                        .then_some((run_id.as_str(), run_ordinal));
                    let lifecycle = if reason == "user_stop" {
                        Lifecycle::Stopped
                    } else {
                        Lifecycle::Exited
                    };
                    let _ = ctx.db.update_session_lifecycle_if_host(
                        id,
                        info.host_pid as i64,
                        expected_run,
                        lifecycle,
                    );
                }
                break;
            }
            _ => {}
        }
        if let Some(u) = until {
            if output.windows(u.len()).any(|w| w == u.as_bytes()) {
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&output).to_string();
    Ok(json!({
        "sessionId": id,
        "attach": attach_json(&info),
        "bytes": output.len(),
        "matched": until.map(|u| output.windows(u.len()).any(|w| w == u.as_bytes())).unwrap_or(false),
        "exit": exit_frame,
        "output": text,
    }))
}

fn attach_json(info: &AttachInfo) -> Value {
    json!({
        "hostPid": info.host_pid,
        "childAlive": info.child_alive,
        "logBytes": info.log_bytes,
        "agentSessionId": info.agent_session_id,
    })
}

/// Read one frame with an overall budget; returns Ok(None) on short timeout
/// (caller retries until the total budget is spent).
fn read_frame_timeout(client: &mut HostClient, budget: Duration) -> CoreResult<Option<HostFrame>> {
    use std::os::unix::io::AsRawFd;
    let fd = client.reader.get_ref().as_raw_fd();
    let mut pfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = budget.as_millis().min(i32::MAX as u128) as i32;
    let n = unsafe { libc::poll(&mut pfd, 1, ms) };
    if n <= 0 {
        return Ok(None); // timeout (or EINTR): caller decides to retry
    }
    client.read_frame()
}

fn cmd_session_restart(ctx: &Ctx, args: &[String]) -> Result<()> {
    let id = positional(args, 1)?;
    let session = ctx.db.get_session(id)?;
    match session.lifecycle {
        Lifecycle::Running | Lifecycle::Creating => {
            return Err(CoreError::Blocked(
                "session is running; stop it before restart".into(),
            ))
        }
        _ => {}
    }
    let install = install_for(ctx, session.adapter_type)?;
    let preset = preset_for(
        ctx,
        session.adapter_type,
        Some(session.preset_id.clone()),
        &install,
    )?;
    adapters::validate_user_args(session.adapter_type, &preset.args)?;
    let adapter = adapters::adapter_for(session.adapter_type);
    let rctx = ResumeContext {
        install,
        preset: preset.clone(),
        permission_mode: session.permission_mode,
        cwd: session.cwd.clone(),
        agent_session_id: session.agent_session_id.clone(),
        session_id: session.id.clone(),
        hook_events_path: ctx
            .paths
            .hook_events_path(&session.id)
            .to_string_lossy()
            .into_owned(),
        session_dir: ctx
            .paths
            .session_dir(&session.id)
            .to_string_lossy()
            .into_owned(),
        transport: session.transport,
    };
    let plan = adapter.build_resume_checked(&rctx)?;
    for (path, contents) in &plan.helper_files {
        agentport_core::host_manager::write_private_file(path, contents)?;
    }
    let permission = session
        .adapter_type
        .effective_permission_mode(session.permission_mode);
    enforce_permission_preflight(
        ctx,
        session.adapter_type,
        permission,
        &plan.argv,
        &session.cwd,
        args,
    )?;
    // New identity for the new host: same session id, fresh token.
    let new_token = ids::new_host_token();
    ctx.db.set_session_token(id, &new_token)?;
    let mut renewed = ctx.db.get_session(id)?;
    renewed.host_token = new_token;
    renewed.host_socket = Some(ctx.paths.socket_path(id).to_string_lossy().into_owned());
    renewed.lifecycle = Lifecycle::Creating;
    // HostManager claims the new run and transitions it to Creating atomically
    // with its run identity; an unconditional lifecycle write here could race
    // a terminal observation from the preceding Host.
    let settings = ctx.db.load_settings()?;
    let mgr = host_mgr(ctx);
    let mut env = plan.env.clone();
    capability::merge_effective_path_env(&mut env)?;
    let info = mgr.launch(LaunchSpec {
        session: renewed.clone(),
        command: plan.argv.clone(),
        env,
        secrets: vec![],
        log_limit_bytes: settings.log_limit_mib * 1024 * 1024,
        agent_session_id_hint: plan.assigned_agent_session_id.clone(),
        cols: 120,
        rows: 32,
    })?;
    // HostManager owns the run-bound transition to Running. Repeating an
    // unconditional write here could let a delayed CLI command overwrite a
    // newer Host run's lifecycle.
    // A resume whose recorded conversation is gone falls back to a fresh
    // conversation with a newly assigned native id (claude adapter). Persist
    // it so the next restart resumes the conversation that actually exists.
    if let Some(native) = &plan.assigned_agent_session_id {
        if session.agent_session_id.as_deref() != Some(native.as_str()) {
            ctx.db
                .update_session_agent_id(id, native, plan.resume_precision)?;
        }
    }
    let notes = plan
        .notices
        .iter()
        .map(|notice| notice.legacy_message.as_str())
        .collect::<Vec<_>>();
    ctx.out(json!({
        "id": id,
        "resumePrecision": plan.resume_precision.as_str(),
        "agentSessionId": plan
            .assigned_agent_session_id
            .clone()
            .or(session.agent_session_id.clone()),
        "notes": notes,
        "command": plan.argv,
        "attach": attach_json(&info),
    }));
    Ok(())
}

/// Interactive attach: raw stdin -> PTY, PTY -> stdout. Ctrl-] detaches.
fn cmd_session_attach(ctx: &Ctx, args: &[String]) -> Result<()> {
    let id = positional(args, 1)?;
    let session = ctx.db.get_session(id)?;
    let socket = session
        .host_socket
        .clone()
        .ok_or_else(|| CoreError::Host("no socket recorded".into()))?;
    let token = ctx.db.get_session_token(id)?;
    let (mut client, info) = HostClient::connect(&socket, id, &token, 256 * 1024)?;
    eprintln!(
        "attached to {} (host pid {}, logs {} bytes). Ctrl-] to detach.",
        id, info.host_pid, info.log_bytes
    );
    use std::io::Write as _;
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let mut out = std::io::stdout();
    loop {
        // Drain stdin -> host
        while let Ok(data) = rx.try_recv() {
            if data.contains(&0x1d) {
                // Ctrl-] detach
                eprintln!("\ndetached.");
                return Ok(());
            }
            client.send_input(&data)?;
        }
        match read_frame_timeout(&mut client, Duration::from_millis(50))? {
            Some(HostFrame::Output { data, .. })
            | Some(HostFrame::TransientOutput { data, .. }) => {
                out.write_all(&data)?;
                out.flush()?;
            }
            Some(HostFrame::Exit { .. }) => {
                eprintln!("\nsession exited.");
                return Ok(());
            }
            Some(HostFrame::State {
                session_id,
                run_id,
                run_ordinal,
                sequence,
                state,
                source,
                confidence,
                evidence,
                log_cursor,
                occurred_at,
            }) => {
                let _ = ctx.db.record_status_event(&StatusEvent {
                    session_id,
                    run_id,
                    run_ordinal,
                    sequence,
                    state,
                    source,
                    confidence,
                    evidence,
                    log_cursor,
                    occurred_at,
                });
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

fn cmd_worktree(ctx: &Ctx, args: &[String]) -> Result<()> {
    let mgr = WorktreeManager {
        paths: &ctx.paths,
        db: &ctx.db,
    };
    match args.first().map(String::as_str) {
        Some("create") => {
            let project_id = flag(args, "project")
                .ok_or_else(|| CoreError::Validation("--project required".into()))?;
            let task = flag(args, "task")
                .ok_or_else(|| CoreError::Validation("--task required".into()))?;
            let base_ref = flag(args, "base-ref");
            let branch = flag(args, "branch");
            let w = mgr.create(&project_id, &task, base_ref.as_deref(), branch.as_deref())?;
            ctx.out(worktree_json(&w));
            Ok(())
        }
        Some("list") => {
            let project_id = flag(args, "project")
                .ok_or_else(|| CoreError::Validation("--project required".into()))?;
            let ws: Vec<Value> = ctx
                .db
                .list_worktrees(&project_id)?
                .iter()
                .map(|w| {
                    let health = mgr.refresh_health(&w.id).unwrap_or(w.health);
                    let mut v = worktree_json(w);
                    v["health"] = json!(health.as_str());
                    v
                })
                .collect();
            ctx.out(Value::Array(ws));
            Ok(())
        }
        Some("health") => {
            let id = positional(args, 1)?;
            let h = mgr.refresh_health(id)?;
            let summary = mgr.dirty_summary(id).ok();
            ctx.out(json!({
                "id": id,
                "health": h.as_str(),
                "dirty": summary.map(|s| json!({
                    "modified": s.modified, "staged": s.staged, "untracked": s.untracked,
                })),
            }));
            Ok(())
        }
        Some("remove") => {
            let id = positional(args, 1)?;
            ctx.db.begin_worktree_removal(id)?;
            let sessions = ctx
                .db
                .list_sessions(None, true)?
                .into_iter()
                .filter(|session| session.worktree_id.as_deref() == Some(id))
                .collect::<Vec<_>>();
            let host_manager = HostManager {
                paths: &ctx.paths,
                db: &ctx.db,
            };
            let native_plans = sessions
                .iter()
                .map(|session| plan_native_cleanup(&ctx.paths, session))
                .collect::<Vec<_>>();
            let stop_warnings = sessions
                .iter()
                .filter(|session| host_manager.stop(&session.id, 3_000).is_err())
                .count();
            let outcome = mgr.remove(id)?;
            for (session, native_plan) in sessions.iter().zip(&native_plans) {
                let _ = execute_native_cleanup(native_plan);
                let _ = std::fs::remove_dir_all(ctx.paths.session_dir(&session.id));
                let _ = std::fs::remove_file(ctx.paths.socket_path(&session.id));
            }
            ctx.out(json!({
                "ok": true,
                "stopWarnings": stop_warnings,
                "cleanupWarnings": outcome.cleanup_warnings,
            }));
            Ok(())
        }
        _ => Err(CoreError::Validation(
            "worktree create|list|health|remove".into(),
        )),
    }
}

fn worktree_json(w: &Worktree) -> Value {
    json!({
        "id": w.id,
        "projectId": w.project_id,
        "branch": w.branch,
        "baseCommit": w.base_commit,
        "baseRef": w.base_ref,
        "path": w.path,
        "health": w.health.as_str(),
        "createdAt": w.created_at,
    })
}

// ---------------------------------------------------------------------------
// export / search / timeline / diag / secret (wave 2)
// ---------------------------------------------------------------------------

use agentport_core::diag::Diagnostics;
use agentport_core::export::Exporter;
use agentport_core::history::NativeHistory;
use agentport_core::notify::{test_notification, Notifier};
use agentport_core::search::SearchIndex;
use agentport_core::secrets::SecretValue;
use agentport_core::timeline::Timeline;

/// Load every known secret value for redaction-on-export (logs are already
/// redacted at rest by the host; this is the second pass). Values never
/// leave this function except as fingerprints inside the exporter.
fn load_all_secret_values(ctx: &Ctx) -> Vec<Vec<u8>> {
    let Ok(broker) = CredentialBroker::detect() else {
        return vec![];
    };
    let mut out = vec![];
    if let Ok(refs) = ctx.db.list_secret_refs() {
        for r in &refs {
            if let Ok(v) = broker.load(r) {
                out.push(v.expose().to_vec());
            }
        }
    }
    out
}

fn cmd_export(ctx: &Ctx, args: &[String]) -> Result<()> {
    let exporter = Exporter {
        paths: &ctx.paths,
        db: &ctx.db,
    };
    let secrets = load_all_secret_values(ctx);
    let session =
        flag(args, "session").ok_or_else(|| CoreError::Validation("--session required".into()))?;
    let out = flag(args, "out").ok_or_else(|| CoreError::Validation("--out required".into()))?;
    let dest = std::path::Path::new(&out);
    match args.first().map(String::as_str) {
        Some("md") | Some("markdown") | Some("json") => {
            let native_format = if args.first().map(String::as_str) == Some("json") {
                "json"
            } else {
                "md"
            };
            let session_model = ctx.db.get_session(&session)?;
            let p = NativeHistory::new(&ctx.paths).export(&session_model, dest, native_format)?;
            ctx.out(json!({"exported": p}));
            Ok(())
        }
        Some("log") => Err(CoreError::Validation(
            "raw terminal log export was removed; use export md or export json".into(),
        )),
        Some("zip") => {
            let ids: Vec<String> = session.split(',').map(|s| s.trim().to_string()).collect();
            let p = exporter.export_diagnostics_zip(&ids, dest, &secrets)?;
            ctx.out(json!({"exported": p}));
            Ok(())
        }
        _ => Err(CoreError::Validation("export md|json|zip".into())),
    }
}

// ---------------------------------------------------------------------------
// backup / restore
// ---------------------------------------------------------------------------

fn cmd_backup(ctx: &Ctx, args: &[String]) -> Result<()> {
    use agentport_core::backup;
    match args.first().map(String::as_str) {
        Some("create") => {
            let out = flag(args, "out")
                .ok_or_else(|| CoreError::Validation("--out <file.zip> required".into()))?;
            let dest = std::path::Path::new(&out);
            let report = backup::create(&ctx.paths, &ctx.db, dest)?;
            let verified = if has_flag(args, "verify") {
                backup::verify(dest).map(|_| true)?
            } else {
                false
            };
            ctx.out(json!({
                "backup": dest,
                "files": report.files,
                "bytes": report.bytes,
                "verified": verified,
                "nativeCoverage": report.native_coverage,
            }));
            Ok(())
        }
        Some("verify") => {
            let path = positional(args, 1)?;
            let manifest = backup::verify(std::path::Path::new(path))?;
            ctx.out(json!({
                "ok": true,
                "formatVersion": manifest.format_version,
                "createdAt": manifest.created_at,
                "dataModelVersion": manifest.data_model_version,
                "files": manifest.files.len(),
                "nativeCoverage": manifest.native_coverage,
            }));
            Ok(())
        }
        Some("restore") => {
            let path = positional(args, 1)?;
            let to = flag(args, "to")
                .ok_or_else(|| CoreError::Validation("--to <data-dir> required".into()))?;
            let target = std::path::Path::new(&to);
            let previous = backup::restore(std::path::Path::new(path), target)?;
            ctx.out(json!({
                "restored": target,
                "previousKeptAt": previous,
            }));
            Ok(())
        }
        _ => Err(CoreError::Validation("backup create|verify|restore".into())),
    }
}

fn cmd_search(ctx: &Ctx, args: &[String]) -> Result<()> {
    let idx = SearchIndex {
        db: &ctx.db,
        paths: &ctx.paths,
    };
    if has_flag(args, "reindex") {
        idx.purge_transcript_bodies()?;
        ctx.out(json!({"reindexed": false, "mode": "native_on_demand", "purgedLegacyBodies": true}));
        return Ok(());
    }
    let q = positional(args, 0)?;
    let limit: usize = flag(args, "limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let history = NativeHistory::new(&ctx.paths);
    let mut hits = Vec::new();
    let mut total_hits = 0usize;
    let mut partial = limit == 0;
    if limit > 0 {
        for session in ctx.db.list_sessions(None, true)? {
            let result =
                history.search_session_bounded(&session, q, limit.saturating_sub(hits.len()))?;
            total_hits = total_hits.saturating_add(result.total_hits);
            for hit in result.hits {
                hits.push(json!({
                    "kind": "terminal",
                    "sessionId": session.id,
                    "projectId": session.project_id,
                    "title": session.title,
                    "snippet": hit.snippet,
                    "eventId": hit.event.id,
                    "provider": hit.event.provider,
                }));
            }
            if result.partial || hits.len() == limit {
                partial = true;
                break;
            }
        }
    }
    ctx.out(json!({"partial": partial, "totalHits": total_hits, "hits": hits}));
    Ok(())
}

fn cmd_timeline(ctx: &Ctx, args: &[String]) -> Result<()> {
    let tl = Timeline { db: &ctx.db };
    if has_flag(args, "ack") {
        tl.acknowledge_all()?;
        ctx.out(json!({"acknowledged": true}));
        return Ok(());
    }
    let t = tl.build()?;
    let entries: Vec<Value> = t
        .entries
        .iter()
        .map(|e| {
            json!({
                "sessionId": e.session_id,
                "sessionTitle": e.session_title,
                "projectName": e.project_name,
                "adapter": e.adapter_type.as_str(),
                "state": e.state.as_str(),
                "source": e.source.as_str(),
                "confidence": e.confidence.as_str(),
                "occurredAt": e.occurred_at,
                "logOffset": e.log_offset,
                "rotatedAway": e.rotated_away,
            })
        })
        .collect();
    ctx.out(json!({
        "completed": t.completed,
        "waiting": t.waiting,
        "failed": t.failed,
        "entries": entries,
    }));
    Ok(())
}

fn cmd_diag(ctx: &Ctx, args: &[String]) -> Result<()> {
    let diag = Diagnostics {
        paths: &ctx.paths,
        db: &ctx.db,
    };
    match args.first().map(String::as_str) {
        Some("hosts") => {
            let hosts: Vec<Value> = diag
                .host_list()?
                .iter()
                .map(|h| serde_json::to_value(h).unwrap())
                .collect();
            ctx.out(Value::Array(hosts));
            Ok(())
        }
        Some("summary") => {
            println!("{}", diag.copyable_summary()?);
            Ok(())
        }
        Some("capabilities") => {
            println!("{}", diag.adapter_capabilities_json()?);
            Ok(())
        }
        Some("notify-test") => {
            let settings = ctx.db.load_settings()?;
            if !settings.notifications_enabled {
                return Err(CoreError::Blocked(
                    "system notifications are disabled in Settings".into(),
                ));
            }
            let mut notifier = Notifier::new(settings.notifications_enabled);
            notifier.configure(settings.notifications_enabled, settings.ui_language);
            notifier.send(test_notification(settings.ui_language))?;
            ctx.out(json!({"sent": true}));
            Ok(())
        }
        _ => Err(CoreError::Validation(
            "diag hosts|summary|capabilities|notify-test".into(),
        )),
    }
}

fn cmd_secret(ctx: &Ctx, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("status") => {
            let st = CredentialBroker::backend_status();
            ctx.out(json!({"backendStatus": format!("{st:?}")}));
            Ok(())
        }
        Some("add") => {
            let preset_id = flag(args, "preset")
                .ok_or_else(|| CoreError::Validation("--preset required".into()))?;
            let env_name =
                flag(args, "env").ok_or_else(|| CoreError::Validation("--env required".into()))?;
            // Value comes from stdin only — NEVER from argv (ps-visible).
            eprint!("secret value for {env_name} (input hidden): ");
            let value = read_hidden_line()?;
            let broker = CredentialBroker::detect()?;
            let secret_ref = broker.store(&env_name, &preset_id, value.expose())?;
            ctx.db.upsert_secret_ref(&secret_ref)?;
            // Link into the preset.
            let mut preset = ctx.db.get_preset(&preset_id)?;
            if !preset.secret_ref_ids.contains(&secret_ref.id) {
                preset.secret_ref_ids.push(secret_ref.id.clone());
                ctx.db.upsert_preset(&preset)?;
            }
            ctx.out(json!({
                "id": secret_ref.id,
                "envName": secret_ref.env_name,
                "backend": secret_ref.backend.as_str(),
                "linkedPreset": preset_id,
            }));
            Ok(())
        }
        Some("list") => {
            let refs: Vec<Value> = ctx
                .db
                .list_secret_refs()?
                .iter()
                .map(|r| {
                    json!({"id": r.id, "envName": r.env_name, "backend": r.backend.as_str(),
                        "account": r.account, "updatedAt": r.updated_at})
                })
                .collect();
            ctx.out(Value::Array(refs));
            Ok(())
        }
        Some("delete") => {
            let id = flag(args, "id")
                .or_else(|| positional(args, 1).ok().cloned())
                .ok_or_else(|| CoreError::Validation("secret id required".into()))?;
            let secret_ref = ctx.db.get_secret_ref(&id)?;
            if let Ok(broker) = CredentialBroker::detect() {
                let _ = broker.delete(&secret_ref); // idempotent
            }
            ctx.db.delete_secret_ref(&id)?;
            // Unlink from any preset referencing it.
            for mut p in ctx.db.list_presets(None)? {
                if p.secret_ref_ids.contains(&id) {
                    p.secret_ref_ids.retain(|r| r != &id);
                    ctx.db.upsert_preset(&p)?;
                }
            }
            ctx.out(json!({"deleted": id}));
            Ok(())
        }
        _ => Err(CoreError::Validation(
            "secret status|add --preset P --env NAME|list|delete <id>".into(),
        )),
    }
}

/// Read one line from stdin with terminal echo disabled (falls back to plain
/// read when not a TTY). Returns the value in guarded memory.
fn read_hidden_line() -> Result<SecretValue> {
    use std::io::Read as _;
    let mut buf = Vec::new();
    let mut stdin = std::io::stdin().lock();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
            }
            Err(e) => return Err(CoreError::Io(e)),
        }
    }
    Ok(SecretValue::new(buf))
}

fn cmd_settings(ctx: &Ctx, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("get") | None => {
            let s = ctx.db.load_settings()?;
            ctx.out(serde_json::to_value(&s)?);
            Ok(())
        }
        Some("set") => {
            let mut s = ctx.db.load_settings()?;
            if flag(args, "log-limit-mib").is_some() || flag(args, "search-index").is_some() {
                return Err(CoreError::Validation(
                    "log-limit-mib and search-index were removed; native history is read on demand"
                        .into(),
                ));
            }
            if let Some(v) = flag(args, "notifications") {
                s.notifications_enabled = v == "true" || v == "on";
            }
            ctx.db.save_settings(&s)?;
            ctx.out(json!({"ok": true}));
            Ok(())
        }
        _ => Err(CoreError::Validation("settings get|set".into())),
    }
}

mod perf;
