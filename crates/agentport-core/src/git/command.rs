//! Bounded, environment-isolated execution of the system Git executable.

use crate::error::{CoreError, Result};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REPOSITORY_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_SHALLOW_FILE",
    "GIT_QUARANTINE_PATH",
    "GIT_OPTIONAL_LOCKS",
];

#[derive(Debug)]
pub struct GitOutput {
    pub argv: Vec<OsString>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub status: ExitStatus,
    /// A timeout is an observation about the process, not proof that the Git
    /// mutation did not happen. Callers must inspect repository state before
    /// deciding whether to roll back or report success.
    pub timed_out: bool,
}

#[derive(Debug, Clone)]
pub struct GitRunOptions {
    pub input: Option<Vec<u8>>,
    pub max_stdout: usize,
    pub max_stderr: usize,
    pub read_only: bool,
    pub timeout: Option<Duration>,
}

impl Default for GitRunOptions {
    fn default() -> Self {
        Self {
            input: None,
            max_stdout: 8 * 1024 * 1024,
            max_stderr: 256 * 1024,
            read_only: false,
            timeout: None,
        }
    }
}

impl GitOutput {
    pub fn success(&self) -> bool {
        !self.timed_out && self.status.success()
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.status.code()
    }

    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    pub fn require_success(self) -> Result<Self> {
        if self.success() {
            return Ok(self);
        }
        let stderr = if self.stderr_truncated {
            format!("{} [stderr truncated]", self.stderr_lossy().trim())
        } else {
            self.stderr_lossy().trim().to_owned()
        };
        if self.timed_out {
            return Err(CoreError::Timeout(format!(
                "git {} timed out: {}",
                display_argv(&self.argv),
                stderr
            )));
        }
        Err(CoreError::Git(format!(
            "git {} failed (exit {:?}): {}",
            display_argv(&self.argv),
            self.exit_code(),
            stderr
        )))
    }
}

#[derive(Debug, Clone)]
pub struct GitRunner {
    timeout: Duration,
    #[cfg(test)]
    fail_once: Option<Arc<TestFailure>>,
    #[cfg(test)]
    ref_move_once: Option<Arc<TestRefMove>>,
    #[cfg(test)]
    worktree_occupy_once: Option<Arc<TestWorktreeOccupy>>,
    #[cfg(test)]
    recorded: Option<Arc<Mutex<Vec<Vec<OsString>>>>>,
}

#[cfg(test)]
#[derive(Debug)]
struct TestFailure {
    command: OsString,
    trigger_on: usize,
    seen: AtomicUsize,
}

#[cfg(test)]
#[derive(Debug)]
struct TestRefMove {
    command: OsString,
    required_arg: Option<OsString>,
    refname: OsString,
    new_oid: OsString,
    triggered: AtomicBool,
}

#[cfg(test)]
#[derive(Debug)]
struct TestWorktreeOccupy {
    branch: OsString,
    path: OsString,
    triggered: AtomicBool,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self::new(Duration::from_secs(15))
    }
}

