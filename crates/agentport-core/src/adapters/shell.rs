//! Generic Shell adapter (PRD 1.4: other commands run via this降级入口).
//! Runs the user's shell (or a preset-specified command) under a PTY with the
//! same isolation/logging guarantees. No native session id — resume is
//! unavailable; hooks unavailable; status comes from PTY heuristics + process
//! facts. Auto-approve flags do not exist here — permission mode is always
//! treated as native.

use super::{AgentAdapter, LaunchContext, LaunchPlan, ResumeContext};
use crate::error::Result;
use crate::models::*;
use std::path::Path;

pub struct ShellAdapter;

impl AgentAdapter for ShellAdapter {
    fn agent_type(&self) -> AgentType {
        AgentType::Shell
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        Ok(AdapterInstall {
            agent_type: AgentType::Shell,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume: false,
            hook_status: HookStatus::Unavailable,
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags: super::extract_flags(help_out),
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        // A generic session should consistently load the user's zsh setup
        // (oh-my-zsh, zoxide, fzf, etc.), independent of the GUI process'
        // inherited $SHELL. Explicit preset executables still take priority;
        // an explicit zsh remains a managed zsh session.
        let exe = if !ctx.preset.executable_path.is_empty() {
            ctx.preset.executable_path.clone()
        } else if Path::new("/bin/zsh").is_file() {
            "/bin/zsh".into()
        } else {
            "/bin/sh".into()
        };
        // `preset_for` resolves the built-in Shell preset to /bin/zsh. Treat
        // that exactly like the implicit default, otherwise GUI-created Shell
        // sessions silently skip the AgentPort profile and its PATH fixes.
        let managed_zsh = is_zsh(&exe) && !disables_rc_files(&ctx.preset.args);
        let default_args = if managed_zsh && !has_login_flag(&ctx.preset.args) {
            vec!["-l".into()]
        } else {
            vec![]
        };
        // Shell is a raw terminal, not an agent approval protocol. Its preset
        // may contain a legacy permission value, but that value is irrelevant
        // and must never block the session from starting.
        let mut argv = vec![exe];
        argv.extend(default_args);
        argv.extend(ctx.preset.args.clone());
        // Desktop applications launched from Finder do not inherit the user's
        // interactive Homebrew PATH. Make the standard macOS locations
        // available for the managed zsh session before ~/.zshrc runs, so
        // optional integrations such as fnm, fzf and zoxide can initialize.
        // This is session-local and never rewrites the user's dotfiles.
        let mut env = vec![];
        let mut helper_files = vec![];
        if managed_zsh {
            let path = managed_shell_path();
            env.push(("PATH".into(), path));
            env.push(("ZDOTDIR".into(), ctx.session_dir.clone()));
            helper_files.push((format!("{}/.zprofile", ctx.session_dir), managed_zprofile()));
            helper_files.push((format!("{}/.zshrc", ctx.session_dir), managed_zshrc()));
        }

        Ok(LaunchPlan {
            argv,
            env,
            assigned_agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            hook_status: HookStatus::Unavailable,
            helper_files,
            notes: vec![],
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        // Shell 无会话概念：诚实降级为重新打开一个新 shell，绝不假装恢复。
        let mut plan = self.build_launch(&LaunchContext {
            install: ctx.install.clone(),
            preset: ctx.preset.clone(),
            cwd: ctx.cwd.clone(),
            session_id: ctx.session_id.clone(),
            hook_events_path: ctx.hook_events_path.clone(),
            session_dir: ctx.session_dir.clone(),
        })?;
        plan.resume_precision = ResumePrecision::Unavailable;
        plan.notes
            .push("Shell 无会话概念，无法恢复，已重新打开新 shell".into());
        Ok(plan)
    }
}

fn is_zsh(executable: &str) -> bool {
    Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "zsh")
}

fn disables_rc_files(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "-f" || arg == "--no-rcs")
}

fn has_login_flag(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--login"
            || arg == "-l"
            || (arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('l'))
    })
}

/// Preserve the user's normal PATH while making the locations commonly absent
/// from macOS GUI apps available before their interactive .zshrc is evaluated.
fn managed_shell_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut paths = vec![
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    if !inherited.is_empty() {
        paths.push(&inherited);
    }
    paths.join(":")
}

