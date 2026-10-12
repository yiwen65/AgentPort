//! Connection-local, bounded downloads over pinned descriptors, never path reopens.
use super::{relative_path, Result, SessionFilesError};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const CHUNK_BYTES: usize = 262_144;
const MAX_FILE_BYTES: u64 = 1_073_741_824;
const MAX_HANDLES: usize = 8;
const IDLE_TTL: Duration = Duration::from_secs(300);
const REAP_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenParams {
    pub session_id: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandleParams {
    download_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChunkParams {
    download_id: String,
    offset: u64,
}

#[derive(PartialEq, Eq)]
struct Identity {
    size: u64,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    mtime: (i64, i64),
    #[cfg(unix)]
    ctime: (i64, i64),
}

impl Identity {
    fn read(file: &File) -> Result<Self> {
        let metadata = file.metadata().map_err(super::io_error)?;
        if !metadata.is_file() {
            return Err(SessionFilesError::UnsupportedFile);
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            size: metadata.len(),
            #[cfg(unix)]
            dev: metadata.dev(),
            #[cfg(unix)]
            ino: metadata.ino(),
            #[cfg(unix)]
            mtime: (metadata.mtime(), metadata.mtime_nsec()),
            #[cfg(unix)]
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }
}

struct Download {
    file: File,
    // Keep the Session root pinned for the entire lifetime too.
    _root: File,
    identity: Identity,
    offset: u64,
    eof_sent: bool,
    hash: Sha256,
    touched: Instant,
}

impl Download {
    fn unchanged(&self) -> Result<()> {
        if Identity::read(&self.file)? != self.identity {
            return Err(SessionFilesError::SourceChanged);
        }
        Ok(())
    }

    fn chunk(&mut self, offset: u64) -> Result<Value> {
        self.unchanged()?;
        if offset != self.offset || self.eof_sent {
            return Err(SessionFilesError::InvalidOffset);
        }
        let count = (self.identity.size - self.offset).min(CHUNK_BYTES as u64) as usize;
        let mut bytes = vec![0; count];
        self.file.read_exact(&mut bytes).map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                SessionFilesError::SourceChanged
            } else {
                super::io_error(error)
            }
        })?;
        self.hash.update(&bytes);
        self.offset += count as u64;
        self.eof_sent = self.offset == self.identity.size;
        let result = json!({"offset":offset, "contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes), "eof":self.eof_sent});
        self.unchanged()?;
        Ok(result)
    }
}

type Handles = Mutex<HashMap<String, Download>>;

pub(crate) struct Downloads {
    namespace: String,
    handles: Arc<Handles>,
    reaper: OnceLock<thread::Thread>,
    stopped: Arc<AtomicBool>,
}

impl Default for Downloads {
    fn default() -> Self {
        Self {
            namespace: agentport_core::ids::new_uuid(),
            handles: Arc::new(Mutex::new(HashMap::new())),
            reaper: OnceLock::new(),
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn reap(handles: &mut HashMap<String, Download>, now: Instant) {
    handles.retain(|_, item| now.saturating_duration_since(item.touched) < IDLE_TTL);
}

impl Downloads {
    fn start_reaper(&self) -> Result<()> {
        if self.reaper.get().is_none() {
            let weak = Arc::downgrade(&self.handles);
            let stopped = Arc::clone(&self.stopped);
            let worker = thread::Builder::new()
                .name("session-file-download-reaper".into())
                .spawn(move || loop {
                    thread::park_timeout(REAP_INTERVAL);
                    if stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let Some(handles) = weak.upgrade() else { break };
                    let Ok(mut handles) = handles.lock() else {
                        break;
                    };
                    reap(&mut handles, Instant::now());
                })
                .map_err(|_| SessionFilesError::ReadFailed)?;
            // open holds the registry lock; only one worker can be created.
            let _ = self.reaper.set(worker.thread().clone());
        }
        Ok(())
    }

    fn valid_id(&self, id: &str) -> bool {
        let Some(token) = id.strip_prefix(&format!("download_{}_", self.namespace)) else {
            return false;
        };
        token.len() == 36
            && token.bytes().enumerate().all(|(index, ch)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    ch == b'-'
                } else {
                    ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch)
                }
            })
    }

    pub(crate) fn open(&self, cwd: &str, path: &str) -> Result<Value> {
        let relative = relative_path(path)?;
        let name = relative
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(SessionFilesError::InvalidPath)?
            .to_owned();
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| SessionFilesError::ReadFailed)?;
        reap(&mut handles, Instant::now());
        if handles.len() >= MAX_HANDLES {
            return Err(SessionFilesError::TooManyDownloads);
        }
        #[cfg(not(unix))]
        {
            let _ = (cwd, relative, name);
            Err(SessionFilesError::UnsupportedPlatform)
        }
        #[cfg(unix)]
        {
            let (file, root) = super::secure::open_download(cwd, &relative)?;
            let identity = Identity::read(&file)?;
            let size = identity.size;
            if size > MAX_FILE_BYTES {
                return Err(SessionFilesError::FileTooLarge);
            }
            self.start_reaper()?;
            let id = format!(
                "download_{}_{}",
                self.namespace,
                agentport_core::ids::new_uuid()
            );
            handles.insert(
                id.clone(),
                Download {
                    file,
                    _root: root,
                    identity,
                    offset: 0,
                    eof_sent: false,
                    hash: Sha256::new(),
                    touched: Instant::now(),
                },
            );
            Ok(json!({"downloadId":id, "name":name, "sizeBytes":size, "chunkBytes":CHUNK_BYTES}))
        }
    }

    pub(crate) fn execute(&self, method: &str, params: Value) -> Result<Value> {
        let (id, offset) = if method == "session.files.download.chunk" {
            let params: ChunkParams =
                serde_json::from_value(params).map_err(|_| SessionFilesError::InvalidOffset)?;
            (params.download_id, Some(params.offset))
        } else {
            let params: HandleParams =
                serde_json::from_value(params).map_err(|_| SessionFilesError::InvalidDownload)?;
            (params.download_id, None)
        };
        if !self.valid_id(&id) {
            return Err(SessionFilesError::InvalidDownload);
        }
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| SessionFilesError::ReadFailed)?;
        reap(&mut handles, Instant::now());
        if method == "session.files.download.close" {
            handles.remove(&id);
            return Ok(json!({"closed":true}));
        }
        let item = handles
            .get_mut(&id)
            .ok_or(SessionFilesError::InvalidDownload)?;
        item.touched = Instant::now();
        let result = if let Some(offset) = offset {
            item.chunk(offset)
        } else {
            item.unchanged().and_then(|_| {
                if item.offset != item.identity.size {
                    Err(SessionFilesError::IncompleteDownload)
                } else {
                    let result = json!({"sizeBytes":item.identity.size, "sha256":format!("{:x}", item.hash.clone().finalize())});
                    item.unchanged()?;
                    Ok(result)
                }
            })
        };
        // Offset and premature finish errors are recoverable; failures after
        // reads are not (the descriptor cursor may already have advanced).
        if (offset.is_none() && result.is_ok())
            || matches!(&result, Err(error) if !matches!(error, SessionFilesError::InvalidOffset | SessionFilesError::IncompleteDownload))
        {
            handles.remove(&id);
        }
        result
    }
}

impl Drop for Downloads {
    fn drop(&mut self) {
        // Handles drop with this service; wake the weak reaper so it exits now.
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.reaper.get() {
            worker.unpark();
        }
    }
}

#[cfg(all(test, unix))]
#[path = "session_file_downloads_tests.rs"]
mod tests;
