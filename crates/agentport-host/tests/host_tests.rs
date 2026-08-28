//! End-to-end tests for agentport-host: real PTY, real processes, real socket.
//! Every test uses its own tempdir + socket path, polls with timeouts instead
//! of fixed sleeps, and cleans up the host (and the agent process group) at
//! the end via HostGuard.

use std::io::{BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agentport_core::models::{AgentState, AgentTransport, LogCursor, StateSource};
use agentport_core::protocol::{
    read_frame, write_frame, ClientFrame, HostConfig, HostFrame, PROTOCOL_VERSION,
};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

fn uniq(prefix: &str) -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{prefix}-{n:x}")
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

struct TestCtx {
    _dir: tempfile::TempDir,
    dir: PathBuf,
    session_id: String,
    cfg_path: PathBuf,
    socket: PathBuf,
    log: PathBuf,
    host_log: PathBuf,
}

fn make_ctx(command: Vec<String>, log_limit: u64, secret_env_names: Vec<String>) -> TestCtx {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().to_path_buf();
    let session_id = uniq("ses");
    let cfg = HostConfig {
        protocol: PROTOCOL_VERSION,
        session_id: session_id.clone(),
        run_id: uniq("run"),
        run_ordinal: 1,
        host_token: TOKEN.to_string(),
        command,
        cwd: d.to_string_lossy().into_owned(),
        env: vec![],
        adapter_type: "shell".into(),
        transport: AgentTransport::Pty,
        socket_path: d.join("h.sock").to_string_lossy().into_owned(),
        session_dir: d.to_string_lossy().into_owned(),
        log_path: d.join("output.log").to_string_lossy().into_owned(),
        host_log_path: d.join("host.log").to_string_lossy().into_owned(),
        hook_events_path: d.join("events.jsonl").to_string_lossy().into_owned(),
        log_limit_bytes: log_limit,
        agent_session_id_hint: None,
        secret_env_names,
        sigint_grace_ms: 1_500,
        sigterm_grace_ms: 1_500,
        cols: 120,
        rows: 32,
    };
    let cfg_path = d.join("host.json");
    std::fs::write(&cfg_path, serde_json::to_string(&cfg).unwrap()).unwrap();
    std::fs::set_permissions(&cfg_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    TestCtx {
        dir: d.clone(),
        session_id,
        cfg_path,
        socket: d.join("h.sock"),
        log: d.join("output.log"),
        host_log: d.join("host.log"),
        _dir: dir,
    }
}

/// A tiny shell protocol shim exercises the real pipe path without using a
/// configured Pi account. The production Host still sees stdin/stdout JSONL
/// exactly as it would from `pi --mode rpc`.
fn make_rpc_ctx(script: &str) -> TestCtx {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), script.into()],
        2 * 1024 * 1024,
        vec![],
    );
    let mut cfg: HostConfig =
        serde_json::from_str(&std::fs::read_to_string(&ctx.cfg_path).unwrap()).unwrap();
    cfg.adapter_type = "pi".into();
    cfg.transport = AgentTransport::JsonRpc;
    cfg.agent_session_id_hint = Some("pi-native-test-id".into());
    std::fs::write(&ctx.cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    ctx
}

fn make_pi_pty_ctx(script: &str) -> TestCtx {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), script.into()],
        2 * 1024 * 1024,
        vec![],
    );
    let mut cfg: HostConfig =
        serde_json::from_str(&std::fs::read_to_string(&ctx.cfg_path).unwrap()).unwrap();
    cfg.adapter_type = "pi".into();
    cfg.agent_session_id_hint = Some("pi-native-test-id".into());
    std::fs::write(&ctx.cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    ctx
}

fn make_kimi_pty_ctx(script: &str) -> TestCtx {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), script.into()],
        2 * 1024 * 1024,
        vec![],
    );
    let kimi_home = ctx.dir.join("kimi-home");
    std::fs::create_dir_all(kimi_home.join("sessions")).unwrap();
    let mut cfg: HostConfig =
        serde_json::from_str(&std::fs::read_to_string(&ctx.cfg_path).unwrap()).unwrap();
    cfg.adapter_type = "kimi".into();
    cfg.env.push((
        "KIMI_CODE_HOME".into(),
        kimi_home.to_string_lossy().into_owned(),
    ));
    std::fs::write(&ctx.cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    ctx
}

/// Kills the host (SIGTERM first so it can clean the agent group itself,
/// SIGKILL after a grace) and the agent process group on drop.
struct HostGuard {
    child: Option<Child>,
    dir: PathBuf,
}

impl HostGuard {
    fn pid(&self) -> i32 {
        self.child.as_ref().unwrap().id() as i32
    }

    /// Child (agent) pid recorded in host-state.json.
    fn agent_pid(&self) -> Option<i32> {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(self.dir.join("host-state.json")).ok()?)
                .ok()?;
        v["pid"].as_i64().map(|p| p as i32)
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let c = self.child.as_mut().unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            match c.try_wait() {
                Ok(Some(st)) => return Some(st),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return None,
            }
        }
    }
}

