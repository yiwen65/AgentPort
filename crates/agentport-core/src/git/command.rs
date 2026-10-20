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
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
#[cfg(test)]
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a reader thread keeps the stage after its deadline expired and the
/// process group was killed: enough for the descendant holding the write end to
/// die and for the reader to hand over the bytes it already read.
const READER_GRACE: Duration = Duration::from_millis(200);

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
        // The readers own the pipe read ends and report through channels
        // instead of join handles. A hook, filter or escaped descendant can
        // keep a write end open after Git itself exits, and joining such a
        // reader would block this call - and the repository lock its caller
        // holds - forever.
        let (stdout_tx, stdout_rx) = mpsc::channel::<ReaderResult>();
        let (stderr_tx, stderr_rx) = mpsc::channel::<ReaderResult>();
        let _stdout_reader = std::thread::spawn(move || {
            let _ = stdout_tx.send(read_bounded(&mut stdout, max_stdout));
        });
        let _stderr_reader = std::thread::spawn(move || {
            let _ = stderr_tx.send(read_bounded(&mut stderr, max_stderr));
        });

        let deadline = Instant::now() + options.timeout.unwrap_or(self.timeout);
        let (status, mut timed_out) = loop {
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
        // Collecting the readers is bounded by the same deadline. Git may exit
        // normally while a hook/filter/descendant still holds a write end; the
        // capture is then untrustworthy, so the call reports a timeout instead
        // of blocking on the pipe or of handing back a silently partial result.
        let mut stdout_capture = join_reader(&stdout_rx, deadline);
        let mut stderr_capture = join_reader(&stderr_rx, deadline);
        if stdout_capture.timed_out || stderr_capture.timed_out {
            timed_out = true;
            terminate_process_group(&mut child);
            let grace_deadline = Instant::now() + READER_GRACE;
            if stdout_capture.timed_out {
                stdout_capture = join_reader(&stdout_rx, grace_deadline).into_partial();
            }
            if stderr_capture.timed_out {
                stderr_capture = join_reader(&stderr_rx, grace_deadline).into_partial();
            }
        }

        Ok(GitOutput {
            argv,
            stdout: stdout_capture.bytes,
            stderr: stderr_capture.bytes,
            stdout_truncated: stdout_capture.truncated,
            stderr_truncated: stderr_capture.truncated,
            status,
            timed_out,
        })
    }
}

/// What one reader thread captured from a pipe.
type ReaderResult = (Vec<u8>, bool);

/// Bytes captured by one reader thread plus whether the caller may trust them
/// to be complete.
#[derive(Debug)]
struct ReaderCapture {
    bytes: Vec<u8>,
    truncated: bool,
    /// The reader had not delivered by its deadline; the caller must not trust
    /// the capture and must reconcile repository state itself.
    timed_out: bool,
}

impl ReaderCapture {
    /// Keep the bytes that already arrived without ever reporting a complete
    /// capture. Used after the process group was killed while a reader was
    /// still blocked on a write end it did not own.
    fn into_partial(mut self) -> Self {
        self.truncated = true;
        self.timed_out = true;
        self
    }
}

fn remaining_until(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// Receive one reader's result without ever waiting past `deadline`.
fn join_reader(rx: &Receiver<ReaderResult>, deadline: Instant) -> ReaderCapture {
    match rx.recv_timeout(remaining_until(deadline)) {
        Ok((bytes, truncated)) => ReaderCapture {
            bytes,
            truncated,
            timed_out: false,
        },
        Err(RecvTimeoutError::Timeout) => ReaderCapture {
            bytes: Vec::new(),
            truncated: true,
            timed_out: true,
        },
        // The reader thread ended without reporting (it panicked), so whatever
        // it had read is lost and cannot be distinguished from a partial read.
        Err(RecvTimeoutError::Disconnected) => ReaderCapture {
            bytes: Vec::new(),
            truncated: true,
            timed_out: false,
        },
    }
}

fn read_bounded(reader: &mut impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            // A signal interrupting the read is not the end of the stream; only
            // an actual read error is, and that error cannot be told apart from
            // a complete read by the caller.
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                truncated = true;
                break;
            }
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
    fn join_reader_reports_timeout_for_a_silent_reader() {
        // The sender stays alive but never delivers, exactly like a reader
        // thread whose pipe write end is still held by an escaped descendant.
        let (_tx, rx) = mpsc::channel::<ReaderResult>();
        let started = Instant::now();
        let capture = join_reader(&rx, Instant::now() + Duration::from_millis(50));
        let elapsed = started.elapsed();
        assert!(capture.timed_out, "a silent reader must look timed out");
        assert!(capture.truncated, "an undelivered capture is not complete");
        assert!(capture.bytes.is_empty());
        assert!(
            elapsed >= Duration::from_millis(40),
            "returned before its deadline: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "deadline was ignored: {elapsed:?}"
        );
    }

    #[test]
    fn join_reader_returns_a_delivered_capture() {
        let (tx, rx) = mpsc::channel::<ReaderResult>();
        tx.send((b"captured".to_vec(), false)).unwrap();
        let capture = join_reader(&rx, Instant::now() + Duration::from_secs(1));
        assert_eq!(capture.bytes, b"captured");
        assert!(!capture.truncated);
        assert!(!capture.timed_out);
    }

    #[test]
    fn late_capture_is_never_reported_as_complete() {
        let (tx, rx) = mpsc::channel::<ReaderResult>();
        tx.send((b"late".to_vec(), false)).unwrap();
        let capture = join_reader(&rx, Instant::now() + Duration::from_secs(1)).into_partial();
        assert_eq!(capture.bytes, b"late");
        assert!(capture.truncated);
        assert!(capture.timed_out);
    }

    #[derive(Clone, Copy)]
    enum ScriptedChunk {
        Bytes(&'static [u8]),
        Error(std::io::ErrorKind),
    }

    struct ScriptedReader {
        chunks: Vec<ScriptedChunk>,
        next: usize,
    }

    impl ScriptedReader {
        fn new(chunks: Vec<ScriptedChunk>) -> Self {
            Self { chunks, next: 0 }
        }
    }

    impl Read for ScriptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let Some(chunk) = self.chunks.get(self.next) else {
                return Ok(0);
            };
            self.next += 1;
            match chunk {
                ScriptedChunk::Bytes(bytes) => {
                    buffer[..bytes.len()].copy_from_slice(bytes);
                    Ok(bytes.len())
                }
                ScriptedChunk::Error(kind) => {
                    Err(std::io::Error::new(*kind, "scripted read error"))
                }
            }
        }
    }

    #[test]
    fn read_bounded_retries_interrupted_reads() {
        let mut reader = ScriptedReader::new(vec![
            ScriptedChunk::Error(std::io::ErrorKind::Interrupted),
            ScriptedChunk::Bytes(b"kept"),
        ]);
        let (bytes, truncated) = read_bounded(&mut reader, 64);
        assert_eq!(bytes, b"kept", "EINTR must not truncate the capture");
        assert!(!truncated);
    }

    #[test]
    fn read_bounded_marks_genuine_read_errors_as_truncated() {
        let mut reader = ScriptedReader::new(vec![
            ScriptedChunk::Bytes(b"kept"),
            ScriptedChunk::Error(std::io::ErrorKind::Other),
        ]);
        let (bytes, truncated) = read_bounded(&mut reader, 64);
        assert_eq!(bytes, b"kept");
        assert!(
            truncated,
            "a read error cannot be told apart from a complete read"
        );
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
