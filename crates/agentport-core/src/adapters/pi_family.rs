//! Independent adapters for Oh My Pi and easy-pi, not aliases of Pi.
//!
//! Evidence: omp 18.0.11 `--help` and upstream session-manager.ts / session-entries.ts;
//! easy-pi 0.84.2 `--help`, core/product-identity.ts and main.ts. OMP has no
//! --session-id: its documented JSONL v3 header can be opened with --resume <path>.
//! easy-pi's --session-id creates when missing, so a cold resume instead uses
//! --session <verified existing path>. Neither adapter searches another product's
//! global sessions or invokes a "most recent" fallback.

use super::{AgentAdapter, LaunchContext, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub struct PiFamilyAdapter(pub AgentType);

/// The installed easy-pi fork still publishes a `pi` bin and the upstream npm
/// package name/version. Help branding plus its product-specific environment
/// contract, rather than the filename or semver, separates the two products.
pub fn is_easy_pi_help(help: &str) -> bool {
    help.lines()
        .next()
        .map(|line| line.trim().starts_with("easy-pi -"))
        .unwrap_or(false)
        && help.contains("EASY_PI_CODING_AGENT_DIR")
}

pub fn session_directory(session_dir: &Path, agent: AgentType) -> PathBuf {
    session_dir.join(agent.as_str())
}

pub fn protected_args(agent: AgentType) -> &'static [&'static str] {
    match agent {
        AgentType::Omp => &[
            "--mode",
            "--print",
            "-p",
            "--continue",
            "-c",
            "--resume",
            "-r",
            "--session",
            // Reserve identity ownership even if a later OMP version adds it.
            "--session-id",
            "--session-dir",
            "--no-session",
            "--fork",
            "--from-claude",
            "--from-codex",
            "--cwd",
            "--profile",
            "--alias",
            "--config",
            "--export",
            "--api-key",
            "--approval-mode",
            "--auto-approve",
            "--yolo",
            "--plan-yolo",
            "--plan-yolo-into",
            "--hook",
            "--extension",
            "-e",
            "--no-extensions",
            "--plugin-dir",
        ],
        AgentType::EasyPi => &[
            "--mode",
            "--json-profile",
            "--tui-mode",
            "--tui-engine",
            "--print",
            "-p",
            "--continue",
            "-c",
            "--resume",
            "-r",
            "--session",
            "--session-id",
            "--session-dir",
            "--no-session",
            "--fork",
            "--export",
            "--api-key",
            "--approve",
            "-a",
            "--no-approve",
            "-na",
            "--extension",
            "-e",
            "--no-extensions",
            "-ne",
            "--skill",
            "--no-skills",
            "-ns",
            "--prompt-template",
            "--no-prompt-templates",
            "-np",
            "--theme",
            "--no-themes",
        ],
        _ => &[],
    }
}

pub fn permission_args(
    agent: AgentType,
    mode: PermissionMode,
    install: &AdapterInstall,
) -> Result<Vec<String>> {
    if mode == PermissionMode::Native {
        return Ok(vec![]);
    }
    if agent != AgentType::Omp {
        return Err(CoreError::Validation(format!(
            "{} has no verified CLI permission-mode override; use its native permission controls",
            agent.display_name()
        )));
    }
    require_flag(install, "approval-mode")?;
    Ok(vec![
        "--approval-mode".into(),
        match mode {
            PermissionMode::Auto => "write",
            PermissionMode::Bypass => "yolo",
            PermissionMode::Native => unreachable!(),
        }
        .into(),
    ])
}

fn require_flag(install: &AdapterInstall, flag: &str) -> Result<()> {
    if super::has_flag(install, flag) {
        Ok(())
    } else {
        Err(CoreError::Blocked(format!(
            "this version of {} has no --{flag} flag; the requested managed Session capability is unavailable",
            install.agent_type.display_name()
        )))
    }
}

fn validate_identity(agent: AgentType, version: &str, help: &str) -> Result<()> {
    let matches = match agent {
        AgentType::EasyPi => is_easy_pi_help(help),
        AgentType::Omp => {
            version.trim().starts_with("omp/")
                && help
                    .lines()
                    .next()
                    .is_some_and(|line| line.starts_with("omp v"))
        }
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(CoreError::Adapter(format!(
            "executable does not identify itself as {}; select the correct CLI installation",
            agent.display_name()
        )))
    }
}