impl Drop for HostGuard {
    fn drop(&mut self) {
        let Some(mut c) = self.child.take() else {
            return;
        };
        let alive = matches!(c.try_wait(), Ok(None));
        if alive {
            let _ = kill(Pid::from_raw(c.id() as i32), Signal::SIGTERM);
            let deadline = Instant::now() + Duration::from_secs(6);
            loop {
                match c.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = c.kill();
                            let _ = c.wait();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        }
        // Last resort: never leak the agent process group.
        if let Some(pid) = self.agent_pid() {
            let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
        }
    }
}

fn spawn_host(ctx: &TestCtx, extra_env: &[(&str, &str)]) -> HostGuard {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentport-host"));
    cmd.arg("--config")
        .arg(&ctx.cfg_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().unwrap();
    HostGuard {
        child: Some(child),
        dir: ctx.dir.clone(),
    }
}

fn spawn_host_without_locale(ctx: &TestCtx) -> HostGuard {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentport-host"));
    cmd.arg("--config")
        .arg(&ctx.cfg_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for name in ["LANG", "LC_ALL", "LC_CTYPE"] {
        cmd.env_remove(name);
    }
    let child = cmd.spawn().unwrap();
    HostGuard {
        child: Some(child),
        dir: ctx.dir.clone(),
    }
}

fn wait_for(mut pred: impl FnMut() -> bool, timeout: Duration, what: &str) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for: {what}");
}

fn wait_socket(ctx: &TestCtx) {
    wait_for(
        || UnixStream::connect(&ctx.socket).is_ok(),
        Duration::from_secs(10),
        "connectable socket",
    );
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

#[allow(clippy::large_enum_variant)]
enum Read1 {
    Frame(HostFrame),
    Closed,
    Timeout,
}

struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Conn {
    fn send(&mut self, f: &ClientFrame) {
        write_frame(&mut self.writer, f).unwrap();
    }

    fn read1(&mut self, timeout: Duration) -> Read1 {
        // macOS: setsockopt(SO_RCVTIMEO) fails with EINVAL once the peer has
        // closed the socket. That's exactly the "connection closed" case —
        // the read below then returns buffered data / EOF immediately, so a
        // failed setsockopt is safe to ignore (connect() already set a floor).
        let _ = self.reader.get_ref().set_read_timeout(Some(timeout));
        match read_frame(&mut self.reader) {
            Ok(Some(f)) => Read1::Frame(f),
            Ok(None) => Read1::Closed,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                Read1::Timeout
            }
            Err(_) => Read1::Closed, // ECONNRESET et al. count as closed
        }
    }

    /// Collect frames until `done` says stop, EOF arrives, or timeout hits.
    fn collect_until(
        &mut self,
        timeout: Duration,
        done: impl Fn(&[HostFrame]) -> bool,
    ) -> Vec<HostFrame> {
        let mut out = Vec::new();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline && !done(&out) {
            match self.read1(Duration::from_millis(200)) {
                Read1::Frame(f) => out.push(f),
                Read1::Closed => break,
                Read1::Timeout => {}
            }
        }
        out
    }

    fn expect_hello_ok_info(&mut self) -> (u32, bool, LogCursor) {
        match self.read1(Duration::from_secs(5)) {
            Read1::Frame(HostFrame::HelloOk {
                protocol,
                host_pid,
                child_alive,
                run_id,
                run_ordinal,
                log_cursor,
                ..
            }) => {
                assert_eq!(protocol, PROTOCOL_VERSION);
                assert!(!run_id.is_empty(), "v2 hello must identify its run");
                assert!(run_ordinal >= 1, "test Hosts use a non-legacy run");
                assert_eq!(log_cursor.run_id, run_id);
                assert_eq!(log_cursor.run_ordinal, run_ordinal);
                (host_pid, child_alive, log_cursor)
            }
            other => panic!("expected hello_ok, got {}", read1_desc(other)),
        }
    }

    fn expect_hello_ok(&mut self) -> (u32, bool) {
        let (host_pid, child_alive, _) = self.expect_hello_ok_info();
        (host_pid, child_alive)
    }
}

fn read1_desc(r: Read1) -> String {
    match r {
        Read1::Frame(f) => format!("frame {f:?}"),
        Read1::Closed => "closed".into(),
        Read1::Timeout => "timeout".into(),
    }
}

fn connect(ctx: &TestCtx, session_id: &str, token: &str, replay_tail_bytes: u64) -> Conn {
    connect_with_output_subscription(ctx, session_id, token, replay_tail_bytes, true)
}

fn connect_with_output_subscription(
    ctx: &TestCtx,
    session_id: &str,
    token: &str,
    replay_tail_bytes: u64,
    subscribe_output: bool,
) -> Conn {
    connect_with_resume(
        ctx,
        session_id,
        token,
        replay_tail_bytes,
        None,
        subscribe_output,
    )
}

fn connect_with_resume(
    ctx: &TestCtx,
    session_id: &str,
    token: &str,
    replay_tail_bytes: u64,
    resume_from: Option<LogCursor>,
    subscribe_output: bool,
) -> Conn {
    let s = UnixStream::connect(&ctx.socket).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let w = s.try_clone().unwrap();
    let mut c = Conn {
        reader: BufReader::new(s),
        writer: w,
    };
    c.send(&ClientFrame::Hello {
        protocol: PROTOCOL_VERSION,
        session_id: session_id.to_string(),
        token: token.to_string(),
        replay_tail_bytes,
        resume_from,
        replay_target: None,
        subscribe_output,
    });
    c
}

fn connect_with_recovery_target(
    ctx: &TestCtx,
    session_id: &str,
    token: &str,
    replay_tail_bytes: u64,
    replay_target: LogCursor,
) -> Conn {
    let s = UnixStream::connect(&ctx.socket).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let w = s.try_clone().unwrap();
    let mut c = Conn {
        reader: BufReader::new(s),
        writer: w,
    };
    c.send(&ClientFrame::Hello {
        protocol: PROTOCOL_VERSION,
        session_id: session_id.to_string(),
        token: token.to_string(),
        replay_tail_bytes,
        resume_from: None,
        replay_target: Some(replay_target),
        subscribe_output: true,
    });
    c
}

fn output_bytes(frames: &[HostFrame]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in frames {
        match f {
            HostFrame::Output { data, .. } | HostFrame::TransientOutput { data, .. } => {
                out.extend_from_slice(data);
            }
            _ => {}
        }
    }
    out
}

/// Verify Output offsets form an exact partition of the log stream.
fn offsets_are_contiguous(frames: &[HostFrame]) -> bool {
    let mut expected = None::<u64>;
    for f in frames {
        if let HostFrame::Output {
            data,
            offset,
            cursor,
            ..
        } = f
        {
            assert_eq!(cursor.offset, *offset as i64);
            assert!(!cursor.run_id.is_empty());
            match expected {
                None => expected = Some(*offset + data.len() as u64),
                Some(e) if e == *offset => expected = Some(e + data.len() as u64),
                Some(_) => return false,
            }
        }
    }
    true
}

fn pids_in_group(pgid: i32) -> Vec<i32> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,pgid="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid: i32 = it.next()?.parse().ok()?;
            let g: i32 = it.next()?.parse().ok()?;
            (g == pgid).then_some(pid)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 1. Handshake: ok / wrong token / wrong session / non-Hello first frame
// ---------------------------------------------------------------------------

#[test]
fn handshake_ok_and_rejections() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    // Good handshake.
    let mut ok = connect(&ctx, &ctx.session_id, TOKEN, 0);
    let (host_pid, child_alive) = ok.expect_hello_ok();
    assert_eq!(host_pid, guard.pid() as u32);
    assert!(child_alive);
    drop(ok);

    // Wrong token -> generic Error, then closed.
    let mut bad_tok = connect(&ctx, &ctx.session_id, "wrong-token-wrong-token", 0);
    match bad_tok.read1(Duration::from_secs(3)) {
        Read1::Frame(HostFrame::Error { message, .. }) => {
            assert!(
                !message.contains("token"),
                "must not leak token detail: {message}"
            );
        }
        other => panic!("expected error, got {}", read1_desc(other)),
    }
    assert!(matches!(
        bad_tok.read1(Duration::from_secs(3)),
        Read1::Closed
    ));

    // Wrong session id -> Error, then closed.
    let mut bad_sid = connect(&ctx, "ses_somebody_else", TOKEN, 0);
    assert!(matches!(
        bad_sid.read1(Duration::from_secs(3)),
        Read1::Frame(HostFrame::Error { .. })
    ));
    assert!(matches!(
        bad_sid.read1(Duration::from_secs(3)),
        Read1::Closed
    ));

    // Non-Hello first frame -> Error, then closed.
    let s = UnixStream::connect(&ctx.socket).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut w = s.try_clone().unwrap();
    write_frame(
        &mut w,
        &ClientFrame::Ping {
            session_id: ctx.session_id.clone(),
        },
    )
    .unwrap();
    let mut r = BufReader::new(&s);
    match read_frame::<HostFrame>(&mut r) {
        Ok(Some(HostFrame::Error { .. })) => {}
        other => panic!("expected error for non-hello first frame, got {other:?}"),
    }
    assert!(matches!(read_frame::<HostFrame>(&mut r), Ok(None) | Err(_)));

    // Host survives all of this.
    let mut again = connect(&ctx, &ctx.session_id, TOKEN, 0);
    let (_, alive) = again.expect_hello_ok();
    assert!(alive);

    // Contract #9: SIGTERM to the HOST triggers the same group cleanup.
    let agent_pid = guard.agent_pid().unwrap();
    kill(Pid::from_raw(guard.pid()), Signal::SIGTERM).unwrap();
    let status = guard
        .wait_exit(Duration::from_secs(10))
        .expect("host exits on SIGTERM");
    assert_eq!(status.code(), Some(0));
    assert_eq!(
        kill(Pid::from_raw(-agent_pid), None::<Signal>),
        Err(nix::errno::Errno::ESRCH),
        "agent group must be gone after host SIGTERM"
    );
}

#[test]
fn explicit_session_dir_owns_state_and_status_journal() {
    let mut ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let stable_session_dir = ctx.dir.join("stable-session");
    let run_dir = ctx.dir.join("runs").join("run-1");
    std::fs::create_dir_all(&stable_session_dir).unwrap();
    std::fs::create_dir_all(&run_dir).unwrap();
    let mut cfg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&ctx.cfg_path).unwrap()).unwrap();
    cfg["sessionDir"] = serde_json::json!(stable_session_dir);
    cfg["logPath"] = serde_json::json!(run_dir.join("output.log"));
    cfg["hostLogPath"] = serde_json::json!(run_dir.join("host.log"));
    cfg["hookEventsPath"] = serde_json::json!(run_dir.join("events.jsonl"));
    std::fs::write(&ctx.cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    ctx.dir = stable_session_dir.clone();

    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    wait_for(
        || {
            stable_session_dir.join("host-state.json").exists()
                && stable_session_dir.join("status-events.jsonl").exists()
        },
        Duration::from_secs(5),
        "state artifacts in explicit Session root",
    );
    assert!(!run_dir.join("host-state.json").exists());
    assert!(!run_dir.join("status-events.jsonl").exists());
}

// The Host keeps this limit deliberately small: every authenticated client
// owns a writer thread and a bounded outbound queue.
const EXPECTED_MAX_AUTHENTICATED_CLIENTS: usize = 16;

