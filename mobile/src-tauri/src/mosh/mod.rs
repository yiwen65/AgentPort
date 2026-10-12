pub(crate) mod bootstrap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void, CString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use tauri::State;
use zeroize::Zeroizing;

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_POLL_BYTES: usize = 256 * 1024;
const MAX_CONCURRENT_SESSIONS: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshStartRequest {
    pub(crate) ip: String,
    pub(crate) port: u16,
    pub(crate) key: Zeroizing<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    #[serde(default = "default_prediction_mode")]
    pub(crate) prediction_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshInputRequest {
    pub(crate) session_id: String,
    pub(crate) data_base64: Zeroizing<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshResizeRequest {
    pub(crate) session_id: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoshStartResult {
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoshPollResult {
    pub(crate) data_base64: String,
    pub(crate) running: bool,
    exit_code: Option<i32>,
}

fn default_prediction_mode() -> String {
    "adaptive".into()
}

// Versioned native ABI reads a packed atomic snapshot into event-loop-owned
// winsize storage. No plain winsize pointer is shared across threads.
fn packed_size(cols: u16, rows: u16) -> u32 {
    ((cols as u32) << 16) | rows as u32
}

// Block before publishing pthread_self. Select installs its process handler
// later, then pselect's empty mask safely delivers any queued early stop.
fn block_native_signals() -> Result<(), String> {
    unsafe {
        let mut signals: libc::sigset_t = std::mem::zeroed();
        if libc::sigemptyset(&mut signals) != 0
            || libc::sigaddset(&mut signals, libc::SIGTERM) != 0
            || libc::sigaddset(&mut signals, libc::SIGWINCH) != 0
            || libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut()) != 0
        {
            return Err("Mosh thread signal setup failed".into());
        }
    }
    Ok(())
}

struct MoshOutput {
    receiver: Receiver<Vec<u8>>,
    pending: VecDeque<u8>,
    disconnected: bool,
}

struct MoshSession {
    input: Mutex<File>,
    output: Mutex<MoshOutput>,
    winsize: Box<AtomicU32>,
    native_thread: libc::pthread_t,
    exit_code: Arc<Mutex<Option<i32>>>,
    native_join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Default)]
pub struct MoshSessions {
    sessions: Mutex<HashMap<String, Arc<MoshSession>>>,
}

impl Drop for MoshSessions {
    fn drop(&mut self) {
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, session) in sessions.drain() {
            retire_session(session);
        }
    }
}

type StateCallback = unsafe extern "C" fn(*const c_void, *const c_void, usize);
type MoshMain = unsafe extern "C" fn(
    *mut libc::FILE,
    *mut libc::FILE,
    *const u32,
    Option<StateCallback>,
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    usize,
    *const c_char,
) -> c_int;

#[cfg(any(target_os = "ios", target_os = "android"))]
unsafe extern "C" {
    #[link_name = "agentport_mosh_main_v2"]
    fn linked_mosh_main(
        input: *mut libc::FILE,
        output: *mut libc::FILE,
        winsize: *const u32,
        state_callback: Option<StateCallback>,
        state_callback_context: *mut c_void,
        ip: *const c_char,
        port: *const c_char,
        key: *const c_char,
        prediction_mode: *const c_char,
        encoded_state: *const c_char,
        encoded_state_size: usize,
        prediction_overwrite: *const c_char,
    ) -> c_int;
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn load_mosh_main() -> Result<MoshMain, String> {
    Ok(linked_mosh_main)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn load_mosh_main() -> Result<MoshMain, String> {
    Err("Mosh requires an iOS or Android runtime".into())
}

fn validate_start(request: &MoshStartRequest) -> Result<(), String> {
    if request.ip.trim().is_empty() || request.ip.len() > 255 || request.ip.bytes().any(|b| b == 0)
    {
        return Err("invalid Mosh target address".into());
    }
    if request.port == 0 {
        return Err("invalid Mosh UDP port".into());
    }
    if request.key.is_empty() || request.key.len() > 256 || request.key.bytes().any(|b| b == 0) {
        return Err("invalid Mosh session key".into());
    }
    if !(1..=500).contains(&request.cols) || !(1..=500).contains(&request.rows) {
        return Err("invalid terminal size".into());
    }
    if !matches!(
        request.prediction_mode.as_str(),
        "adaptive" | "always" | "never" | "experimental"
    ) {
        return Err("invalid Mosh prediction mode".into());
    }
    Ok(())
}

fn pipe_pair() -> Result<(File, c_int), String> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err("Mosh pipe setup failed".into());
    }
    Ok((unsafe { File::from_raw_fd(fds[1]) }, fds[0]))
}

fn output_pipe_pair() -> Result<(c_int, File), String> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err("Mosh pipe setup failed".into());
    }
    Ok((fds[1], unsafe { File::from_raw_fd(fds[0]) }))
}