fn validate_context(agent: AgentType, ctx: &LaunchContext) -> Result<()> {
    if !matches!(agent, AgentType::Omp | AgentType::EasyPi)
        || ctx.install.agent_type != agent
        || ctx.preset.agent_type != agent
    {
        return Err(CoreError::Validation(
            "Pi-family adapter identity mismatch".into(),
        ));
    }
    if ctx.transport != AgentTransport::Pty {
        return Err(CoreError::Blocked(format!(
            "{} currently supports managed PTY transport only; its RPC protocol has not been integrated",
            agent.display_name()
        )));
    }
    super::validate_user_args(agent, &ctx.preset.args)?;
    require_flag(&ctx.install, "session-dir")?;
    Ok(())
}

fn product_env(agent: AgentType) -> Result<Vec<(String, String)>> {
    let home = dirs::home_dir()
        .ok_or_else(|| CoreError::Blocked("home directory is unavailable".into()))?;
    let (key, directory) = match agent {
        AgentType::EasyPi => ("EASY_PI_CODING_AGENT_DIR", ".epi"),
        AgentType::Omp => ("PI_CODING_AGENT_DIR", ".omp"),
        _ => return Err(CoreError::Validation("not a Pi-family adapter".into())),
    };
    let mut env = vec![(
        key.into(),
        home.join(directory)
            .join("agent")
            .to_string_lossy()
            .into_owned(),
    )];
    if agent == AgentType::Omp {
        // Named profiles can replace PI_CODING_AGENT_DIR; selecting the default
        // avoids importing an inherited Pi/OMP profile from the launching shell.
        env.push(("OMP_PROFILE".into(), String::new()));
    }
    Ok(env)
}

fn native_id(id: Option<&str>) -> Result<&str> {
    let id = id.ok_or_else(|| {
        CoreError::Blocked("native Session ID is missing; exact resume is unavailable".into())
    })?;
    // Native IDs assigned by these adapters are UUIDs. Reject path traversal,
    // prefix lookup and foreign identifiers before composing native argv.
    uuid::Uuid::parse_str(id)
        .map_err(|_| CoreError::Blocked("native Session ID is not a full UUID".into()))?;
    Ok(id)
}

fn native_permission_notices(agent: AgentType, mode: PermissionMode) -> Vec<super::LaunchNotice> {
    if mode != PermissionMode::Native {
        return vec![];
    }
    match agent {
        AgentType::Omp => vec![super::LaunchNotice::new(
            "omp_native_permission_defaults",
            "Oh My Pi preserves its native permission settings. Its upstream default is yolo (automatic tool approval); configure approvals in Oh My Pi if needed.",
        )],
        AgentType::EasyPi => vec![super::LaunchNotice::new(
            "easy_pi_native_permission_defaults",
            "easy-pi preserves its native permission settings. Its upstream initial mode is full-access; use /permissions inside easy-pi to change it.",
        )],
        _ => vec![],
    }
}

fn base_plan(agent: AgentType, argv: Vec<String>, id: String) -> Result<LaunchPlan> {
    Ok(LaunchPlan {
        argv,
        env: product_env(agent)?,
        assigned_agent_session_id: Some(id),
        resume_precision: ResumePrecision::Exact,
        hook_status: HookStatus::Unavailable,
        transport: AgentTransport::Pty,
        helper_files: vec![],
        notices: vec![],
    })
}