impl GitRunner {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            #[cfg(test)]
            fail_once: None,
            #[cfg(test)]
            ref_move_once: None,
            #[cfg(test)]
            worktree_occupy_once: None,
            #[cfg(test)]
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn failing_once(command: &str) -> Self {
        Self {
            timeout: Duration::from_secs(15),
            fail_once: Some(Arc::new(TestFailure {
                command: command.into(),
                trigger_on: 1,
                seen: AtomicUsize::new(0),
            })),
            ref_move_once: None,
            worktree_occupy_once: None,
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn failing_nth(command: &str, trigger_on: usize) -> Self {
        assert!(trigger_on > 0);
        Self {
            timeout: Duration::from_secs(15),
            fail_once: Some(Arc::new(TestFailure {
                command: command.into(),
                trigger_on,
                seen: AtomicUsize::new(0),
            })),
            ref_move_once: None,
            worktree_occupy_once: None,
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn moving_ref_before_update(refname: &str, new_oid: &str) -> Self {
        Self {
            timeout: Duration::from_secs(15),
            fail_once: None,
            ref_move_once: Some(Arc::new(TestRefMove {
                command: "update-ref".into(),
                required_arg: Some("-d".into()),
                refname: refname.into(),
                new_oid: new_oid.into(),
                triggered: AtomicBool::new(false),
            })),
            worktree_occupy_once: None,
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn creating_external_ref_before_update(refname: &str, new_oid: &str) -> Self {
        Self {
            timeout: Duration::from_secs(15),
            fail_once: None,
            ref_move_once: Some(Arc::new(TestRefMove {
                command: "update-ref".into(),
                required_arg: None,
                refname: refname.into(),
                new_oid: new_oid.into(),
                triggered: AtomicBool::new(false),
            })),
            worktree_occupy_once: None,
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn occupying_branch_before_delete(branch: &str, path: &Path) -> Self {
        Self {
            timeout: Duration::from_secs(15),
            fail_once: None,
            ref_move_once: None,
            worktree_occupy_once: Some(Arc::new(TestWorktreeOccupy {
                branch: branch.into(),
                path: path.as_os_str().to_owned(),
                triggered: AtomicBool::new(false),
            })),
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn moving_ref_before_worktree_add(refname: &str, new_oid: &str) -> Self {
        Self {
            timeout: Duration::from_secs(15),
            fail_once: None,
            ref_move_once: Some(Arc::new(TestRefMove {
                command: "worktree".into(),
                required_arg: Some("add".into()),
                refname: refname.into(),
                new_oid: new_oid.into(),
                triggered: AtomicBool::new(false),
            })),
            worktree_occupy_once: None,
            recorded: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn recording() -> (Self, Arc<Mutex<Vec<Vec<OsString>>>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                timeout: Duration::from_secs(15),
                fail_once: None,
                ref_move_once: None,
                worktree_occupy_once: None,
                recorded: Some(recorded.clone()),
            },
            recorded,
        )
    }

    pub fn run<I, S>(&self, repo: Option<&Path>, args: I) -> Result<GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_with_options(repo, args, GitRunOptions::default())
    }

    pub fn run_read_only<I, S>(&self, repo: Option<&Path>, args: I) -> Result<GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_with_options(
            repo,
            args,
            GitRunOptions {
                read_only: true,
                ..GitRunOptions::default()
            },
        )
    }

    pub fn run_with_options<I, S>(
        &self,
        repo: Option<&Path>,
        args: I,
        options: GitRunOptions,
    ) -> Result<GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_inner(repo, args, options)
    }

    fn run_inner<I, S>(
        &self,
        repo: Option<&Path>,
        args: I,
        options: GitRunOptions,
    ) -> Result<GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut argv = Vec::<OsString>::new();
        if let Some(repo) = repo {
            argv.push(OsString::from("-C"));
            argv.push(repo.as_os_str().to_owned());
        }
        argv.extend(args.into_iter().map(|arg| arg.as_ref().to_owned()));

        #[cfg(test)]
        if let Some(recorded) = &self.recorded {
            recorded.lock().unwrap().push(argv.clone());
        }

        #[cfg(test)]
        if let Some(failure) = &self.fail_once {
            if argv.iter().any(|arg| arg == &failure.command)
                && failure.seen.fetch_add(1, Ordering::SeqCst) + 1 == failure.trigger_on
            {
                return Err(CoreError::Git(format!(
                    "injected failure before git {:?}",
                    failure.command
                )));
            }
        }

        #[cfg(test)]
        if let Some(ref_move) = &self.ref_move_once {
            if argv.iter().any(|arg| arg == &ref_move.command)
                && ref_move
                    .required_arg
                    .as_ref()
                    .is_none_or(|required| argv.iter().any(|arg| arg == required))
                && !ref_move.triggered.swap(true, Ordering::SeqCst)
            {
                let root = repo.ok_or_else(|| {
                    CoreError::Internal("test ref-move injection requires a repository".into())
                })?;
                let output = Command::new("git")
                    .arg("-C")
                    .arg(root)
                    .arg("update-ref")
                    .arg(&ref_move.refname)
                    .arg(&ref_move.new_oid)
                    .stdin(Stdio::null())
                    .output()?;
                if !output.status.success() {
                    return Err(CoreError::Git(format!(
                        "test ref-move injection failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )));
                }
            }
        }

        #[cfg(test)]
        if let Some(occupy) = &self.worktree_occupy_once {
            if argv.iter().any(|arg| arg == "update-ref")
                && argv.iter().any(|arg| arg == "-d")
                && !occupy.triggered.swap(true, Ordering::SeqCst)
            {
                let root = repo.ok_or_else(|| {
                    CoreError::Internal("test worktree injection requires a repository".into())
                })?;
                let output = Command::new("git")
                    .arg("-C")
                    .arg(root)
                    .arg("worktree")
                    .arg("add")
                    .arg(&occupy.path)
                    .arg(&occupy.branch)
                    .stdin(Stdio::null())
                    .output()?;
                if !output.status.success() {
                    return Err(CoreError::Git(format!(
                        "test worktree-occupancy injection failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )));
                }
            }
        }

        let mut command = Command::new("git");
        command
            .args(&argv)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.stdin(if options.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        for name in REPOSITORY_ENV {
            command.env_remove(name);
        }
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_PAGER", "cat");
        if options.read_only {
            command.env("GIT_OPTIONAL_LOCKS", "0");
            // Machine-readable commands and binary markers must not depend on
            // the GUI process locale. Write commands keep the user's locale so
            // repository hooks retain their normal environment.
            command.env("LC_ALL", "C");
            command.env("LANG", "C");
        }
        // Git can start hooks, filters and aliases. Give the whole invocation
        // its own process group so a timeout terminates descendants that may
        // otherwise keep the stdout/stderr pipes open indefinitely.
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn()?;
        let stdin_thread = options.input.map(|input| {
            let mut stdin = child
                .stdin
                .take()
                .expect("Git stdin must be piped when input is configured");
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
            })
        });
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| CoreError::Internal("git stdout was not piped".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| CoreError::Internal("git stderr was not piped".into()))?;
        let max_stdout = options.max_stdout;
        let max_stderr = options.max_stderr;
        let stdout_thread = std::thread::spawn(move || read_bounded(&mut stdout, max_stdout));
        let stderr_thread = std::thread::spawn(move || read_bounded(&mut stderr, max_stderr));

        let deadline = Instant::now() + options.timeout.unwrap_or(self.timeout);
        let (status, timed_out) = loop {
            if let Some(status) = child.try_wait()? {
                break (status, false);
            }
            if Instant::now() >= deadline {
                terminate_process_group(&mut child);
                let status = child.wait()?;
                break (status, true);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if let Some(stdin_thread) = stdin_thread {
            let _ = stdin_thread.join();
        }
        let (stdout, stdout_truncated) = stdout_thread.join().unwrap_or_default();
        let (stderr, stderr_truncated) = stderr_thread.join().unwrap_or_default();

        Ok(GitOutput {
            argv,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            status,
            timed_out,
        })
    }
}

fn read_bounded(reader: &mut impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = limit.saturating_sub(kept.len());
        let take = read.min(remaining);
        kept.extend_from_slice(&buffer[..take]);
        if take < read {
            truncated = true;
        }
    }
    (kept, truncated)
}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    let pid = child.id();
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: `process_group(0)` placed the child in a group whose id is
        // the child pid. A negative pid targets that group only.
        let _ = unsafe { kill(-pid, SIGKILL) };
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn display_argv(argv: &[OsString]) -> String {
    argv.iter()
        .map(|arg| format!("{:?}", arg.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_nonzero_output_without_losing_raw_bytes() {
        let output = GitRunner::default()
            .run(None, ["definitely-not-an-agentport-command"])
            .unwrap();
        assert!(!output.success());
        assert!(output.exit_code().is_some());
        assert!(!output.stderr.is_empty());
    }

    #[test]
    fn repository_environment_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        GitRunner::default()
            .run(Some(&repo), ["init", "-b", "main"])
            .unwrap()
            .require_success()
            .unwrap();
        std::env::set_var("GIT_DIR", tmp.path().join("not-the-repo"));
        let output = GitRunner::default()
            .run(Some(&repo), ["rev-parse", "--git-dir"])
            .unwrap()
            .require_success()
            .unwrap();
        std::env::remove_var("GIT_DIR");
        assert_eq!(output.stdout_lossy().trim(), ".git");
    }

    #[test]
    fn timeout_preserves_observable_output_and_status() {
        let started = Instant::now();
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("timeout-test.sh");
        std::fs::write(&script, "#!/bin/sh\nprintf before-timeout\nsleep 1\n").unwrap();
        let output = GitRunner::new(Duration::from_millis(250))
            .run(
                None,
                [
                    "-c",
                    &format!("alias.agentport-timeout=!/bin/sh {}", script.display()),
                    "agentport-timeout",
                ],
            )
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(output.timed_out);
        assert!(!output.success());
        assert!(output.stdout_lossy().contains("before-timeout"));
        assert!(matches!(
            output.require_success(),
            Err(CoreError::Timeout(_))
        ));
    }
}