fn reap_exited_sessions(session_map: &mut HashMap<String, Arc<MoshSession>>) {
    if session_map.len() < MAX_CONCURRENT_SESSIONS {
        return;
    }
    let exited = session_map
        .iter()
        .filter_map(|(id, session)| {
            session
                .exit_code
                .lock()
                .ok()
                .and_then(|code| code.is_some().then(|| id.clone()))
        })
        .collect::<Vec<_>>();
    for id in exited {
        if let Some(session) = session_map.remove(&id) {
            if let Ok(mut native_join) = session.native_join.lock() {
                if let Some(join) = native_join.take() {
                    let _ = join.join();
                }
            }
        }
    }
}

#[tauri::command]
pub fn mobile_mosh_start(
    sessions: State<'_, MoshSessions>,
    request: MoshStartRequest,
) -> Result<MoshStartResult, String> {
    validate_start(&request)?;
    let mut session_map = sessions
        .sessions
        .lock()
        .map_err(|_| "Mosh session state is unavailable")?;
    // A caller may abandon an exited Session without a final poll. Reap only
    // under cap pressure so normal final-output polling remains lossless while
    // stale entries cannot permanently consume all native Session slots.
    reap_exited_sessions(&mut session_map);
    if session_map.len() >= MAX_CONCURRENT_SESSIONS {
        return Err("too many concurrent Mosh sessions".into());
    }
    let mosh_main = load_mosh_main()?;
    let ip = CString::new(request.ip.as_str()).map_err(|_| "invalid Mosh target address")?;
    let port = CString::new(request.port.to_string()).unwrap();
    let key = CString::new(request.key.as_str()).map_err(|_| "invalid Mosh session key")?;
    let prediction = CString::new(request.prediction_mode.as_str()).unwrap();
    let empty = CString::new("").unwrap();
    let overwrite = CString::new("no").unwrap();

    let (input_writer, input_reader_fd) = pipe_pair()?;
    let (output_writer_fd, mut output_reader) = output_pipe_pair()?;
    let (output_tx, output_rx) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match output_reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if output_tx.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let winsize = Box::new(AtomicU32::new(packed_size(request.cols, request.rows)));
    let winsize_ptr = (&*winsize) as *const AtomicU32 as usize;
    let exit_code = Arc::new(Mutex::new(None));
    let thread_exit = exit_code.clone();
    let (thread_tx, thread_rx) = mpsc::sync_channel(1);
    let native_join = std::thread::spawn(move || unsafe {
        if block_native_signals().is_err() {
            libc::close(input_reader_fd);
            libc::close(output_writer_fd);
            *thread_exit.lock().unwrap() = Some(1);
            return;
        }
        let native_thread = libc::pthread_self();
        let _ = thread_tx.send(native_thread);
        let input = libc::fdopen(input_reader_fd, c"r".as_ptr());
        let output = libc::fdopen(output_writer_fd, c"w".as_ptr());
        if input.is_null() || output.is_null() {
            if !input.is_null() {
                libc::fclose(input);
            } else {
                libc::close(input_reader_fd);
            }
            if !output.is_null() {
                libc::fclose(output);
            } else {
                libc::close(output_writer_fd);
            }
            *thread_exit.lock().unwrap() = Some(1);
            return;
        }
        libc::setvbuf(output, std::ptr::null_mut(), libc::_IONBF, 0);
        let code = mosh_main(
            input,
            output,
            winsize_ptr as *const u32,
            None,
            std::ptr::null_mut(),
            ip.as_ptr(),
            port.as_ptr(),
            key.as_ptr(),
            prediction.as_ptr(),
            empty.as_ptr(),
            0,
            overwrite.as_ptr(),
        );
        libc::fclose(input);
        libc::fclose(output);
        *thread_exit.lock().unwrap() = Some(code);
    });
    let native_thread = thread_rx
        .recv()
        .map_err(|_| "Mosh native thread failed to start")?;
    let session_id = format!("mosh_{}", uuid::Uuid::new_v4().simple());
    session_map.insert(
        session_id.clone(),
        Arc::new(MoshSession {
            input: Mutex::new(input_writer),
            output: Mutex::new(MoshOutput {
                receiver: output_rx,
                pending: VecDeque::new(),
                disconnected: false,
            }),
            winsize,
            native_thread,
            exit_code,
            native_join: Mutex::new(Some(native_join)),
        }),
    );
    Ok(MoshStartResult { session_id })
}