/// Resolve only a regular, bounded-header transcript inside this Session's
/// private product directory. Validate the *header*, not just a UUID filename.
/// Both CLIs create fresh files for missing paths, making this cold-resume gate
/// essential. A duplicate matching ID is a conflict, never "take the latest".
pub fn find_session_file(directory: &Path, id: &str, cwd: &str) -> Result<PathBuf> {
    native_id(Some(id))?;
    let metadata = fs::symlink_metadata(directory).map_err(|_| {
        CoreError::Blocked("native Session storage is missing; exact resume is unavailable".into())
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CoreError::Blocked("unsafe native Session directory".into()));
    }
    let root = directory.canonicalize()?;
    let mut found = None;
    for (index, entry) in fs::read_dir(directory)?.enumerate() {
        if index >= 10_000 {
            return Err(CoreError::Blocked(
                "native Session directory exceeds lookup limit".into(),
            ));
        }
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        if path.canonicalize()?.parent() != Some(root.as_path()) {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        let mut header = String::new();
        BufReader::new(file.take(16 * 1024 + 1)).read_line(&mut header)?;
        if header.len() > 16 * 1024 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&header) else {
            continue;
        };
        if value["type"] != "session" || value["id"].as_str() != Some(id) {
            continue;
        }
        if value["cwd"].as_str() != Some(cwd) || !matches!(value["version"].as_u64(), Some(1..=3)) {
            return Err(CoreError::Blocked(
                "native Session header has a different project or unsupported format".into(),
            ));
        }
        if found.replace(path).is_some() {
            return Err(CoreError::Conflict(
                "multiple native transcripts have the same Session ID".into(),
            ));
        }
    }
    found.ok_or_else(|| CoreError::Blocked("native transcript is missing; refusing to create a new conversation during exact resume".into()))
}

impl AgentAdapter for PiFamilyAdapter {
    fn agent_type(&self) -> AgentType {
        self.0
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        validate_identity(self.0, version_out, help_out)?;
        let flags = super::extract_flags(help_out);
        let has = |name: &str| flags.iter().any(|flag| flag == name);
        let exact_resume = has("session-dir")
            && match self.0 {
                AgentType::Omp => has("resume"),
                AgentType::EasyPi => has("session") && has("session-id"),
                _ => false,
            };
        Ok(AdapterInstall {
            agent_type: self.0,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume,
            hook_status: HookStatus::Unavailable,
            approval_model: ApprovalModel::NativePrompts,
            default_transport: AgentTransport::Pty,
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags,
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        validate_context(self.0, ctx)?;
        let directory = session_directory(Path::new(&ctx.session_dir), self.0);
        let id = crate::ids::new_uuid();
        let mut argv = vec![
            ctx.install.executable_path.clone(),
            "--session-dir".into(),
            directory.to_string_lossy().into_owned(),
        ];
        let mut helper_files = vec![];
        match self.0 {
            AgentType::Omp => {
                require_flag(&ctx.install, "resume")?;
                let path = directory.join(format!("{id}.jsonl"));
                // OMP's CURRENT_SESSION_VERSION = 3 and SessionManager.open
                // adopts this documented header even before the first turn.
                let header = serde_json::json!({
                    "type": "session", "version": 3, "id": id,
                    "timestamp": chrono::Utc::now().to_rfc3339(), "cwd": ctx.cwd,
                });
                helper_files.push((path.to_string_lossy().into_owned(), format!("{header}\n")));
                argv.extend(["--resume".into(), path.to_string_lossy().into_owned()]);
            }
            AgentType::EasyPi => {
                require_flag(&ctx.install, "session-id")?;
                require_flag(&ctx.install, "session")?;
                require_flag(&ctx.install, "tui-mode")?;
                argv.extend([
                    "--session-id".into(),
                    id.clone(),
                    "--tui-mode".into(),
                    "fullscreen".into(),
                ]);
            }
            _ => unreachable!(),
        }
        argv.extend(permission_args(
            self.0,
            ctx.preset.permission_mode,
            &ctx.install,
        )?);
        argv.extend(ctx.preset.args.clone());
        let mut plan = base_plan(self.0, argv, id)?;
        plan.helper_files = helper_files;
        plan.notices = native_permission_notices(self.0, ctx.preset.permission_mode);
        Ok(plan)
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let launch = ctx.to_launch_context();
        validate_context(self.0, &launch)?;
        let id = native_id(ctx.agent_session_id.as_deref())?;
        let directory = session_directory(Path::new(&ctx.session_dir), self.0);
        let mut argv = vec![
            ctx.install.executable_path.clone(),
            "--session-dir".into(),
            directory.to_string_lossy().into_owned(),
        ];
        match self.0 {
            AgentType::Omp => {
                require_flag(&ctx.install, "resume")?;
                argv.extend([
                    "--resume".into(),
                    directory
                        .join(format!("{id}.jsonl"))
                        .to_string_lossy()
                        .into_owned(),
                ]);
            }
            AgentType::EasyPi => {
                require_flag(&ctx.install, "session")?;
                require_flag(&ctx.install, "tui-mode")?;
                argv.extend([
                    "--session".into(),
                    id.into(),
                    "--tui-mode".into(),
                    "fullscreen".into(),
                ]);
            }
            _ => unreachable!(),
        }
        argv.extend(permission_args(self.0, ctx.permission_mode, &ctx.install)?);
        argv.extend(ctx.preset.args.clone());
        let mut plan = base_plan(self.0, argv, id.into())?;
        plan.notices = native_permission_notices(self.0, ctx.permission_mode);
        Ok(plan)
    }

    fn build_resume_checked(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let mut plan = self.build_resume(ctx)?;
        let directory = session_directory(Path::new(&ctx.session_dir), self.0);
        let id = native_id(ctx.agent_session_id.as_deref())?;
        let path = find_session_file(&directory, id, &ctx.cwd)?;
        let flag = if self.0 == AgentType::Omp {
            "--resume"
        } else {
            "--session"
        };
        let index = plan
            .argv
            .iter()
            .position(|value| value == flag)
            .expect("managed resume flag");
        plan.argv[index + 1] = path.to_string_lossy().into_owned();
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    const ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const OMP_FLAGS: &[&str] = &["session-dir", "resume", "approval-mode"];
    const EASY_FLAGS: &[&str] = &["session-dir", "session-id", "session", "tui-mode"];

    fn fixture(agent: AgentType) -> AdapterInstall {
        let prefix = if agent == AgentType::Omp {
            "omp-18.0.11"
        } else {
            "easy-pi-0.84.2"
        };
        PiFamilyAdapter(agent)
            .parse_capabilities(
                Path::new("/fake/bin/cli"),
                &fx::read_fixture(&format!("{prefix}-version.txt")),
                &fx::read_fixture(&format!("{prefix}-help.txt")),
            )
            .unwrap()
    }

    fn header(cwd: &str, id: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"session", "version":3, "id":id, "cwd":cwd})
        )
    }