#[test]
fn authenticated_connection_limit_rejects_excess_client() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let mut clients = Vec::with_capacity(EXPECTED_MAX_AUTHENTICATED_CLIENTS);
    for _ in 0..EXPECTED_MAX_AUTHENTICATED_CLIENTS {
        let mut client = connect(&ctx, &ctx.session_id, TOKEN, 0);
        client.expect_hello_ok();
        clients.push(client);
    }

    let mut excess = connect(&ctx, &ctx.session_id, TOKEN, 0);
    assert!(matches!(
        excess.read1(Duration::from_secs(3)),
        Read1::Frame(HostFrame::Error { .. }) | Read1::Closed
    ));

    // Refusing one surplus connection must not affect already-connected ones.
    clients[0].send(&ClientFrame::Ping {
        session_id: ctx.session_id.clone(),
    });
    let replies = clients[0].collect_until(Duration::from_secs(3), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. }))
    });
    assert!(
        replies
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. })),
        "a healthy client must remain usable after the excess client is rejected"
    );

    // Detach closes the reader and writer for exactly one client, releasing
    // its reserved authenticated-client slot for a later connection.
    let mut detached = clients.pop().unwrap();
    detached.send(&ClientFrame::Detach {
        session_id: ctx.session_id.clone(),
    });
    wait_for(
        || matches!(detached.read1(Duration::from_millis(100)), Read1::Closed),
        Duration::from_secs(3),
        "detached client close",
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    let replacement = loop {
        let mut candidate = connect(&ctx, &ctx.session_id, TOKEN, 0);
        if matches!(
            candidate.read1(Duration::from_millis(100)),
            Read1::Frame(HostFrame::HelloOk { .. })
        ) {
            break candidate;
        }
        assert!(Instant::now() < deadline, "detached slot was not reclaimed");
        std::thread::sleep(Duration::from_millis(50));
    };
    drop(replacement);
}

#[test]
fn slow_client_is_evicted_without_stalling_healthy_client() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let mut slow = connect(&ctx, &ctx.session_id, TOKEN, 0);
    slow.expect_hello_ok();
    let mut healthy = connect(&ctx, &ctx.session_id, TOKEN, 0);
    healthy.expect_hello_ok();

    // Do not read `slow`. Flood its own Pong replies until its bounded
    // outbound queue fills; a short client-side write timeout prevents this
    // test from waiting indefinitely if the server regresses.
    slow.writer
        .set_write_timeout(Some(Duration::from_millis(250)))
        .unwrap();
    let ping = ClientFrame::Ping {
        session_id: ctx.session_id.clone(),
    };
    for _ in 0..20_000 {
        if write_frame(&mut slow.writer, &ping).is_err() {
            break;
        }
    }
    wait_for(
        || {
            std::fs::read_to_string(&ctx.host_log)
                .map(|log| log.contains("outbound queue full"))
                .unwrap_or(false)
        },
        Duration::from_secs(10),
        "slow client outbound queue eviction",
    );

    // The Host and a separate client remain usable after isolating the slow
    // consumer; no Agent stop or global socket failure is allowed.
    healthy.send(&ping);
    let replies = healthy.collect_until(Duration::from_secs(3), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. }))
    });
    assert!(
        replies
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. })),
        "a healthy client must remain usable after slow-client eviction"
    );
}

#[test]
fn broadcast_evicts_nonreading_output_client_without_stalling_monitor() {
    let marker = uniq("broadcast-marker");
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!(
                "read start; dd if=/dev/zero bs=16384 count=256 2>/dev/null; sleep 1; printf '\\n{marker}\\n'; sleep 60"
            ),
        ],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    // The slow terminal subscribes to output but never reads it. The monitor
    // deliberately skips output so it remains a healthy control client while
    // the PTY floods the broadcaster.
    let mut slow = connect(&ctx, &ctx.session_id, TOKEN, 0);
    slow.expect_hello_ok();
    let mut monitor = connect_with_output_subscription(&ctx, &ctx.session_id, TOKEN, 0, false);
    monitor.expect_hello_ok();
    monitor.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"start\n".to_vec(),
    });

    wait_for(
        || {
            std::fs::read_to_string(&ctx.host_log)
                .map(|log| log.contains("dropping client from broadcast"))
                .unwrap_or(false)
        },
        Duration::from_secs(20),
        "broadcast slow-client eviction",
    );
    monitor.send(&ClientFrame::Ping {
        session_id: ctx.session_id.clone(),
    });
    let replies = monitor.collect_until(Duration::from_secs(3), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. }))
    });
    assert!(
        replies
            .iter()
            .any(|frame| matches!(frame, HostFrame::Pong { .. })),
        "the status monitor must remain usable after broadcast eviction"
    );

    let produced = monitor.collect_until(Duration::from_secs(10), |frames| {
        frames.iter().any(|frame| matches!(
            frame,
            HostFrame::Heartbeat { log_bytes, .. }
                if *log_bytes >= 4 * 1024 * 1024 + marker.len() as u64
        ))
    });
    assert!(produced.iter().any(|frame| matches!(
        frame,
        HostFrame::Heartbeat { log_bytes, .. }
            if *log_bytes >= 4 * 1024 * 1024 + marker.len() as u64
    )), "Host must finish ingesting the flood before the replay assertion");

    // A fresh terminal can still retrieve the final output tail after the
    // slow subscriber is isolated.
    let mut replay = connect(&ctx, &ctx.session_id, TOKEN, 128 * 1024);
    replay.expect_hello_ok();
    let frames = replay.collect_until(Duration::from_secs(8), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::ReplayDone { .. }))
    });
    assert!(
        !output_bytes(&frames).is_empty()
            && matches!(frames.last(), Some(HostFrame::ReplayDone { .. })),
        "healthy terminal must receive a bounded live-tail replay"
    );
}

// ---------------------------------------------------------------------------
// 2. Echo round-trip + log sha256 consistency
// ---------------------------------------------------------------------------

#[test]
fn pi_rpc_pipe_accepts_prompt_abort_and_persists_structured_events() {
    let ctx = make_rpc_ctx(
        r#"while IFS= read -r line; do
  case "$line" in
    *get_state*) printf '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-native-test-id"}}\n' ;;
    *'"prompt"'*) printf '{"type":"message_update","text":"prompt received"}\n{"type":"agent_settled"}\n' ;;
    *abort*) printf '{"type":"response","command":"abort","success":true}\n' ;;
  esac
done"#,
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut conn = connect(&ctx, &ctx.session_id, TOKEN, 64 * 1024);
    conn.expect_hello_ok();

    let startup = conn.collect_until(Duration::from_secs(5), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::ReplayDone { .. }))
    });
    assert!(String::from_utf8_lossy(&output_bytes(&startup)).contains("pi-native-test-id"));
    assert!(
        !startup.iter().any(|frame| matches!(
            frame,
            HostFrame::Structured { event, .. }
                if event.get("command").and_then(|value| value.as_str()) == Some("get_state")
        )),
        "successful get_state is internal startup validation, not a timeline event"
    );

    // Abort remains available while a turn is active. Once Pi reports that
    // the turn settled, AgentPort automatically stops the idle process.
    conn.send(&ClientFrame::AbortStructuredTurn {
        session_id: ctx.session_id.clone(),
    });
    let aborted = conn.collect_until(Duration::from_secs(5), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::Structured { event, .. }
                    if event.get("command").and_then(|value| value.as_str()) == Some("abort")
            )
        })
    });
    assert!(aborted.iter().any(|frame| matches!(
        frame,
        HostFrame::Structured { event, .. }
            if event.get("command").and_then(|value| value.as_str()) == Some("abort")
    )));

    conn.send(&ClientFrame::StructuredPrompt {
        session_id: ctx.session_id.clone(),
        text: "hello Pi".into(),
    });
    let prompted = conn.collect_until(Duration::from_secs(8), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::State {
                    state: AgentState::Idle,
                    source: StateSource::Adapter,
                    evidence: Some(evidence),
                    ..
                } if evidence == "adapter:pi:TurnEnd"
            )
        })
    });
    assert!(prompted.iter().any(|frame| matches!(
        frame,
        HostFrame::Structured { event, .. }
            if event.get("text").and_then(|value| value.as_str()) == Some("prompt received")
    )));
    assert!(
        prompted.iter().any(|frame| matches!(
            frame,
            HostFrame::State {
                state: AgentState::Idle,
                source: StateSource::Adapter,
                evidence: Some(evidence),
                ..
            } if evidence == "adapter:pi:TurnEnd"
        )),
        "Pi agent_settled was not projected as a semantic turn end: {prompted:?}"
    );

    let terminal = conn.collect_until(Duration::from_secs(8), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::Exit { reason, group_cleaned: true, .. } if reason == "turn_complete"
            )
        })
    });
    assert!(
        terminal.iter().any(|frame| matches!(
            frame,
            HostFrame::Exit { reason, group_cleaned: true, .. } if reason == "turn_complete"
        )),
        "settled Pi RPC turn did not stop its process group: {terminal:?}"
    );
    assert!(String::from_utf8_lossy(&output_bytes(&prompted)).contains("prompt received"));
    assert!(
        !ctx.log.exists(),
        "structured events must not be duplicated to output.log"
    );
}