fn session(sessions: &MoshSessions, session_id: &str) -> Result<Arc<MoshSession>, String> {
    sessions
        .sessions
        .lock()
        .map_err(|_| "Mosh session state is unavailable")?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Mosh session was not found".into())
}

#[tauri::command]
pub fn mobile_mosh_input(
    sessions: State<'_, MoshSessions>,
    request: MoshInputRequest,
) -> Result<(), String> {
    let data = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(request.data_base64.as_bytes())
            .map_err(|_| "invalid Mosh input encoding")?,
    );
    if data.is_empty() || data.len() > MAX_INPUT_BYTES {
        return Err("Mosh input length is invalid".into());
    }
    session(&sessions, &request.session_id)?
        .input
        .lock()
        .map_err(|_| "Mosh input is unavailable")?
        .write_all(&data)
        .map_err(|_| "Mosh input failed".into())
}

#[tauri::command]
pub fn mobile_mosh_resize(
    sessions: State<'_, MoshSessions>,
    request: MoshResizeRequest,
) -> Result<(), String> {
    if !(1..=500).contains(&request.cols) || !(1..=500).contains(&request.rows) {
        return Err("invalid terminal size".into());
    }
    let session = session(&sessions, &request.session_id)?;
    session
        .winsize
        .store(packed_size(request.cols, request.rows), Ordering::Release);
    if !signal_native(&session, libc::SIGWINCH)? {
        return Err("Mosh session has exited".into());
    }
    Ok(())
}

// Joining releases pthread_t for reuse. Every signal holds the same lock as
// every join, so an in-flight resize/stop can never target a reaped thread ID.
fn signal_native(session: &MoshSession, signal: c_int) -> Result<bool, String> {
    let join = session
        .native_join
        .lock()
        .map_err(|_| "Mosh thread state is unavailable")?;
    let exited = session
        .exit_code
        .lock()
        .map_err(|_| "Mosh exit state is unavailable")?;
    if join.is_none() || exited.is_some() {
        return Ok(false);
    }
    if unsafe { libc::pthread_kill(session.native_thread, signal) } != 0 {
        return Err("Mosh signal delivery failed".into());
    }
    Ok(true)
}

fn drain_output(state: &mut MoshOutput, cap: usize) -> Vec<u8> {
    let mut output = Vec::new();
    while output.len() < cap {
        while output.len() < cap {
            let Some(byte) = state.pending.pop_front() else {
                break;
            };
            output.push(byte);
        }
        if output.len() == cap {
            break;
        }
        match state.receiver.try_recv() {
            Ok(chunk) => state.pending.extend(chunk),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                state.disconnected = true;
                break;
            }
        }
    }
    output
}

fn output_running(exit_code: Option<i32>, drained: bool) -> bool {
    exit_code.is_none() || !drained
}