    #[test]
    fn real_help_identifies_forks_independently_of_bin_name() {
        for agent in [AgentType::Omp, AgentType::EasyPi] {
            let install = fixture(agent);
            assert_eq!(install.agent_type, agent);
            assert!(install.exact_resume);
            assert_eq!(install.approval_model, ApprovalModel::NativePrompts);
        }
        assert!(!fixture(AgentType::Omp).flags.contains(&"session-id".into()));
        let easy_help = fx::read_fixture("easy-pi-0.84.2-help.txt");
        assert!(is_easy_pi_help(&easy_help));
        assert!(PiFamilyAdapter(AgentType::EasyPi)
            .parse_capabilities(
                Path::new("/bin/pi"),
                "0.84.2",
                "pi - AI coding assistant\n--session-id --session-dir"
            )
            .is_err());
        assert!(PiFamilyAdapter(AgentType::Omp)
            .parse_capabilities(Path::new("/bin/omp"), "0.84.2", &easy_help)
            .is_err());
    }

    #[test]
    fn omp_creates_documented_header_and_resumes_its_exact_path() {
        let ctx = fx::launch_ctx(AgentType::Omp, OMP_FLAGS, PermissionMode::Native);
        let plan = PiFamilyAdapter(AgentType::Omp).build_launch(&ctx).unwrap();
        let id = plan.assigned_agent_session_id.as_deref().unwrap();
        assert!(!plan
            .argv
            .iter()
            .any(|arg| arg == "--session-id" || arg == "--approval-mode"));
        assert_eq!(plan.helper_files.len(), 1);
        assert!(plan.helper_files[0]
            .0
            .ends_with(&format!("/omp/{id}.jsonl")));
        assert!(plan.argv.contains(&plan.helper_files[0].0));
        let header: serde_json::Value = serde_json::from_str(&plan.helper_files[0].1).unwrap();
        assert_eq!(header["id"], id);
        assert_eq!(header["cwd"], ctx.cwd);
        assert_eq!(header["version"], 3);
        assert!(plan
            .env
            .iter()
            .any(|(key, value)| key == "PI_CODING_AGENT_DIR" && value.ends_with("/.omp/agent")));
    }