#[test]
fn pi_pty_hides_only_the_first_private_session_notice() {
    let ctx = make_pi_pty_ctx(
        r#"printf '\033[33mWarning: No project session found with id '"'"'pi-native-test-id'"'"'; creating a new session with that id.\033[39m\r\n'; printf 'Pi TUI ready\r\n'; sleep 60"#,
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut conn = connect(&ctx, &ctx.session_id, TOKEN, 64 * 1024);
    conn.expect_hello_ok();
    let frames = conn.collect_until(Duration::from_secs(5), |frames| {
        String::from_utf8_lossy(&output_bytes(frames)).contains("Pi TUI ready")
    });
    let output_bytes = output_bytes(&frames);
    let output = String::from_utf8_lossy(&output_bytes);
    assert!(output.contains("Pi TUI ready"));
    assert!(!output.contains("No project session found"));
    assert!(!ctx.log.exists(), "Pi PTY output must remain memory-only");
}

#[test]
fn pi_pty_session_jsonl_emits_only_new_semantic_turn_ends_and_stops_idle_process() {
    let ctx = make_pi_pty_ctx("printf 'Pi TUI ready\\r\\n'; sleep 60");
    let session_dir = ctx.dir.join("pi");
    std::fs::create_dir_all(&session_dir).unwrap();
    let session_file = session_dir.join("pi-session.jsonl");
    std::fs::write(
        &session_file,
        b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
    )
    .unwrap();

    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let agent_pid = guard.agent_pid().unwrap();
    let mut conn = connect(&ctx, &ctx.session_id, TOKEN, 0);
    conn.expect_hello_ok();
    let old = conn.collect_until(Duration::from_millis(700), |_| false);
    assert!(
        !old.iter().any(|frame| matches!(
            frame,
            HostFrame::State {
                source: StateSource::Adapter,
                ..
            }
        )),
        "pre-spawn Pi history was replayed as a fresh turn: {old:?}"
    );

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&session_file)
        .unwrap();
    file.write_all(
        b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
    )
    .unwrap();
    file.flush().unwrap();
    let fresh = conn.collect_until(Duration::from_secs(3), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::State {
                    state: AgentState::Idle,
                    source: StateSource::Adapter,
                    evidence: Some(evidence),
                    ..
                } if evidence == "adapter:pi:TurnEnd"
            )
        })
    });
    assert!(fresh.iter().any(|frame| matches!(
        frame,
        HostFrame::State {
            state: AgentState::Idle,
            source: StateSource::Adapter,
            evidence: Some(evidence),
            ..
        } if evidence == "adapter:pi:TurnEnd"
    )));
    let terminal = conn.collect_until(Duration::from_secs(8), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::Exit { reason, group_cleaned: true, .. } if reason == "turn_complete"
            )
        })
    });
    assert!(
        terminal.iter().any(|frame| matches!(
            frame,
            HostFrame::Exit { reason, group_cleaned: true, .. } if reason == "turn_complete"
        )),
        "completed Pi PTY turn did not stop its process group: {terminal:?}"
    );
    assert_eq!(
        guard
            .wait_exit(Duration::from_secs(10))
            .expect("host exits after Pi TurnEnd")
            .code(),
        Some(0)
    );
    assert_eq!(
        kill(Pid::from_raw(-agent_pid), None::<Signal>),
        Err(nix::errno::Errno::ESRCH)
    );
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ctx.dir.join("host-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["exit_reason"], serde_json::json!("turn_complete"));
}

#[test]
fn kimi_wire_end_turn_emits_semantic_completion_after_native_id_capture() {
    const KIMI_ID: &str = "session_b7034202-9ba5-405c-8cca-e9788753dade";
    let ctx = make_kimi_pty_ctx(&format!(
        "while [ ! -f emit-kimi-header ]; do sleep 0.01; done; printf 'Session:   {KIMI_ID}\\r\\nKimi TUI ready\\r\\n'; sleep 60"
    ));
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut conn = connect(&ctx, &ctx.session_id, TOKEN, 0);
    conn.expect_hello_ok();
    std::fs::write(ctx.dir.join("emit-kimi-header"), b"").unwrap();
    let captured = conn.collect_until(Duration::from_secs(3), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::AgentSession { agent_session_id, .. } if agent_session_id == KIMI_ID
            )
        })
    });
    assert!(captured.iter().any(|frame| matches!(
        frame,
        HostFrame::AgentSession { agent_session_id, .. } if agent_session_id == KIMI_ID
    )));

    let kimi_home = ctx.dir.join("kimi-home");
    let native_dir = kimi_home.join("sessions/wd-test").join(KIMI_ID);
    let wire_dir = native_dir.join("agents/main");
    std::fs::create_dir_all(&wire_dir).unwrap();
    let index = serde_json::json!({
        "sessionId": KIMI_ID,
        "sessionDir": native_dir,
        "workDir": ctx.dir,
    });
    std::fs::write(kimi_home.join("session_index.jsonl"), format!("{index}\n")).unwrap();
    std::fs::write(
        wire_dir.join("wire.jsonl"),
        b"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"finishReason\":\"end_turn\"}}\n",
    )
    .unwrap();

    let completed = conn.collect_until(Duration::from_secs(3), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::State {
                    state: AgentState::Idle,
                    source: StateSource::Adapter,
                    evidence: Some(evidence),
                    ..
                } if evidence == "adapter:kimi:TurnEnd"
            )
        })
    });
    assert!(
        completed.iter().any(|frame| matches!(
            frame,
            HostFrame::State {
                state: AgentState::Idle,
                source: StateSource::Adapter,
                evidence: Some(evidence),
                ..
            } if evidence == "adapter:kimi:TurnEnd"
        )),
        "Kimi wire end_turn was not projected: {completed:?}"
    );
}

#[test]
fn pi_rpc_invalid_json_terminates_the_session() {
    let ctx = make_rpc_ctx(
        "while [ ! -f emit-invalid-json ]; do sleep 0.01; done; printf 'not-json\\n'; sleep 60",
    );
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut conn = connect(&ctx, &ctx.session_id, TOKEN, 0);
    conn.expect_hello_ok();
    std::fs::write(ctx.dir.join("emit-invalid-json"), b"").unwrap();
    let frames = conn.collect_until(Duration::from_secs(10), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Exit { reason, .. } if reason == "fault"))
    });
    assert!(frames
        .iter()
        .any(|frame| matches!(frame, HostFrame::Exit { reason, .. } if reason == "fault")));
    assert_eq!(
        guard
            .wait_exit(Duration::from_secs(10))
            .and_then(|status| status.code()),
        Some(0)
    );
}

#[test]
fn new_host_keeps_terminal_output_in_memory_without_creating_output_log() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "printf native-only-output".into()],
        1 << 20,
        vec![],
    );
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut client = connect(&ctx, &ctx.session_id, TOKEN, 1024);
    client.expect_hello_ok();
    let frames = client.collect_until(Duration::from_secs(10), |frames| {
        output_bytes(frames)
            .windows(b"native-only-output".len())
            .any(|window| window == b"native-only-output")
    });
    assert!(
        output_bytes(&frames)
            .windows(b"native-only-output".len())
            .any(|window| window == b"native-only-output"),
        "live terminal output must remain available"
    );
    let _ = guard.wait_exit(Duration::from_secs(10));
    assert!(
        !ctx.log.exists(),
        "new Hosts must not create a duplicate PTY transcript at {}",
        ctx.log.display()
    );
}