/// The managed profile still respects the user's login configuration. It is
/// required because setting ZDOTDIR for the session otherwise skips ~/.zprofile.
fn managed_zprofile() -> String {
    r#"# Generated by AgentPort for this session. Do not edit.
[[ -r "$HOME/.zprofile" ]] && source "$HOME/.zprofile"
"#
    .into()
}

/// Keep all user-installed zsh tooling, then replace only the visual prompt
/// with a compact, directory-only form suitable for AgentPort's terminal pane.
fn managed_zshrc() -> String {
    r#"# Generated by AgentPort for this session. Do not edit.
[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"

# Do not show username, host name, or an absolute working directory here.
PROMPT='%F{cyan}%1~%f %# '
RPROMPT=''
"#
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    #[test]
    fn parse_trivial_snapshot() {
        let i = ShellAdapter
            .parse_capabilities(Path::new("/bin/sh"), "sh 1.0", "usage: sh")
            .unwrap();
        assert!(!i.exact_resume);
        assert_eq!(i.hook_status, HookStatus::Unavailable);
    }

    #[test]
    fn build_launch_uses_preset_then_login_zsh() {
        let mut ctx = fx::launch_ctx(AgentType::Shell, &[], PermissionMode::Native);
        ctx.preset.executable_path = "/bin/zsh".into();
        ctx.preset.args.clear();
        let plan = ShellAdapter.build_launch(&ctx).unwrap();
        assert_eq!(plan.argv, vec!["/bin/zsh", "-l"]);
        assert!(plan.env.iter().any(|(name, _)| name == "PATH"));
        assert!(plan.env.iter().any(|(name, _)| name == "ZDOTDIR"));
        assert_eq!(plan.helper_files.len(), 2);

        ctx.preset.executable_path = String::new();
        ctx.preset.args.clear();
        let plan = ShellAdapter.build_launch(&ctx).unwrap();
        if Path::new("/bin/zsh").is_file() {
            assert_eq!(plan.argv, vec!["/bin/zsh", "-l"]);
            assert!(plan.env.iter().any(|(name, value)| {
                name == "PATH" && value.starts_with("/opt/homebrew/bin:")
            }));
            assert!(plan
                .env
                .iter()
                .any(|(name, value)| { name == "ZDOTDIR" && value == "/tmp/work/.agentport" }));
            assert_eq!(plan.helper_files.len(), 2);
            assert_eq!(plan.helper_files[0].0, "/tmp/work/.agentport/.zprofile");
            assert!(plan.helper_files[1].1.contains("source \"$HOME/.zshrc\""));
            assert!(plan.helper_files[1]
                .1
                .contains("PROMPT='%F{cyan}%1~%f %# '"));
        } else {
            assert_eq!(plan.argv, vec!["/bin/sh"]);
            assert!(plan.env.is_empty());
            assert!(plan.helper_files.is_empty());
        }
    }

    #[test]
    fn build_resume_never_pretends() {
        let ctx = fx::resume_ctx(AgentType::Shell, &[], Some("anything"));
        let plan = ShellAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Unavailable);
        assert!(plan.notes.iter().any(|n| n.contains("无法恢复")));
    }

    #[test]
    fn permission_mode_is_ignored_for_generic_shell() {
        let ctx = fx::launch_ctx(AgentType::Shell, &[], PermissionMode::Bypass);
        let plan = ShellAdapter.build_launch(&ctx).unwrap();
        assert!(!plan.argv.is_empty());
    }

    #[test]
    fn zsh_no_rcs_preset_is_left_untouched() {
        let mut ctx = fx::launch_ctx(AgentType::Shell, &[], PermissionMode::Native);
        ctx.preset.executable_path = "/bin/zsh".into();
        ctx.preset.args = vec!["-f".into()];
        let plan = ShellAdapter.build_launch(&ctx).unwrap();
        assert_eq!(plan.argv, vec!["/bin/zsh", "-f"]);
        assert!(plan.env.is_empty());
        assert!(plan.helper_files.is_empty());
    }
}