#[tauri::command]
pub fn mobile_mosh_poll(
    sessions: State<'_, MoshSessions>,
    session_id: String,
) -> Result<MoshPollResult, String> {
    let session = session(&sessions, &session_id)?;
    let mut state = session
        .output
        .lock()
        .map_err(|_| "Mosh output is unavailable")?;
    let output = drain_output(&mut state, MAX_POLL_BYTES);
    let drained = state.disconnected && state.pending.is_empty();
    drop(state);
    let exit_code = *session
        .exit_code
        .lock()
        .map_err(|_| "Mosh exit state is unavailable")?;
    let result = MoshPollResult {
        data_base64: base64::engine::general_purpose::STANDARD.encode(output),
        // The consumer must keep polling after exit until final bytes drain.
        running: output_running(exit_code, drained),
        exit_code,
    };
    if exit_code.is_some() && drained {
        sessions
            .sessions
            .lock()
            .map_err(|_| "Mosh session state is unavailable")?
            .remove(&session_id);
        if let Some(join) = session
            .native_join
            .lock()
            .map_err(|_| "Mosh native thread state is unavailable")?
            .take()
        {
            let _ = join.join();
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn mobile_mosh_stop(
    sessions: State<'_, MoshSessions>,
    session_id: String,
) -> Result<(), String> {
    let session = session(&sessions, &session_id)?;
    signal_native(&session, libc::SIGTERM)?;
    Ok(())
}

/// Every ownership exit retains the allocation until the native thread stops.
/// Discarding output keeps its pipe writer from preventing shutdown.
fn retire_session(session: Arc<MoshSession>) {
    let _ = signal_native(&session, libc::SIGTERM);
    std::thread::spawn(move || {
        loop {
            if let Ok(mut output) = session.output.lock() {
                let _ = drain_output(&mut output, MAX_POLL_BYTES);
            }
            if session
                .exit_code
                .lock()
                .map(|code| code.is_some())
                .unwrap_or(false)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if let Ok(mut join) = session.native_join.lock() {
            if let Some(join) = join.take() {
                let _ = join.join();
            }
        }
    });
}

/// Generic close is idempotent after polling already reaped a native session.
pub(crate) fn discard_after_stop(sessions: &MoshSessions, id: &str) -> Result<(), String> {
    let removed = sessions
        .sessions
        .lock()
        .map_err(|_| "Mosh session state is unavailable")?
        .remove(id);
    if let Some(session) = removed {
        retire_session(session);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_start() -> MoshStartRequest {
        MoshStartRequest {
            ip: "127.0.0.1".into(),
            port: 60_001,
            key: Zeroizing::new("0123456789012345678901".into()),
            cols: 80,
            rows: 24,
            prediction_mode: "adaptive".into(),
        }
    }

    #[test]
    fn reaped_thread_ids_are_never_signalled() {
        let (input, reader) = pipe_pair().unwrap();
        unsafe {
            libc::close(reader);
        }
        let (_tx, receiver) = mpsc::sync_channel(1);
        let session = MoshSession {
            input: Mutex::new(input),
            output: Mutex::new(MoshOutput {
                receiver,
                pending: VecDeque::new(),
                disconnected: false,
            }),
            winsize: Box::new(AtomicU32::new(packed_size(80, 24))),
            native_thread: unsafe { libc::pthread_self() },
            // Even an unavailable exit status must not make a joined ID usable.
            exit_code: Arc::new(Mutex::new(None)),
            native_join: Mutex::new(None),
        };
        assert!(!signal_native(&session, libc::SIGWINCH).unwrap());
        *session.exit_code.lock().unwrap() = Some(0);
        assert!(!signal_native(&session, libc::SIGTERM).unwrap());
    }

    #[test]
    fn startup_cancel_and_store_drop_retain_size_until_join() {
        const CHILD: &str = "AGENTPORT_MOSH_EARLY_CANCEL_CHILD";
        if std::env::var_os(CHILD).is_none() {
            // A regression in the startup signal mask must not kill the suite.
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "mosh::tests::startup_cancel_and_store_drop_retain_size_until_join",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(status.success(), "early-cancel subprocess failed: {status}");
            return;
        }
        let winsize = Box::new(AtomicU32::new(packed_size(80, 24)));
        let pointer = (&*winsize) as *const AtomicU32 as usize;
        let exit_code = Arc::new(Mutex::new(None));
        let exit = exit_code.clone();
        let (publish, published) = mpsc::sync_channel(1);
        let (observed, observation) = mpsc::sync_channel(1);
        let (finish, finished) = mpsc::sync_channel(1);
        let join = std::thread::spawn(move || {
            block_native_signals().unwrap();
            publish.send(unsafe { libc::pthread_self() }).unwrap();
            // Model mosh_main startup before Select installs its handlers.
            std::thread::sleep(std::time::Duration::from_millis(30));
            assert_eq!(
                unsafe { (*(pointer as *const AtomicU32)).load(Ordering::Acquire) },
                packed_size(80, 24)
            );
            unsafe {
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut mask);
                libc::sigaddset(&mut mask, libc::SIGTERM);
                let mut signal = 0;
                assert_eq!(libc::sigwait(&mask, &mut signal), 0);
                assert_eq!(signal, libc::SIGTERM);
            }
            *exit.lock().unwrap() = Some(0);
            observed.send(()).unwrap();
            // Exit status alone is not proof the pointer may be freed: the
            // retaining reaper must join before releasing its final Arc.
            finished.recv().unwrap();
        });
        let native_thread = published.recv().unwrap();
        let (_output_tx, receiver) = mpsc::channel();
        let session = Arc::new(MoshSession {
            input: Mutex::new(
                std::fs::File::options()
                    .write(true)
                    .open("/dev/null")
                    .unwrap(),
            ),
            output: Mutex::new(MoshOutput {
                receiver,
                pending: VecDeque::new(),
                disconnected: false,
            }),
            winsize,
            native_thread,
            exit_code,
            native_join: Mutex::new(Some(join)),
        });
        let weak = Arc::downgrade(&session);
        let sessions = MoshSessions::default();
        sessions
            .sessions
            .lock()
            .unwrap()
            .insert("fixture".into(), session);
        drop(sessions); // sends early TERM; frees map but must retain allocation
        observation
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(weak.upgrade().is_some(), "pointer freed before native join");
        finish.send(()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while weak.upgrade().is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            weak.upgrade().is_none(),
            "retaining reaper did not finish join"
        );
    }

    #[test]
    fn abandoning_an_already_reaped_mosh_session_is_idempotent() {
        discard_after_stop(&MoshSessions::default(), "already-reaped").unwrap();
    }

    #[test]
    fn exited_output_remains_running_until_all_bytes_drain() {
        let (tx, receiver) = mpsc::channel();
        let expected = vec![0xff; MAX_POLL_BYTES + 123];
        tx.send(expected.clone()).unwrap();
        drop(tx);
        let mut output = MoshOutput {
            receiver,
            pending: VecDeque::new(),
            disconnected: false,
        };
        let mut data = drain_output(&mut output, MAX_POLL_BYTES);
        assert_eq!(data.len(), MAX_POLL_BYTES);
        assert!(output_running(
            Some(0),
            output.disconnected && output.pending.is_empty()
        ));
        data.extend(drain_output(&mut output, MAX_POLL_BYTES));
        assert_eq!(data, expected);
        assert!(!output_running(
            Some(0),
            output.disconnected && output.pending.is_empty()
        ));
    }

    #[test]
    fn start_contract_rejects_unsafe_or_unbounded_values() {
        assert!(validate_start(&valid_start()).is_ok());
        let mut invalid = valid_start();
        invalid.ip.clear();
        assert!(validate_start(&invalid).is_err());
        let mut invalid = valid_start();
        invalid.rows = 0;
        assert!(validate_start(&invalid).is_err());
        let mut invalid = valid_start();
        invalid.prediction_mode = "magic".into();
        assert!(validate_start(&invalid).is_err());
    }

    #[test]
    fn bounded_poll_preserves_the_remainder_for_the_next_poll() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(vec![1, 2, 3, 4, 5]).unwrap();
        drop(sender);
        let mut state = MoshOutput {
            receiver,
            pending: VecDeque::new(),
            disconnected: false,
        };

        assert_eq!(drain_output(&mut state, 3), vec![1, 2, 3]);
        assert_eq!(drain_output(&mut state, 3), vec![4, 5]);
        assert!(state.disconnected);
        assert!(drain_output(&mut state, 3).is_empty());
    }
}