#[test]
fn echo_roundtrip_log_sha256() {
    let ctx = make_ctx(vec!["/bin/sh".into()], 1 << 20, vec![]);
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();

    let marker = uniq("hello");
    c.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: format!("echo {marker}\n").into_bytes(),
    });
    let mut frames = c.collect_until(Duration::from_secs(15), |fs| {
        output_bytes(fs)
            .windows(marker.len())
            .any(|w| w == marker.as_bytes())
    });
    assert!(
        output_bytes(&frames)
            .windows(marker.len())
            .any(|w| w == marker.as_bytes()),
        "marker not echoed"
    );

    // Natural child exit: sh leaves, host reports Exit, waits 2s, exits 0.
    c.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"exit\n".to_vec(),
    });
    let rest = c.collect_until(Duration::from_secs(20), |_| false); // read to EOF
    frames.extend(rest);

    assert!(
        offsets_are_contiguous(&frames),
        "output offsets must be contiguous"
    );
    let streamed = output_bytes(&frames);
    assert!(!streamed.is_empty());
    assert!(
        frames.iter().any(|f| matches!(
            f,
            HostFrame::Exit {
                code: Some(0),
                group_cleaned: true,
                ..
            }
        )),
        "expected Exit code=0 group_cleaned"
    );

    let status = guard
        .wait_exit(Duration::from_secs(10))
        .expect("host should exit");
    assert_eq!(status.code(), Some(0));

    assert!(!ctx.log.exists(), "the Host must not persist a duplicate transcript");

    // host-state.json records pgid verification + exit facts.
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ctx.dir.join("host-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["pgid_verified"], serde_json::json!(true));
    assert!(
        state["run_id"].as_str().is_some_and(|id| !id.is_empty()),
        "host-state must identify the concrete run: {state}"
    );
    assert_eq!(state["run_ordinal"], serde_json::json!(1));
    assert_eq!(state["exit_code"], serde_json::json!(0));
    assert_eq!(state["group_cleaned"], serde_json::json!(true));
    assert_eq!(state["exit_reason"], serde_json::json!("natural"));

    // Status events were persisted (process:spawn at minimum).
    let events = std::fs::read_to_string(ctx.dir.join("status-events.jsonl")).unwrap();
    assert!(events.contains("process:spawn"), "events: {events}");
    assert!(!ctx.socket.exists(), "socket removed on shutdown");
}

#[test]
fn terminal_capabilities_are_normalized_for_agent_tui_and_colors() {
    let marker = "TERM=xterm-256color;COLORTERM=truecolor;FORCE_HYPERLINK=1;NO_COLOR=<>";
    let ctx = make_ctx(vec!["/bin/sh".into()], 1 << 20, vec![]);
    let _guard = spawn_host(
        &ctx,
        &[
            ("TERM", "dumb"),
            ("FORCE_HYPERLINK", "0"),
            ("NO_COLOR", "1"),
        ],
    );
    wait_socket(&ctx);
    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    c.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"printf 'TERM=%s;COLORTERM=%s;FORCE_HYPERLINK=%s;NO_COLOR=<%s>\\n' \"$TERM\" \"$COLORTERM\" \"$FORCE_HYPERLINK\" \"${NO_COLOR-}\"\n".to_vec(),
    });
    let frames = c.collect_until(Duration::from_secs(10), |fs| {
        output_bytes(fs)
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes())
    });
    assert!(
        output_bytes(&frames)
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()),
        "the child must receive AgentPort terminal capabilities, got: {}",
        String::from_utf8_lossy(&output_bytes(&frames))
    );
}

#[test]
fn terminal_child_defaults_to_utf8_when_the_desktop_host_has_no_locale() {
    let marker = "CHARMAP=UTF-8";
    let ctx = make_ctx(vec!["/bin/sh".into()], 1 << 20, vec![]);
    let _guard = spawn_host_without_locale(&ctx);
    wait_socket(&ctx);
    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    c.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"printf 'CHARMAP=%s\\n' \"$(locale charmap)\"\n".to_vec(),
    });
    let frames = c.collect_until(Duration::from_secs(10), |fs| {
        output_bytes(fs)
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes())
    });
    assert!(
        output_bytes(&frames)
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()),
        "the child must default to a UTF-8 locale, got: {}",
        String::from_utf8_lossy(&output_bytes(&frames))
    );
}

// ---------------------------------------------------------------------------
// 3. Input isolation: wrong session at handshake and per-frame
// ---------------------------------------------------------------------------

#[test]
fn input_isolation() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    // A second session id at handshake is rejected.
    let mut intruder = connect(&ctx, "ses_intruder", TOKEN, 0);
    assert!(matches!(
        intruder.read1(Duration::from_secs(3)),
        Read1::Frame(HostFrame::Error { .. })
    ));
    assert!(matches!(
        intruder.read1(Duration::from_secs(3)),
        Read1::Closed
    ));

    // A legit client that sends an Input with a foreign session id is dropped.
    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    c.send(&ClientFrame::Input {
        session_id: "ses_intruder".into(),
        data: b"echo pwned\n".to_vec(),
    });
    // Heartbeats are intentionally independent of request handling, so a
    // 1-second tick may legally arrive before the client-specific Error.
    // Consume frames until the identity rejection instead of making this
    // isolation assertion race the realtime heartbeat cadence.
    let rejection = c.collect_until(Duration::from_secs(3), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Error { .. }))
    });
    assert!(matches!(rejection.last(), Some(HostFrame::Error { .. })));
    assert!(matches!(c.read1(Duration::from_secs(3)), Read1::Closed));

    // Host is unaffected: a fresh connection still handshakes.
    let mut c2 = connect(&ctx, &ctx.session_id, TOKEN, 0);
    let (_, alive) = c2.expect_hello_ok();
    assert!(alive);
}

// ---------------------------------------------------------------------------
// 4. Process-group cleanup on Stop (PRD: 停止必须清理完整进程组)
// ---------------------------------------------------------------------------

#[test]
fn process_group_cleanup() {
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "sleep 300 & sleep 300 & wait".into(),
        ],
        1 << 20,
        vec![],
    );
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    wait_for(
        || ctx.dir.join("host-state.json").exists(),
        Duration::from_secs(5),
        "host-state.json",
    );
    let agent_pid = guard.agent_pid().unwrap();
    // pgid == pid, verified by the host at startup.
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ctx.dir.join("host-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["pgid_verified"], serde_json::json!(true));

    // sh + two sleeps live in the agent's process group.
    wait_for(
        || pids_in_group(agent_pid).len() >= 3,
        Duration::from_secs(5),
        "two sleeps in the agent process group",
    );

    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    c.send(&ClientFrame::Stop {
        session_id: ctx.session_id.clone(),
        grace_ms: 2_000,
    });

    let frames = c.collect_until(Duration::from_secs(8), |fs| {
        fs.iter().any(|f| matches!(f, HostFrame::Exit { .. }))
    });
    let exit = frames.iter().find_map(|f| match f {
        HostFrame::Exit {
            code,
            signal,
            group_cleaned,
            ..
        } => Some((*code, *signal, *group_cleaned)),
        _ => None,
    });
    let (_, _, group_cleaned) = exit.expect("Exit frame expected");
    assert!(group_cleaned, "whole process group must be cleaned");

    let status = guard
        .wait_exit(Duration::from_secs(10))
        .expect("host exits after Stop");
    assert_eq!(status.code(), Some(0));

    // kill(pgid, 0) == ESRCH: nothing left in the group.
    assert_eq!(
        kill(Pid::from_raw(-agent_pid), None::<Signal>),
        Err(nix::errno::Errno::ESRCH)
    );
    assert!(pids_in_group(agent_pid).is_empty());

    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ctx.dir.join("host-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["exit_reason"], serde_json::json!("user_stop"));
}

#[test]
fn hook_poller_ignores_events_before_the_run_snapshot() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let hook_path = ctx.dir.join("events.jsonl");
    // This is a fact from the previous run. The new Host snapshots the file
    // before spawning its child and must not report it as live state.
    std::fs::write(&hook_path, b"{\"event\":\"PermissionRequest\"}\n").unwrap();

    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut client = connect(&ctx, &ctx.session_id, TOKEN, 0);
    client.expect_hello_ok();

    let old_frames = client.collect_until(Duration::from_millis(900), |_| false);
    assert!(
        !old_frames.iter().any(|frame| matches!(
            frame,
            HostFrame::State {
                state: AgentState::NeedsInput,
                ..
            }
        )),
        "prior-run hook event was replayed into this run: {old_frames:?}"
    );

    let mut hook = std::fs::OpenOptions::new()
        .append(true)
        .open(&hook_path)
        .unwrap();
    hook.write_all(b"{\"event\":\"PermissionRequest\"}\n")
        .unwrap();
    hook.flush().unwrap();

    let new_frames = client.collect_until(Duration::from_secs(3), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::State {
                    state: AgentState::NeedsInput,
                    ..
                }
            )
        })
    });
    assert!(
        new_frames.iter().any(|frame| matches!(
            frame,
            HostFrame::State {
                state: AgentState::NeedsInput,
                ..
            }
        )),
        "new hook event was not consumed: {new_frames:?}"
    );
}

