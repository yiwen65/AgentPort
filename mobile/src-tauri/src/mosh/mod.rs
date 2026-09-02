pub(crate) mod bootstrap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void, CString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
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
    ip: String,
    port: u16,
    key: Zeroizing<String>,
    cols: u16,
    rows: u16,
    #[serde(default = "default_prediction_mode")]
    prediction_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshInputRequest {
    session_id: String,
    data_base64: Zeroizing<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshResizeRequest {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoshStartResult {
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoshPollResult {
    data_base64: String,
    running: bool,
    exit_code: Option<i32>,
}

fn default_prediction_mode() -> String {
    "adaptive".into()
}

struct SharedWinsize(Box<libc::winsize>);

// The pinned Blink Mosh bridge intentionally accepts a winsize pointer that
// its event-loop thread reads after SIGWINCH. We update it before signalling
// that same thread and keep the allocation stable until the Session is dropped.
unsafe impl Send for SharedWinsize {}
unsafe impl Sync for SharedWinsize {}

struct MoshOutput {
    receiver: Receiver<Vec<u8>>,
    pending: VecDeque<u8>,
    disconnected: bool,
}

struct MoshSession {
    input: Mutex<File>,
    output: Mutex<MoshOutput>,
    winsize: Mutex<SharedWinsize>,
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
        if let Ok(sessions) = self.sessions.get_mut() {
            for session in sessions.values() {
                unsafe {
                    libc::pthread_kill(session.native_thread, libc::SIGTERM);
                }
            }
            sessions.clear();
        }
    }
}

type StateCallback = unsafe extern "C" fn(*const c_void, *const c_void, usize);
type MoshMain = unsafe extern "C" fn(
    *mut libc::FILE,
    *mut libc::FILE,
    *mut libc::winsize,
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
    #[link_name = "mosh_main"]
    fn linked_mosh_main(
        input: *mut libc::FILE,
        output: *mut libc::FILE,
        winsize: *mut libc::winsize,
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

    let mut winsize = SharedWinsize(Box::new(libc::winsize {
        ws_row: request.rows,
        ws_col: request.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }));
    let winsize_ptr = (&mut *winsize.0) as *mut libc::winsize as usize;
    let exit_code = Arc::new(Mutex::new(None));
    let thread_exit = exit_code.clone();
    let (thread_tx, thread_rx) = mpsc::sync_channel(1);
    let native_join = std::thread::spawn(move || unsafe {
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
            winsize_ptr as *mut libc::winsize,
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
            winsize: Mutex::new(winsize),
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
    {
        let mut winsize = session
            .winsize
            .lock()
            .map_err(|_| "Mosh resize state is unavailable")?;
        winsize.0.ws_col = request.cols;
        winsize.0.ws_row = request.rows;
    }
    if unsafe { libc::pthread_kill(session.native_thread, libc::SIGWINCH) } != 0 {
        return Err("Mosh resize failed".into());
    }
    Ok(())
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
        running: exit_code.is_none(),
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
    if session
        .exit_code
        .lock()
        .map_err(|_| "Mosh exit state is unavailable")?
        .is_some()
    {
        return Ok(());
    }
    if unsafe { libc::pthread_kill(session.native_thread, libc::SIGTERM) } != 0 {
        // The native thread may have exited between the check and signal.
        if session
            .exit_code
            .lock()
            .map_err(|_| "Mosh exit state is unavailable")?
            .is_some()
        {
            return Ok(());
        }
        return Err("Mosh stop failed".into());
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