    #[test]
    fn easy_pi_launch_uses_its_own_directory_and_preserves_native_permissions() {
        let ctx = fx::launch_ctx(AgentType::EasyPi, EASY_FLAGS, PermissionMode::Native);
        let plan = PiFamilyAdapter(AgentType::EasyPi)
            .build_launch(&ctx)
            .unwrap();
        assert!(plan
            .argv
            .windows(2)
            .any(|pair| pair == ["--session-dir", "/tmp/work/.agentport/easy_pi"]));
        assert!(plan
            .argv
            .windows(2)
            .any(|pair| pair == ["--tui-mode", "fullscreen"]));
        assert!(!plan
            .argv
            .iter()
            .any(|arg| arg == "--approve" || arg == "--no-extensions"));
        assert!(plan.helper_files.is_empty());
        assert!(plan.env.iter().any(
            |(key, value)| key == "EASY_PI_CODING_AGENT_DIR" && value.ends_with("/.epi/agent")
        ));
        assert!(!plan.env.iter().any(|(key, _)| key == "PI_CODING_AGENT_DIR"));
        assert_ne!(
            session_directory(Path::new("/tmp/session"), AgentType::EasyPi),
            session_directory(Path::new("/tmp/session"), AgentType::Pi)
        );
    }

    #[test]
    fn forks_block_unverified_modes_and_missing_managed_flags() {
        for (agent, flags) in [(AgentType::Omp, OMP_FLAGS), (AgentType::EasyPi, EASY_FLAGS)] {
            let mut ctx = fx::launch_ctx(agent, flags, PermissionMode::Native);
            ctx.transport = AgentTransport::JsonRpc;
            assert!(PiFamilyAdapter(agent).build_launch(&ctx).is_err());
            ctx.transport = AgentTransport::Pty;
            ctx.install.flags.retain(|flag| flag != "session-dir");
            assert!(PiFamilyAdapter(agent).build_launch(&ctx).is_err());
            let mut resume = fx::resume_ctx(agent, flags, Some(ID));
            resume.install.flags.retain(|flag| flag != "session-dir");
            assert!(PiFamilyAdapter(agent).build_resume(&resume).is_err());
            assert!(PiFamilyAdapter(agent)
                .build_resume(&fx::resume_ctx(agent, flags, None))
                .is_err());
            assert!(PiFamilyAdapter(agent)
                .build_resume(&fx::resume_ctx(agent, flags, Some("../../other")))
                .is_err());
        }
    }

    #[test]
    fn every_launch_requirement_is_probed_instead_of_inherited_from_pi() {
        for (agent, flags, required) in [
            (AgentType::Omp, OMP_FLAGS, &["session-dir", "resume"][..]),
            (
                AgentType::EasyPi,
                EASY_FLAGS,
                &["session-dir", "session-id", "session", "tui-mode"][..],
            ),
        ] {
            for missing in required {
                let mut ctx = fx::launch_ctx(agent, flags, PermissionMode::Native);
                ctx.install.flags.retain(|flag| flag.as_str() != *missing);
                let error = PiFamilyAdapter(agent).build_launch(&ctx).unwrap_err();
                assert!(error.to_string().contains(&format!("--{missing}")));
            }
        }
        let easy = PiFamilyAdapter(AgentType::EasyPi).parse_capabilities(
            Path::new("/fake/pi"), "0.84.2",
            "easy-pi - AI coding assistant\nEASY_PI_CODING_AGENT_DIR\n--session-dir --session-id --tui-mode",
        ).unwrap();
        assert!(!easy.exact_resume);
        let omp = PiFamilyAdapter(AgentType::Omp)
            .parse_capabilities(
                Path::new("/fake/omp"),
                "omp/18.0.11",
                "omp v18.0.11\n--session-dir",
            )
            .unwrap();
        assert!(!omp.exact_resume);
    }

    #[test]
    fn native_permission_notices_warn_without_claiming_the_users_actual_setting() {
        for (agent, flags, code) in [
            (AgentType::Omp, OMP_FLAGS, "omp_native_permission_defaults"),
            (
                AgentType::EasyPi,
                EASY_FLAGS,
                "easy_pi_native_permission_defaults",
            ),
        ] {
            let launch = PiFamilyAdapter(agent)
                .build_launch(&fx::launch_ctx(agent, flags, PermissionMode::Native))
                .unwrap();
            assert!(launch.notices.iter().any(|notice| notice.code == code));
            let resume = PiFamilyAdapter(agent)
                .build_resume(&fx::resume_ctx(agent, flags, Some(ID)))
                .unwrap();
            assert!(resume.notices.iter().any(|notice| notice.code == code));
        }
        let auto = PiFamilyAdapter(AgentType::Omp)
            .build_launch(&fx::launch_ctx(
                AgentType::Omp,
                OMP_FLAGS,
                PermissionMode::Auto,
            ))
            .unwrap();
        assert!(auto.notices.is_empty());
    }