#[test]
fn hook_poller_updates_a_hint_when_claude_starts_a_new_native_session() {
    const OLD_NATIVE_ID: &str = "3322eb77-e4d5-421c-92a1-aff429b700cf";
    const NEW_NATIVE_ID: &str = "755bfca0-6dac-48ac-9bf9-1b3ccc46acfc";

    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let mut cfg: HostConfig =
        serde_json::from_str(&std::fs::read_to_string(&ctx.cfg_path).unwrap()).unwrap();
    cfg.adapter_type = "claude".into();
    cfg.agent_session_id_hint = Some(OLD_NATIVE_ID.into());
    std::fs::write(&ctx.cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();

    let hook_path = ctx.dir.join("events.jsonl");
    std::fs::write(
        &hook_path,
        format!(
            "{{\"event\":\"SessionStart\",\"session_id\":\"{}\",\"data\":{{\"session_id\":\"{OLD_NATIVE_ID}\",\"source\":\"startup\"}}}}\n",
            ctx.session_id
        ),
    )
    .unwrap();

    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut client = connect(&ctx, &ctx.session_id, TOKEN, 0);
    client.expect_hello_ok();

    let mut hook = std::fs::OpenOptions::new()
        .append(true)
        .open(&hook_path)
        .unwrap();
    writeln!(
        hook,
        "{{\"event\":\"Notification\",\"session_id\":\"{}\",\"data\":{{}}}}",
        ctx.session_id
    )
    .unwrap();
    writeln!(
        hook,
        "{{\"event\":\"SessionStart\",\"session_id\":\"{}\",\"data\":{{\"session_id\":\"{NEW_NATIVE_ID}\",\"source\":\"clear\"}}}}",
        ctx.session_id
    )
    .unwrap();
    hook.flush().unwrap();

    let frames = client.collect_until(Duration::from_secs(3), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::AgentSession { agent_session_id, .. }
                    if agent_session_id == NEW_NATIVE_ID
            )
        })
    });
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            HostFrame::AgentSession { agent_session_id, .. }
                if agent_session_id == NEW_NATIVE_ID
        )),
        "new Claude native session id was not reported: {frames:?}"
    );
    assert!(
        !frames.iter().any(|frame| matches!(
            frame,
            HostFrame::AgentSession { agent_session_id, .. }
                if agent_session_id == &ctx.session_id
        )),
        "AgentPort wrapper id was mistaken for a native session id: {frames:?}"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.dir.join("agent_session_id")).unwrap(),
        NEW_NATIVE_ID
    );
}

// ---------------------------------------------------------------------------
// 4b. Job-control escapees: interactive shells put background jobs into their
// own process groups — Stop must still kill them (PRD: 所有后代进程).
// ---------------------------------------------------------------------------

#[test]
fn job_control_escapee_cleanup() {
    let ctx = make_ctx(vec!["/bin/sh".into()], 1 << 20, vec![]);
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    let tag = uniq("bgpid");
    c.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: format!("sleep 300 & echo {tag}:$!\n").into_bytes(),
    });
    let frames = c.collect_until(Duration::from_secs(8), |fs| {
        let text = String::from_utf8_lossy(&output_bytes(fs)).into_owned();
        // The PTY echo contains `<tag>:$!` — wait for a REAL digit after the tag.
        text.split(&format!("{tag}:")).skip(1).any(|rest| {
            rest.trim_start()
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
        })
    });
    let text = String::from_utf8_lossy(&output_bytes(&frames)).into_owned();
    // PTY echo shows the raw `$!`; the shell's own output has the digits —
    // take the LAST occurrence that parses as a number.
    let bg_pid: i32 = text
        .split(&format!("{tag}:"))
        .skip(1)
        .filter_map(|rest| {
            rest.trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .ok()
        })
        .last()
        .expect("background pid echoed");
    // The background job escaped into its own process group (job control).
    let agent_pid = guard.agent_pid().unwrap();
    assert_ne!(bg_pid, agent_pid);
    assert_eq!(
        kill(Pid::from_raw(bg_pid), None::<Signal>),
        Ok(()),
        "background sleep must be running"
    );

    c.send(&ClientFrame::Stop {
        session_id: ctx.session_id.clone(),
        grace_ms: 2_000,
    });
    let frames = c.collect_until(Duration::from_secs(8), |fs| {
        fs.iter().any(|f| matches!(f, HostFrame::Exit { .. }))
    });
    let group_cleaned = frames
        .iter()
        .find_map(|f| match f {
            HostFrame::Exit { group_cleaned, .. } => Some(*group_cleaned),
            _ => None,
        })
        .expect("Exit frame");
    assert!(group_cleaned, "descendant tree must be fully cleaned");
    assert_eq!(
        kill(Pid::from_raw(bg_pid), None::<Signal>),
        Err(nix::errno::Errno::ESRCH),
        "job-control escapee must be dead after Stop"
    );
    let _ = guard.wait_exit(Duration::from_secs(10));
}

// ---------------------------------------------------------------------------
// 5. Reconnect with tail replay
// ---------------------------------------------------------------------------

#[test]
fn reconnect_replay() {
    let ctx = make_ctx(vec!["/bin/sh".into()], 1 << 20, vec![]);
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let marker = uniq("mark");
    let mut c1 = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c1.expect_hello_ok();
    c1.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: format!("echo {marker}\n").into_bytes(),
    });
    c1.collect_until(Duration::from_secs(10), |fs| {
        output_bytes(fs)
            .windows(marker.len())
            .any(|w| w == marker.as_bytes())
    });
    c1.send(&ClientFrame::Detach {
        session_id: ctx.session_id.clone(),
    });
    // Read until EOF: a heartbeat already in flight before the detach is
    // protocol-legitimate, but the connection must close promptly.
    let mut closed = false;
    for _ in 0..10 {
        if matches!(c1.read1(Duration::from_secs(3)), Read1::Closed) {
            closed = true;
            break;
        }
    }
    assert!(closed, "connection must close after Detach");
    drop(c1);

    // Reconnect asking for an 8 KiB tail replay.
    let mut c2 = connect(&ctx, &ctx.session_id, TOKEN, 8192);
    c2.expect_hello_ok();
    let replay = c2.collect_until(Duration::from_secs(5), |fs| {
        fs.iter().any(|f| matches!(f, HostFrame::ReplayDone { .. }))
    });
    assert!(
        matches!(replay.last(), Some(HostFrame::ReplayDone { .. })),
        "ReplayDone must terminate the replay, got {replay:?}"
    );
    assert!(replay.iter().any(|f| matches!(f, HostFrame::Output { .. })));
    let replayed = output_bytes(&replay);
    assert!(
        replayed
            .windows(marker.len())
            .any(|w| w == marker.as_bytes()),
        "replay must contain earlier output"
    );

    // Live stream continues after ReplayDone.
    let live = uniq("live");
    c2.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: format!("echo {live}\n").into_bytes(),
    });
    let after = c2.collect_until(Duration::from_secs(10), |fs| {
        output_bytes(fs)
            .windows(live.len())
            .any(|w| w == live.as_bytes())
    });
    assert!(
        output_bytes(&after)
            .windows(live.len())
            .any(|w| w == live.as_bytes()),
        "live output after replay"
    );

    // Clean exit.
    c2.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"exit\n".to_vec(),
    });
    let _ = guard.wait_exit(Duration::from_secs(15));
}

#[test]
fn recovery_target_replays_bounded_context_outside_default_tail_window() {
    let ready = "AGENTPORT_REPLAY_READY";
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("read _; yes x | head -c 1048576; printf '{ready}'; sleep 60"),
        ],
        2 * 1024 * 1024,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut monitor = connect_with_output_subscription(&ctx, &ctx.session_id, TOKEN, 0, false);
    monitor.expect_hello_ok();
    monitor.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"start\n".to_vec(),
    });
    let produced = monitor.collect_until(Duration::from_secs(10), |frames| {
        frames.iter().any(|frame| matches!(
            frame,
            HostFrame::Heartbeat { log_bytes, .. }
                if *log_bytes >= 1_048_576 + ready.len() as u64
        ))
    });
    assert!(produced.iter().any(|frame| matches!(
        frame,
        HostFrame::Heartbeat { log_bytes, .. }
            if *log_bytes >= 1_048_576 + ready.len() as u64
    )));
    let mut initial = connect_with_output_subscription(&ctx, &ctx.session_id, TOKEN, 0, false);
    let (_, _, current) = initial.expect_hello_ok_info();
    let target = LogCursor {
        offset: 32,
        ..current
    };
    let mut client = connect_with_recovery_target(&ctx, &ctx.session_id, TOKEN, 1024, target);
    client.expect_hello_ok();
    let frames = client.collect_until(Duration::from_secs(10), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::ReplayDone { .. }))
    });
    let bytes = output_bytes(&frames);
    assert!(
        bytes.len() > 64 * 1024,
        "must not fall back to the 1KiB tail"
    );
    assert!(
        bytes.len() <= 256 * 1024 + 32,
        "recovery context stays bounded"
    );
    assert!(matches!(
        frames.last(),
        Some(HostFrame::ReplayDone {
            partial_context: true,
            ..
        })
    ));
}

#[test]
fn reconnect_resume_serializes_replay_then_live_without_gaps() {
    let script = "sleep 0.2; i=0; while [ $i -lt 600 ]; do printf 'SEQ:%04d\\n' \"$i\"; i=$((i+1)); sleep 0.002; done; sleep 60";
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), script.into()],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let mut first = connect(&ctx, &ctx.session_id, TOKEN, 0);
    first.expect_hello_ok();
    let before_disconnect = first.collect_until(Duration::from_secs(10), |frames| {
        output_bytes(frames)
            .windows(b"SEQ:0050".len())
            .any(|window| window == b"SEQ:0050")
    });
    let resume_from = before_disconnect
        .iter()
        .rev()
        .find_map(|frame| match frame {
            HostFrame::Output { data, cursor, .. } => {
                let mut next = cursor.clone();
                next.offset += data.len() as i64;
                Some(next)
            }
            _ => None,
        })
        .expect("initial connection receives numbered output");
    drop(first); // Simulate a GUI/socket loss, not a graceful Detach.

    let mut resumed = connect_with_resume(
        &ctx,
        &ctx.session_id,
        TOKEN,
        64 * 1024,
        Some(resume_from.clone()),
        true,
    );
    resumed.expect_hello_ok();
    let frames = resumed.collect_until(Duration::from_secs(20), |frames| {
        output_bytes(frames)
            .windows(b"SEQ:0599".len())
            .any(|window| window == b"SEQ:0599")
    });

    assert!(
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::ReplayDone { .. })),
        "resume must delimit replay before live output: {frames:?}"
    );
    let output_frames: Vec<_> = frames
        .iter()
        .filter_map(|frame| match frame {
            HostFrame::Output {
                data,
                offset,
                cursor,
                ..
            } => Some((data, *offset, cursor)),
            _ => None,
        })
        .collect();
    assert_eq!(
        output_frames.first().map(|(_, offset, _)| *offset),
        Some(resume_from.offset as u64),
        "resume must start at the exact requested cursor"
    );
    assert!(offsets_are_contiguous(&frames), "replay + live offsets gap");
    assert!(output_frames
        .iter()
        .all(|(_, _, cursor)| cursor.run_id == resume_from.run_id
            && cursor.run_ordinal == resume_from.run_ordinal
            && cursor.generation == resume_from.generation));

    let bytes = output_bytes(&frames);
    let markers: Vec<u32> = bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            std::str::from_utf8(line)
                .ok()?
                .strip_prefix("SEQ:")?
                .parse()
                .ok()
        })
        .collect();
    assert!(
        markers.len() > 100,
        "expected sustained output after reconnect"
    );
    assert_eq!(markers.last(), Some(&599));
    assert!(
        markers.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "numbered replay/live stream has a missing or duplicate marker: {markers:?}"
    );
}

#[test]
fn invalid_resume_requires_resync_then_bounded_tail() {
    let marker = uniq("resync-tail");
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("printf '{marker}\\n'; sleep 60"),
        ],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut producer = connect(&ctx, &ctx.session_id, TOKEN, 4096);
    producer.expect_hello_ok();
    let produced = producer.collect_until(Duration::from_secs(5), |frames| {
        output_bytes(frames)
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    });
    assert!(
        output_bytes(&produced)
            .windows(marker.len())
            .any(|window| window == marker.as_bytes()),
        "Host must produce the marker before the replay assertion",
    );
    let wrong = LogCursor {
        run_id: "run-from-another-host".into(),
        run_ordinal: 99,
        generation: 7,
        offset: 123,
    };
    let mut client = connect_with_resume(
        &ctx,
        &ctx.session_id,
        TOKEN,
        4096,
        Some(wrong.clone()),
        true,
    );
    let (_, _, current) = client.expect_hello_ok_info();
    let frames = client.collect_until(Duration::from_secs(5), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::ReplayDone { .. }))
    });
    let earliest = match frames.first() {
        Some(HostFrame::ResyncRequired {
            earliest, reason, ..
        }) => {
            assert!(!reason.is_empty());
            earliest
        }
        other => panic!("invalid cursor must lead with ResyncRequired, got {other:?}"),
    };
    assert_eq!(earliest.run_id, current.run_id);
    assert_eq!(earliest.run_ordinal, current.run_ordinal);
    assert_eq!(earliest.generation, current.generation);
    assert_eq!(earliest.offset, 0);
    assert!(
        output_bytes(&frames)
            .windows(marker.len())
            .any(|window| window == marker.as_bytes()),
        "resync must provide the requested bounded tail"
    );
    assert!(matches!(frames.last(), Some(HostFrame::ReplayDone { .. })));

    let mut monitor = connect_with_resume(&ctx, &ctx.session_id, TOKEN, 4096, Some(wrong), false);
    monitor.expect_hello_ok();
    let monitor_frames = monitor.collect_until(Duration::from_secs(2), |_| false);
    assert!(monitor_frames.iter().all(|frame| !matches!(
        frame,
        HostFrame::Output { .. } | HostFrame::ReplayDone { .. } | HostFrame::ResyncRequired { .. }
    )));
}

// ---------------------------------------------------------------------------
// 6. Client drop (GUI crash) does not affect the host
// ---------------------------------------------------------------------------

#[test]
fn client_drop_resilience() {
    let ctx = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    {
        let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
        c.expect_hello_ok();
        // Abrupt drop: no Detach, no reads.
    }

    // Host still alive, child still alive, handshakes still work.
    let mut c2 = connect(&ctx, &ctx.session_id, TOKEN, 0);
    let (_, alive) = c2.expect_hello_ok();
    assert!(alive, "child must survive a client drop");

    // The process-spawn state may race with this new connection, but the
    // wall-clock heartbeat must still arrive even with that queued state.
    let frames = c2.collect_until(Duration::from_secs(3), |frames| {
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Heartbeat { .. }))
    });
    assert!(
        frames
            .iter()
            .any(|frame| matches!(frame, HostFrame::Heartbeat { .. })),
        "expected heartbeat, got {frames:?}"
    );
}

// ---------------------------------------------------------------------------
// 7. Live replay stays bounded without a disk transcript
// ---------------------------------------------------------------------------