    #[test]
    fn permission_modes_require_verified_native_flags() {
        let omp = fixture(AgentType::Omp);
        assert_eq!(
            permission_args(AgentType::Omp, PermissionMode::Native, &omp).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            permission_args(AgentType::Omp, PermissionMode::Auto, &omp).unwrap(),
            ["--approval-mode", "write"]
        );
        assert_eq!(
            permission_args(AgentType::Omp, PermissionMode::Bypass, &omp).unwrap(),
            ["--approval-mode", "yolo"]
        );
        let missing = fx::install(AgentType::Omp, &[]);
        assert!(permission_args(AgentType::Omp, PermissionMode::Auto, &missing).is_err());
        for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
            assert!(permission_args(AgentType::EasyPi, mode, &fixture(AgentType::EasyPi)).is_err());
        }
    }

    #[test]
    fn managed_arguments_and_aliases_cannot_escape_session_ownership() {
        for agent in [AgentType::Omp, AgentType::EasyPi] {
            for arg in protected_args(agent) {
                assert!(
                    super::super::validate_user_args(agent, &[format!("{arg}=other")]).is_err(),
                    "{agent:?}: {arg}"
                );
            }
            assert!(super::super::validate_user_args(
                agent,
                &["--model".into(), "custom-model".into()]
            )
            .is_ok());
        }
    }

    #[test]
    fn checked_resume_requires_an_existing_same_project_transcript() {
        for (agent, flags) in [(AgentType::Omp, OMP_FLAGS), (AgentType::EasyPi, EASY_FLAGS)] {
            let temp = tempfile::tempdir().unwrap();
            let directory = session_directory(temp.path(), agent);
            fs::create_dir(&directory).unwrap();
            let mut ctx = fx::resume_ctx(agent, flags, Some(ID));
            ctx.session_dir = temp.path().to_string_lossy().into_owned();
            assert!(PiFamilyAdapter(agent).build_resume_checked(&ctx).is_err());
            let transcript = directory.join(format!("timestamp_{ID}.jsonl"));
            fs::write(&transcript, header(&ctx.cwd, ID)).unwrap();
            let plan = PiFamilyAdapter(agent).build_resume_checked(&ctx).unwrap();
            assert!(plan
                .argv
                .contains(&transcript.to_string_lossy().into_owned()));
            assert!(!plan.argv.contains(&"--session-id".into()));
            assert!(plan.helper_files.is_empty());
            assert_eq!(plan.assigned_agent_session_id.as_deref(), Some(ID));
            fs::write(&transcript, header("/different-project", ID)).unwrap();
            assert!(PiFamilyAdapter(agent).build_resume_checked(&ctx).is_err());
            fs::write(&transcript, header(&ctx.cwd, "different-id")).unwrap();
            assert!(PiFamilyAdapter(agent).build_resume_checked(&ctx).is_err());
        }
    }

    #[test]
    fn transcript_lookup_rejects_ambiguous_headers_and_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("easy_pi");
        fs::create_dir(&directory).unwrap();
        let first = directory.join("a.jsonl");
        let second = directory.join("b.jsonl");
        fs::write(&first, header("/tmp/work", ID)).unwrap();
        fs::write(&second, header("/tmp/work", ID)).unwrap();
        assert!(find_session_file(&directory, ID, "/tmp/work").is_err());
        fs::remove_file(&second).unwrap();
        fs::remove_file(&first).unwrap();
        let foreign = temp.path().join("foreign.jsonl");
        fs::write(&foreign, header("/tmp/work", ID)).unwrap();
        std::os::unix::fs::symlink(&foreign, &first).unwrap();
        assert!(find_session_file(&directory, ID, "/tmp/work").is_err());
        fs::remove_file(&first).unwrap();
        fs::write(&first, "x".repeat(16 * 1024 + 1)).unwrap();
        assert!(find_session_file(&directory, ID, "/tmp/work").is_err());
    }
}