#[test]
fn live_replay_tail_is_bounded_to_four_mib() {
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "read _; dd if=/dev/zero bs=1048576 count=5 2>/dev/null; printf 'TAIL-MARKER'; sleep 30".into(),
        ],
        64 * 1024,
        vec![],
    );
    let mut guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);

    let mut monitor = connect_with_output_subscription(&ctx, &ctx.session_id, TOKEN, 0, false);
    monitor.expect_hello_ok();
    monitor.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: b"start\n".to_vec(),
    });
    let frames = monitor.collect_until(Duration::from_secs(20), |frames| {
        frames.iter().any(|frame| matches!(
            frame,
            HostFrame::Heartbeat { log_bytes, .. }
                if *log_bytes >= 5 * 1024 * 1024 + b"TAIL-MARKER".len() as u64
        ))
    });
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            HostFrame::Heartbeat { log_bytes, .. }
                if *log_bytes >= 5 * 1024 * 1024 + b"TAIL-MARKER".len() as u64
        )),
        "Host must observe the complete stream"
    );
    let mut replay = connect(&ctx, &ctx.session_id, TOKEN, 8 * 1024 * 1024);
    replay.expect_hello_ok();
    let replayed = replay.collect_until(Duration::from_secs(10), |frames| {
        frames.iter().any(|frame| matches!(frame, HostFrame::ReplayDone { .. }))
    });
    assert!(output_bytes(&replayed).len() <= 4 * 1024 * 1024);
    assert!(output_bytes(&replayed)
        .windows(b"TAIL-MARKER".len())
        .any(|window| window == b"TAIL-MARKER"));
    assert!(!ctx.log.exists());

    monitor.send(&ClientFrame::Stop {
        session_id: ctx.session_id.clone(),
        grace_ms: 3_000,
    });
    let status = guard
        .wait_exit(Duration::from_secs(15))
        .expect("host exits");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn live_output_does_not_depend_on_log_path() {
    let ctx = make_ctx(vec!["/bin/sh".into()], 64, vec![]);
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut client = connect(&ctx, &ctx.session_id, TOKEN, 0);
    client.expect_hello_ok();
    std::fs::create_dir(&ctx.log).unwrap();
    let marker = uniq("log-failure-live-output");
    client.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: format!("printf '{}%080d\\n' 0\n", marker).into_bytes(),
    });
    let frames = client.collect_until(Duration::from_secs(5), |frames| {
        output_bytes(frames)
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    });

    assert!(
        output_bytes(&frames)
            .windows(marker.len())
            .any(|window| window == marker.as_bytes()),
        "live PTY output must not depend on log persistence: {frames:?}",
    );
}

#[test]
fn reports_and_resumes_a_ctrl_z_suspended_agent() {
    let ready = uniq("suspend-ready");
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("printf '{ready}\\n'; exec sleep 300"),
        ],
        1 << 20,
        vec![],
    );
    let _guard = spawn_host(&ctx, &[]);
    wait_socket(&ctx);
    let mut client = connect(&ctx, &ctx.session_id, TOKEN, 0);
    client.expect_hello_ok();
    client.collect_until(Duration::from_secs(5), |frames| {
        output_bytes(frames)
            .windows(ready.len())
            .any(|window| window == ready.as_bytes())
    });

    client.send(&ClientFrame::Input {
        session_id: ctx.session_id.clone(),
        data: vec![0x1a],
    });
    let stopped = client.collect_until(Duration::from_secs(5), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::ProcessStatus {
                    suspended: true,
                    ..
                }
            )
        })
    });
    assert!(
        stopped.iter().any(|frame| matches!(
            frame,
            HostFrame::ProcessStatus {
                suspended: true,
                ..
            }
        )),
        "Ctrl-Z must surface the stopped process state: {stopped:?}",
    );

    client.send(&ClientFrame::Continue {
        session_id: ctx.session_id.clone(),
    });
    let resumed = client.collect_until(Duration::from_secs(5), |frames| {
        frames.iter().any(|frame| {
            matches!(
                frame,
                HostFrame::ProcessStatus {
                    suspended: false,
                    ..
                }
            )
        })
    });
    assert!(
        resumed.iter().any(|frame| matches!(
            frame,
            HostFrame::ProcessStatus {
                suspended: false,
                ..
            }
        )),
        "SIGCONT must surface the resumed process state: {resumed:?}",
    );
}

// ---------------------------------------------------------------------------
// 8. Secret redaction: secret value never reaches the log
// ---------------------------------------------------------------------------

#[test]
fn secret_redaction() {
    let secret = "supersecret123";
    let ctx = make_ctx(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "echo $AP_TEST_SECRET; sleep 30".into(),
        ],
        1 << 20,
        vec!["AP_TEST_SECRET".into()],
    );
    let mut guard = spawn_host(&ctx, &[("AP_TEST_SECRET", secret)]);
    wait_socket(&ctx);

    let mut c = connect(&ctx, &ctx.session_id, TOKEN, 0);
    c.expect_hello_ok();
    // Give the echo a moment, then stop: finish() flushes the redactor tail.
    let frames = c.collect_until(Duration::from_secs(2), |_| false);
    c.send(&ClientFrame::Stop {
        session_id: ctx.session_id.clone(),
        grace_ms: 3_000,
    });
    let frames2 = c.collect_until(Duration::from_secs(8), |fs| {
        fs.iter().any(|f| matches!(f, HostFrame::Exit { .. }))
    });
    let status = guard
        .wait_exit(Duration::from_secs(10))
        .expect("host exits");
    assert_eq!(status.code(), Some(0));

    assert!(!ctx.log.exists(), "redacted live output must not be persisted");

    // The broadcast stream is redacted too.
    let mut streamed = output_bytes(&frames);
    streamed.extend(output_bytes(&frames2));
    assert!(!streamed
        .windows(secret.len())
        .any(|w| w == secret.as_bytes()));
}

/// Regression: an orderly shutdown must not unlink a socket path that a
/// replacement Host has already rebound. A restart overlaps the old Host's
/// client drain; the old unconditional unlink deleted the successor's
/// directory entry, leaving a live Host permanently unreachable so
/// attach/stop/archive failed with "host is unreachable; stop cannot be
/// verified safely" (the pi-15 incident).
#[test]
fn orderly_shutdown_preserves_rebound_socket() {
    // Host A's agent exits on its own: the natural-exit path sleeps a fixed
    // 2s client drain before shutdown() cleans up the socket. During that
    // window a restart (Host B) rebinds the same stable socket path.
    let ctx_a = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "exit 0".into()],
        1 << 20,
        vec![],
    );
    let stable_socket = ctx_a.socket.clone();
    let mut guard_a = spawn_host(&ctx_a, &[]);
    wait_socket(&ctx_a);

    // The replacement Host: same stable socket path, its own identity.
    let mut ctx_b = make_ctx(
        vec!["/bin/sh".into(), "-c".into(), "sleep 300".into()],
        1 << 20,
        vec![],
    );
    let mut cfg_b: HostConfig =
        serde_json::from_str(&std::fs::read_to_string(&ctx_b.cfg_path).unwrap()).unwrap();
    cfg_b.socket_path = stable_socket.to_string_lossy().into_owned();
    std::fs::write(&ctx_b.cfg_path, serde_json::to_vec(&cfg_b).unwrap()).unwrap();
    ctx_b.socket = stable_socket.clone();
    let guard_b = spawn_host(&ctx_b, &[]);

    // The test only exercises the race when B rebinds while A is still in
    // its 2s drain; the drain is an unconditional sleep and a bind takes
    // milliseconds, so the overlap holds by construction.
    wait_socket(&ctx_b);
    assert!(
        matches!(guard_a.child.as_mut().unwrap().try_wait(), Ok(None)),
        "host A must still be draining when B rebinds the socket"
    );
    assert!(
        guard_a.wait_exit(Duration::from_secs(20)).is_some(),
        "host A finishes its orderly shutdown"
    );

    // A's shutdown must have left B's binding in place: B answers a
    // handshake on the stable path with its own host pid.
    let mut conn = connect(&ctx_b, &ctx_b.session_id, TOKEN, 0);
    let (host_pid, child_alive) = conn.expect_hello_ok();
    assert_eq!(host_pid, guard_b.pid() as u32);
    assert!(child_alive);
    drop(conn);

    // B still removes its own binding on shutdown.
    kill(Pid::from_raw(guard_b.pid()), Signal::SIGTERM).unwrap();
    let mut guard_b = guard_b;
    assert!(guard_b.wait_exit(Duration::from_secs(20)).is_some());
    wait_for(
        || !stable_socket.exists(),
        Duration::from_secs(5),
        "B removes its own socket on shutdown",
    );
}
