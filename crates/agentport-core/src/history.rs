//! Read-only access to agent-owned native conversation transcripts.
//!
//! AgentPort deliberately does not copy message bodies into its database or
//! an auxiliary index.  A `NativeHistory` request resolves the provider's
//! canonical JSONL files, streams them from an opaque byte cursor and returns
//! normalized events.  The cursor contains only source identity and offsets.

use crate::error::{CoreError, Result};
use crate::models::{AgentType, Session};
use crate::paths::AppPaths;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_HISTORY_PAGE_SIZE: usize = 200;
pub const MAX_HISTORY_PAGE_SIZE: usize = 1_000;
pub(crate) const MAX_NATIVE_SOURCES: usize = 64;
pub(crate) const MAX_DISCOVERY_FILES: usize = 20_000;
const MAX_JSONL_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    pub source_id: String,
    pub provider: AgentType,
    pub kind: String,
    pub role: Option<HistoryRole>,
    pub timestamp: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceInfo {
    pub id: String,
    pub provider: AgentType,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HistorySourceStatus {
    Available { sources: Vec<HistorySourceInfo> },
    Unavailable { reason: String },
    Ambiguous { reason: String, candidates: usize },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub source_status: HistorySourceStatus,
    pub events: Vec<HistoryEvent>,
    pub next_cursor: Option<String>,
    pub skipped_lines: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchHit {
    pub session_id: String,
    pub event: HistoryEvent,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResult {
    pub source_status: HistorySourceStatus,
    pub hits: Vec<HistorySearchHit>,
    pub total_hits: usize,
    /// True when a bounded caller stopped after filling its display cap.
    pub partial: bool,
}

#[derive(Debug, Clone)]
struct NativeSource {
    id: String,
    path: PathBuf,
    provider: AgentType,
}

impl NativeSource {
    fn info(&self) -> HistorySourceInfo {
        HistorySourceInfo {
            id: self.id.clone(),
            provider: self.provider,
            path: self.path.to_string_lossy().into_owned(),
            bytes: fs::metadata(&self.path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PageCursor {
    source: usize,
    offset: u64,
    source_id: String,
}

#[derive(Debug)]
enum Resolution {
    Available(Vec<NativeSource>),
    Unavailable(String),
    Ambiguous(String, usize),
}

pub struct NativeHistory<'a> {
    paths: &'a AppPaths,
    codex_files: OnceCell<Vec<PathBuf>>,
    kimi_index: OnceCell<Vec<Value>>,
}

impl<'a> NativeHistory<'a> {
    pub fn new(paths: &'a AppPaths) -> Self {
        Self {
            paths,
            codex_files: OnceCell::new(),
            kimi_index: OnceCell::new(),
        }
    }

    pub fn source_status(&self, session: &Session) -> HistorySourceStatus {
        match self.resolve(session) {
            Resolution::Available(sources) => HistorySourceStatus::Available {
                sources: sources.iter().map(NativeSource::info).collect(),
            },
            Resolution::Unavailable(reason) => HistorySourceStatus::Unavailable { reason },
            Resolution::Ambiguous(reason, candidates) => {
                HistorySourceStatus::Ambiguous { reason, candidates }
            }
        }
    }

    pub fn page(
        &self,
        session: &Session,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<HistoryPage> {
        let sources = match self.resolve(session) {
            Resolution::Available(sources) => sources,
            Resolution::Unavailable(reason) => {
                return Ok(HistoryPage {
                    source_status: HistorySourceStatus::Unavailable { reason },
                    events: Vec::new(),
                    next_cursor: None,
                    skipped_lines: 0,
                })
            }
            Resolution::Ambiguous(reason, candidates) => {
                return Ok(HistoryPage {
                    source_status: HistorySourceStatus::Ambiguous { reason, candidates },
                    events: Vec::new(),
                    next_cursor: None,
                    skipped_lines: 0,
                })
            }
        };
        let status = HistorySourceStatus::Available {
            sources: sources.iter().map(NativeSource::info).collect(),
        };
        let mut cursor = match cursor {
            Some(encoded) => decode_cursor(encoded)?,
            None => {
                let source = sources.len().saturating_sub(1);
                PageCursor {
                    source,
                    offset: sources
                        .get(source)
                        .and_then(|source| fs::metadata(&source.path).ok())
                        .map(|metadata| metadata.len())
                        .unwrap_or(0),
                    source_id: sources
                        .get(source)
                        .map(|source| source.id.clone())
                        .unwrap_or_default(),
                }
            }
        };
        let limit = limit.clamp(1, MAX_HISTORY_PAGE_SIZE);
        let mut events = Vec::with_capacity(limit.min(DEFAULT_HISTORY_PAGE_SIZE));
        let mut skipped_lines = 0u64;
        let mut line = Vec::new();
        let mut reverse_scan = vec![0u8; REVERSE_SCAN_BYTES];

        while cursor.source < sources.len() && events.len() < limit {
            let source = &sources[cursor.source];
            if cursor.source_id != source.id {
                return Err(CoreError::Conflict(
                    "native history cursor no longer names the resolved source".into(),
                ));
            }
            let mut file = File::open(&source.path)?;
            let len = file.metadata()?.len();
            if cursor.offset > len {
                return Err(CoreError::Conflict(
                    "native history source was truncated after the cursor was issued".into(),
                ));
            }
            while cursor.offset > 0 && events.len() < limit {
                let Some(record) = read_bounded_jsonl_line_before(
                    &mut file,
                    cursor.offset,
                    &mut line,
                    &mut reverse_scan,
                )?
                else {
                    cursor.offset = 0;
                    break;
                };
                cursor.offset = record.start;
                if record.oversized {
                    skipped_lines += 1;
                    continue;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                    skipped_lines += 1;
                    continue;
                };
                if let Some(event) = normalize_event(source, record.end, &value) {
                    events.push(event);
                }
            }
            if events.len() == limit {
                break;
            }
            if cursor.offset == 0 {
                if cursor.source == 0 {
                    break;
                }
                cursor.source -= 1;
                cursor.source_id = sources[cursor.source].id.clone();
                cursor.offset = fs::metadata(&sources[cursor.source].path)?.len();
            }
        }

        events.reverse();
        if cursor.offset == 0 && cursor.source > 0 {
            cursor.source -= 1;
            cursor.source_id = sources[cursor.source].id.clone();
            cursor.offset = fs::metadata(&sources[cursor.source].path)?.len();
        }
        let has_older = cursor.offset > 0 || cursor.source > 0;
        let next_cursor = has_older.then(|| encode_cursor(&cursor)).transpose()?;
        Ok(HistoryPage {
            source_status: status,
            events,
            next_cursor,
            skipped_lines,
        })
    }

    pub fn search_session(
        &self,
        session: &Session,
        query: &str,
        limit: usize,
    ) -> Result<HistorySearchResult> {
        self.search_session_impl(session, query, limit, false)
    }

    /// Search only until the caller's display cap is full. Unlike
    /// `search_session`, `total_hits` is then a lower bound and `partial` is
    /// true; focused Session search keeps using the exact-count path above.
    pub fn search_session_bounded(
        &self,
        session: &Session,
        query: &str,
        limit: usize,
    ) -> Result<HistorySearchResult> {
        self.search_session_impl(session, query, limit, true)
    }

    fn search_session_impl(
        &self,
        session: &Session,
        query: &str,
        limit: usize,
        bounded: bool,
    ) -> Result<HistorySearchResult> {
        let query = query.trim();
        if query.chars().count() < 2 {
            return Err(CoreError::Validation(
                "search query needs at least 2 characters".into(),
            ));
        }
        let sources = match self.resolve(session) {
            Resolution::Available(sources) => sources,
            Resolution::Unavailable(reason) => {
                return Ok(HistorySearchResult {
                    source_status: HistorySourceStatus::Unavailable { reason },
                    hits: Vec::new(),
                    total_hits: 0,
                    partial: false,
                })
            }
            Resolution::Ambiguous(reason, candidates) => {
                return Ok(HistorySearchResult {
                    source_status: HistorySourceStatus::Ambiguous { reason, candidates },
                    hits: Vec::new(),
                    total_hits: 0,
                    partial: false,
                })
            }
        };
        let status = HistorySourceStatus::Available {
            sources: sources.iter().map(NativeSource::info).collect(),
        };
        if bounded && limit == 0 {
            return Ok(HistorySearchResult {
                source_status: status,
                hits: Vec::new(),
                total_hits: 0,
                partial: true,
            });
        }

        let needle = query.to_lowercase();
        let mut hits = Vec::new();
        let mut total_hits = 0usize;
        let mut partial = false;
        self.for_each_event_in_sources(&sources, |event| {
            let lowered = event.text.to_lowercase();
            for (offset, _) in lowered.match_indices(&needle) {
                total_hits += 1;
                if hits.len() < limit {
                    hits.push(HistorySearchHit {
                        session_id: session.id.clone(),
                        snippet: snippet(&event.text, offset, needle.len()),
                        event: event.clone(),
                    });
                }
                if bounded && hits.len() == limit {
                    partial = true;
                    return Ok(false);
                }
            }
            Ok(true)
        })?;
        Ok(HistorySearchResult {
            source_status: status,
            hits,
            total_hits,
            partial,
        })
    }

    /// Write a user-requested artifact directly from native sources. This is
    /// the only supported transcript copy and is never placed in AgentPort's
    /// internal data directories unless the user explicitly chose one there.
    pub fn export(&self, session: &Session, destination: &Path, format: &str) -> Result<PathBuf> {
        if destination.exists() {
            return Err(CoreError::Conflict(format!(
                "export destination already exists: {}",
                destination.display()
            )));
        }
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(destination)?;
        let result = match format {
            "md" | "markdown" => self.write_markdown(session, &mut output),
            "json" => self.write_json(session, &mut output),
            _ => Err(CoreError::Validation(
                "native history export format must be md or json".into(),
            )),
        };
        if let Err(error) = result {
            drop(output);
            let _ = fs::remove_file(destination);
            return Err(error);
        }
        output.flush()?;
        Ok(destination.to_path_buf())
    }

    fn write_markdown(&self, session: &Session, output: &mut File) -> Result<()> {
        writeln!(output, "---")?;
        writeln!(output, "session: {}", session.id)?;
        writeln!(output, "title: {}", session.title.replace('\n', " "))?;
        writeln!(output, "agent: {}", session.adapter_type.as_str())?;
        writeln!(output, "source: agent-native-log")?;
        writeln!(output, "---\n")?;
        self.for_each_event(session, |event| {
            let role = event
                .role
                .as_ref()
                .map(|role| format!("{role:?}").to_lowercase())
                .unwrap_or_else(|| event.kind.clone());
            writeln!(output, "## {role}")?;
            if let Some(timestamp) = &event.timestamp {
                writeln!(output, "_{timestamp}_\n")?;
            }
            writeln!(output, "{}\n", event.text)?;
            Ok(())
        })
    }

    fn write_json(&self, session: &Session, output: &mut File) -> Result<()> {
        write!(output, "[")?;
        let mut first = true;
        self.for_each_event(session, |event| {
            if !first {
                write!(output, ",")?;
            }
            first = false;
            serde_json::to_writer(&mut *output, &event)?;
            Ok(())
        })?;
        writeln!(output, "]")?;
        Ok(())
    }

    fn for_each_event(
        &self,
        session: &Session,
        mut visitor: impl FnMut(HistoryEvent) -> Result<()>,
    ) -> Result<()> {
        let sources = match self.resolve(session) {
            Resolution::Available(sources) => sources,
            Resolution::Unavailable(_) | Resolution::Ambiguous(_, _) => {
                return Err(CoreError::NotFound(
                    "agent native history is unavailable".into(),
                ))
            }
        };
        self.for_each_event_in_sources(&sources, |event| {
            visitor(event)?;
            Ok(true)
        })
    }

    fn for_each_event_in_sources(
        &self,
        sources: &[NativeSource],
        mut visitor: impl FnMut(HistoryEvent) -> Result<bool>,
    ) -> Result<()> {
        for source in sources {
            let file = File::open(&source.path)?;
            let mut reader = BufReader::new(file);
            let mut line = Vec::new();
            let mut offset = 0u64;
            loop {
                let (read, oversized) = read_bounded_jsonl_line(&mut reader, &mut line)?;
                if read == 0 {
                    break;
                }
                offset = offset.saturating_add(read);
                if oversized {
                    continue;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = normalize_event(source, offset, &value) {
                    if !visitor(event)? {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn resolve(&self, session: &Session) -> Resolution {
        if session.adapter_type == AgentType::Shell {
            return Resolution::Unavailable(
                "Shell has no agent-owned native conversation log".into(),
            );
        }
        let native_ids = collect_native_ids(self.paths, session);
        if native_ids.is_empty() {
            return Resolution::Unavailable(
                "No verified native session id is available for this Session".into(),
            );
        }
        let resolved = match session.adapter_type {
            AgentType::Claude => resolve_claude(session, &native_ids),
            AgentType::Codex => resolve_codex(session, &native_ids, self.codex_files()),
            AgentType::Pi | AgentType::EasyPi | AgentType::Omp => resolve_pi(self.paths, session, &native_ids),
            AgentType::Kimi => resolve_kimi(session, &native_ids, self.kimi_index()),
            AgentType::Qoder => resolve_qoder(session, &native_ids),
            _ => return Resolution::Unavailable(format!(
                "{} native transcript import is not supported; terminal logs remain available",
                session.adapter_type.display_name()
            )),
        };
        match resolved {
            Ok(mut sources) => {
                sources.dedup_by(|left, right| left.path == right.path);
                sources.truncate(MAX_NATIVE_SOURCES);
                if sources.is_empty() {
                    Resolution::Unavailable(
                        "The agent's native transcript is not present on disk".into(),
                    )
                } else {
                    Resolution::Available(sources)
                }
            }
            Err(ResolveError::Unavailable(reason)) => Resolution::Unavailable(reason),
            Err(ResolveError::Ambiguous(count)) => Resolution::Ambiguous(
                "Several native transcripts match and AgentPort cannot bind one safely".into(),
                count,
            ),
        }
    }

    fn codex_files(&self) -> &[PathBuf] {
        self.codex_files.get_or_init(|| {
            let root = configured_home("CODEX_HOME", ".codex").join("sessions");
            let mut files = Vec::new();
            collect_jsonl_files(&root, 5, &mut files);
            files
        })
    }

    fn kimi_index(&self) -> &[Value] {
        self.kimi_index.get_or_init(|| {
            let home = configured_home("KIMI_CODE_HOME", ".kimi-code");
            read_kimi_session_index(&home)
        })
    }
}

#[derive(Debug)]
enum ResolveError {
    Unavailable(String),
    Ambiguous(usize),
}

pub(crate) fn collect_native_ids(paths: &AppPaths, session: &Session) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |id: &str| {
        let id = id.trim();
        if !id.is_empty() && id.len() <= 256 && seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    };
    // Hook events are append-only lifecycle evidence, so they preserve the
    // chronological order across /clear, fork, and compact ID rollovers. The
    // persisted scalar is the latest/fallback ID and must not be inserted
    // before older Hook IDs or reverse pagination would start from an old run.
    if let Ok(file) = File::open(paths.hook_events_path(&session.id)) {
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            let Ok((read, oversized)) = read_bounded_jsonl_line(&mut reader, &mut line) else {
                break;
            };
            if read == 0 {
                break;
            }
            if oversized {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            for pointer in [
                "/session_id",
                "/sessionId",
                "/data/session_id",
                "/data/sessionId",
            ] {
                if let Some(id) = value.pointer(pointer).and_then(Value::as_str) {
                    push(id);
                }
            }
        }
    }
    if let Some(id) = &session.agent_session_id {
        push(id);
    }
    if let Ok(id) = fs::read_to_string(paths.session_dir(&session.id).join("agent_session_id")) {
        push(&id);
    }
    ids
}

pub(crate) fn configured_home(name: &str, default_leaf: &str) -> PathBuf {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(default_leaf)))
        .unwrap_or_else(|| PathBuf::from(default_leaf))
}

/// Slug a working directory the way provider CLIs name their per-project
/// transcript directories (non-alphanumerics become `-`).
pub fn cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

pub(crate) fn read_kimi_session_index(home: &Path) -> Vec<Value> {
    let Ok(file) = File::open(home.join("session_index.jsonl")) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut entries = Vec::new();
    loop {
        let Ok((read, oversized)) = read_bounded_jsonl_line(&mut reader, &mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        if oversized {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
            entries.push(value);
        }
    }
    entries
}

fn source(provider: AgentType, path: PathBuf, root: &Path) -> Option<NativeSource> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if !path.is_file() || !path.starts_with(&root) {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = path.metadata() {
            hasher.update(metadata.dev().to_le_bytes());
            hasher.update(metadata.ino().to_le_bytes());
        }
    }
    let digest = format!("{:x}", hasher.finalize());
    Some(NativeSource {
        id: digest[..24].to_string(),
        path,
        provider,
    })
}

fn resolve_claude(
    session: &Session,
    native_ids: &[String],
) -> std::result::Result<Vec<NativeSource>, ResolveError> {
    let root = configured_home("CLAUDE_CONFIG_DIR", ".claude").join("projects");
    let project = root.join(cwd_slug(&session.cwd));
    let sources = native_ids
        .iter()
        .filter_map(|id| {
            source(
                AgentType::Claude,
                project.join(format!("{id}.jsonl")),
                &root,
            )
        })
        .collect();
    Ok(sources)
}

pub(crate) fn collect_jsonl_files(root: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || output.len() >= MAX_DISCOVERY_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAX_DISCOVERY_FILES {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, depth - 1, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

pub(crate) fn codex_file_matches(path: &Path, native_id: &str, cwd: &str) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    for _ in 0..32 {
        let Ok((read, oversized)) = read_bounded_jsonl_line(&mut reader, &mut line) else {
            return false;
        };
        if read == 0 {
            return false;
        }
        if oversized {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let id_matches = value.pointer("/payload/id").and_then(Value::as_str) == Some(native_id);
        let cwd_matches = value
            .pointer("/payload/cwd")
            .and_then(Value::as_str)
            .is_none_or(|recorded| recorded == cwd);
        return id_matches && cwd_matches;
    }
    false
}

fn resolve_codex(
    session: &Session,
    native_ids: &[String],
    files: &[PathBuf],
) -> std::result::Result<Vec<NativeSource>, ResolveError> {
    let root = configured_home("CODEX_HOME", ".codex").join("sessions");
    let mut sources = Vec::new();
    for id in native_ids {
        let matches = files
            .iter()
            .filter(|path| codex_file_matches(path, id, &session.cwd))
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(ResolveError::Ambiguous(matches.len()));
        }
        if let Some(path) = matches.first() {
            if let Some(source) = source(AgentType::Codex, (*path).clone(), &root) {
                sources.push(source);
            }
        }
    }
    Ok(sources)
}

fn resolve_pi(
    paths: &AppPaths,
    session: &Session,
    native_ids: &[String],
) -> std::result::Result<Vec<NativeSource>, ResolveError> {
    let root = if session.adapter_type == AgentType::Pi {
        crate::pi_storage::read_directory(paths, &session.id)
            .map_err(|error| ResolveError::Unavailable(error.to_string()))?
    } else {
        paths.session_dir(&session.id).join(session.adapter_type.as_str())
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut sources = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| native_ids.iter().any(|id| name.contains(id)))
        })
        .filter_map(|path| source(session.adapter_type, path, &root))
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(sources)
}

fn resolve_kimi(
    session: &Session,
    native_ids: &[String],
    entries: &[Value],
) -> std::result::Result<Vec<NativeSource>, ResolveError> {
    let home = configured_home("KIMI_CODE_HOME", ".kimi-code");
    let root = home.join("sessions");
    let wanted = native_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut sources = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        if !wanted.contains(id)
            || entry.get("workDir").and_then(Value::as_str) != Some(session.cwd.as_str())
        {
            continue;
        }
        let Some(dir) = entry.get("sessionDir").and_then(Value::as_str) else {
            continue;
        };
        if let Some(source) = source(
            AgentType::Kimi,
            PathBuf::from(dir).join("agents/main/wire.jsonl"),
            &root,
        ) {
            sources.push(source);
        }
    }
    Ok(sources)
}

fn resolve_qoder(
    session: &Session,
    native_ids: &[String],
) -> std::result::Result<Vec<NativeSource>, ResolveError> {
    let qoder_home = configured_home("QODER_HOME", ".qoder");
    let root = qoder_home.join("logs/sessions");
    let project = root.join(cwd_slug(&session.cwd));
    let mut sources = Vec::new();
    for id in native_ids {
        let segments = project.join(id).join("segments");
        let Ok(entries) = fs::read_dir(&segments) else {
            continue;
        };
        let mut paths = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
            .collect::<Vec<_>>();
        paths.sort();
        sources.extend(
            paths
                .into_iter()
                .filter_map(|path| source(AgentType::Qoder, path, &root)),
        );
    }
    Ok(sources)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReverseLine {
    start: u64,
    end: u64,
    oversized: bool,
}

/// Read the JSONL record ending at or before `end` without accumulating data
/// while searching backwards. The returned range includes a trailing newline,
/// matching `read_bounded_jsonl_line`, and `start` is the cursor for the next
/// older record.
fn read_bounded_jsonl_line_before(
    file: &mut File,
    end: u64,
    output: &mut Vec<u8>,
    scan: &mut [u8],
) -> std::io::Result<Option<ReverseLine>> {
    output.clear();
    if end == 0 {
        return Ok(None);
    }

    let mut content_end = end;
    file.seek(SeekFrom::Start(end - 1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        content_end -= 1;
    }

    let mut search_end = content_end;
    let mut start = 0u64;
    while search_end > 0 {
        let chunk_start = search_end.saturating_sub(scan.len() as u64);
        let chunk_len = (search_end - chunk_start) as usize;
        file.seek(SeekFrom::Start(chunk_start))?;
        file.read_exact(&mut scan[..chunk_len])?;
        if let Some(position) = scan[..chunk_len].iter().rposition(|byte| *byte == b'\n') {
            start = chunk_start + position as u64 + 1;
            break;
        }
        search_end = chunk_start;
    }

    let bytes = end - start;
    let oversized = bytes > MAX_JSONL_LINE_BYTES as u64;
    if !oversized {
        output.resize(bytes as usize, 0);
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(output)?;
    }
    Ok(Some(ReverseLine {
        start,
        end,
        oversized,
    }))
}

const REVERSE_SCAN_BYTES: usize = 64 * 1024;

/// Read one JSONL record without ever retaining more than the configured line
/// limit. Oversized records are drained through the newline so the next cursor
/// still lands on a valid record boundary.
fn read_bounded_jsonl_line<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
) -> std::io::Result<(u64, bool)> {
    output.clear();
    let mut total = 0u64;
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((total, oversized));
        }
        let consume = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        let ends_line = available.get(consume.saturating_sub(1)) == Some(&b'\n');
        if !oversized {
            if output.len().saturating_add(consume) > MAX_JSONL_LINE_BYTES {
                output.clear();
                oversized = true;
            } else {
                output.extend_from_slice(&available[..consume]);
            }
        }
        reader.consume(consume);
        total = total.saturating_add(consume as u64);
        if ends_line {
            return Ok((total, oversized));
        }
    }
}

fn normalize_event(source: &NativeSource, offset: u64, value: &Value) -> Option<HistoryEvent> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| value.get("kind").and_then(Value::as_str))
        .or_else(|| value.pointer("/payload/type").and_then(Value::as_str))
        .unwrap_or("event")
        .to_string();
    let role_text = value
        .pointer("/message/role")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/payload/role").and_then(Value::as_str))
        .or_else(|| value.get("role").and_then(Value::as_str))
        .or_else(|| match kind.as_str() {
            "user" | "turn.prompt" | "input.prompt.submitted" => Some("user"),
            "assistant" | "agent_message" => Some("assistant"),
            _ => None,
        });
    let role = match role_text {
        Some("user") => Some(HistoryRole::User),
        Some("assistant") => Some(HistoryRole::Assistant),
        Some("tool") | Some("toolResult") | Some("tool_result") => Some(HistoryRole::Tool),
        Some("system") | Some("developer") => Some(HistoryRole::System),
        _ => None,
    };
    let text_value = value
        .pointer("/message/content")
        .or_else(|| value.pointer("/payload/content"))
        .or_else(|| value.get("content"))
        .or_else(|| value.get("input"))
        .or_else(|| value.pointer("/payload/message"))
        .or_else(|| value.get("message"));
    let mut text = String::new();
    if let Some(content) = text_value {
        collect_text(content, &mut text, 0);
    }
    if text.trim().is_empty() {
        return None;
    }
    let timestamp = ["timestamp", "time", "created_at", "createdAt"]
        .into_iter()
        .find_map(|key| value.get(key))
        .or_else(|| value.pointer("/message/timestamp"))
        .and_then(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        });
    let mut hasher = Sha256::new();
    hasher.update(source.id.as_bytes());
    hasher.update(offset.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    Some(HistoryEvent {
        id: digest[..24].to_string(),
        source_id: source.id.clone(),
        provider: source.provider,
        kind,
        role,
        timestamp,
        text: text.trim().to_string(),
    })
}

fn collect_text(value: &Value, output: &mut String, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Value::String(text) => push_text(output, text),
        Value::Array(values) => {
            for value in values {
                collect_text(value, output, depth + 1);
            }
        }
        Value::Object(object) => {
            let before = output.len();
            for key in [
                "text",
                "input_text",
                "output_text",
                "content",
                "prompt",
                "output",
                "result",
                "arguments",
            ] {
                if let Some(value) = object.get(key) {
                    collect_text(value, output, depth + 1);
                }
            }
            if output.len() == before {
                if let Some(name) = object.get("name").and_then(Value::as_str) {
                    push_text(output, name);
                }
                if let Some(input) = object.get("input") {
                    match input {
                        Value::String(text) => push_text(output, text),
                        Value::Null => {}
                        other => push_text(output, &other.to_string()),
                    }
                }
            }
        }
        Value::Number(number) => push_text(output, &number.to_string()),
        Value::Bool(value) => push_text(output, &value.to_string()),
        Value::Null => {}
    }
}

fn push_text(output: &mut String, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(text);
}

fn encode_cursor(cursor: &PageCursor) -> Result<String> {
    let bytes = serde_json::to_vec(cursor)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_cursor(cursor: &str) -> Result<PageCursor> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| CoreError::Validation("invalid native history cursor".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| CoreError::Validation("invalid native history cursor".into()))
}

fn snippet(text: &str, byte_offset: usize, needle_len: usize) -> String {
    let start = text[..byte_offset.min(text.len())]
        .char_indices()
        .rev()
        .nth(80)
        .map(|(offset, _)| offset)
        .unwrap_or(0);
    let match_end = byte_offset.saturating_add(needle_len).min(text.len());
    let end = text[match_end..]
        .char_indices()
        .nth(120)
        .map(|(offset, _)| match_end + offset)
        .unwrap_or(text.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        &text[start..end],
        if end < text.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Lifecycle, PermissionMode, ResumePrecision};
    use chrono::Utc;
    use tempfile::TempDir;

    fn session(root: &Path, provider: AgentType, native_id: Option<&str>) -> Session {
        Session {
            id: "ses_history".into(),
            project_id: "prj_1".into(),
            worktree_id: None,
            preset_id: "pre_1".into(),
            title: "history".into(),
            cwd: root.join("workspace").to_string_lossy().into_owned(),
            host_pid: None,
            host_socket: None,
            host_token: "token".into(),
            lifecycle: Lifecycle::Exited,
            agent_session_id: native_id.map(str::to_string),
            resume_precision: ResumePrecision::Exact,
            log_path: root.join("legacy.log").to_string_lossy().into_owned(),
            adapter_type: provider,
            transport: crate::models::AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        }
    }

    #[test]
    fn shell_is_explicitly_unavailable() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let page = NativeHistory::new(&paths)
            .page(&session(temp.path(), AgentType::Shell, None), None, 200)
            .unwrap();
        assert!(matches!(
            page.source_status,
            HistorySourceStatus::Unavailable { .. }
        ));
        assert!(page.events.is_empty());
    }

    #[test]
    fn oversized_jsonl_record_is_drained_without_losing_the_next_boundary() {
        let mut bytes = vec![b'x'; MAX_JSONL_LINE_BYTES + 1];
        bytes.extend_from_slice(b"\n{\"type\":\"message\"}\n");
        let mut reader = BufReader::new(std::io::Cursor::new(bytes));
        let mut line = Vec::new();
        let (first_bytes, oversized) = read_bounded_jsonl_line(&mut reader, &mut line).unwrap();
        assert!(oversized);
        assert_eq!(first_bytes, MAX_JSONL_LINE_BYTES as u64 + 2);
        assert!(line.is_empty());
        let (_, oversized) = read_bounded_jsonl_line(&mut reader, &mut line).unwrap();
        assert!(!oversized);
        assert_eq!(line, b"{\"type\":\"message\"}\n");
    }

    #[test]
    fn reverse_reader_skips_an_oversized_record_with_bounded_storage() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("reverse.jsonl");
        let mut bytes = b"oldest\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', MAX_JSONL_LINE_BYTES + 1));
        bytes.extend_from_slice(b"\nlatest");
        fs::write(&path, &bytes).unwrap();
        let mut file = File::open(path).unwrap();
        let mut line = Vec::new();
        let mut scan = vec![0; REVERSE_SCAN_BYTES];

        let latest =
            read_bounded_jsonl_line_before(&mut file, bytes.len() as u64, &mut line, &mut scan)
                .unwrap()
                .unwrap();
        assert_eq!(line, b"latest");
        let oversized =
            read_bounded_jsonl_line_before(&mut file, latest.start, &mut line, &mut scan)
                .unwrap()
                .unwrap();
        assert!(oversized.oversized);
        assert!(line.is_empty());
        let oldest =
            read_bounded_jsonl_line_before(&mut file, oversized.start, &mut line, &mut scan)
                .unwrap()
                .unwrap();
        assert_eq!(line, b"oldest\n");
        assert_eq!(oldest.start, 0);
    }

    #[test]
    fn new_pi_family_history_cannot_read_other_provider_namespaces() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        for agent in [AgentType::EasyPi, AgentType::Omp] {
            let session = session(temp.path(), agent, Some("same-native-id"));
            for provider in ["pi", "easy_pi", "omp"] {
                let root = paths.session_dir(&session.id).join(provider);
                fs::create_dir_all(&root).unwrap();
                fs::write(root.join("same-native-id.jsonl"), format!(
                    "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"{provider}\"}}}}\n"
                )).unwrap();
            }
            let page = NativeHistory::new(&paths).page(&session, None, 10).unwrap();
            assert_eq!(page.events.len(), 1);
            assert_eq!(page.events[0].text, agent.as_str());
            assert_eq!(page.events[0].provider, agent);
        }
    }

    #[test]
    fn pi_history_pages_stream_without_copying_body() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Pi, Some("pi-native"));
        let pi = paths.session_dir(&session.id).join("pi");
        fs::create_dir_all(&pi).unwrap();
        fs::write(
            pi.join("2026-08-24_pi-native.jsonl"),
            concat!(
                "{\"type\":\"session\",\"id\":\"pi-native\"}\n",
                "{\"type\":\"message\",\"timestamp\":\"2026-08-24T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first question\"}]}}\n",
                "broken json\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        let history = NativeHistory::new(&paths);
        let first = history.page(&session, None, 1).unwrap();
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.events[0].text, "second answer");
        assert!(first.next_cursor.is_some());
        let second = history
            .page(&session, first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(second.events[0].text, "first question");
        assert_eq!(second.skipped_lines, 1);
        let exhausted = history
            .page(&session, second.next_cursor.as_deref(), 1)
            .unwrap();
        assert!(exhausted.events.is_empty());
        assert!(exhausted.next_cursor.is_none());
        assert!(
            !paths.db_path().exists(),
            "history reads must not create a cache DB"
        );

        let markdown = temp.path().join("history.md");
        history.export(&session, &markdown, "md").unwrap();
        let markdown = fs::read_to_string(markdown).unwrap();
        assert!(markdown.contains("source: agent-native-log"));
        assert!(markdown.contains("first question"));
        assert!(markdown.contains("second answer"));

        let json = temp.path().join("history.json");
        history.export(&session, &json, "json").unwrap();
        let events: Vec<HistoryEvent> = serde_json::from_slice(&fs::read(json).unwrap()).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].text, "second answer");
    }

    #[test]
    fn pi_epi_history_search_export_and_backup_use_the_published_copy() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"))
            .with_pi_sessions_root(temp.path().join(".epi/agent/sessions"));
        paths.ensure_layout().unwrap();
        let session = session(temp.path(), AgentType::Pi, Some("pi-native"));
        let legacy = paths.session_dir(&session.id).join("pi");
        fs::create_dir_all(&legacy).unwrap();
        let name = "2026_pi-native.jsonl";
        let old = b"{\"type\":\"session\",\"version\":3,\"id\":\"pi-native\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"old question\"}}\n";
        fs::write(legacy.join(name), old).unwrap();
        let mut ctx = crate::adapters::test_fixtures::resume_ctx(
            AgentType::Pi,
            &["session-id", "session-dir", "tui-mode"],
            Some("pi-native"),
        );
        ctx.session_id = session.id.clone();
        ctx.session_dir = paths
            .session_dir(&session.id)
            .to_string_lossy()
            .into_owned();
        let mut plan = crate::adapters::adapter_for(AgentType::Pi)
            .build_resume_checked(&ctx)
            .unwrap();
        crate::pi_storage::prepare_launch(&paths, &session.id, &mut plan).unwrap();
        let published = crate::pi_storage::read_directory(&paths, &session.id).unwrap();
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(published.join(name))
            .unwrap();
        file.write_all(b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"new epi answer\"}}\n").unwrap();
        file.sync_all().unwrap();
        let history = NativeHistory::new(&paths);
        assert_eq!(
            history.page(&session, None, 1).unwrap().events[0].text,
            "new epi answer"
        );
        assert_eq!(
            history
                .search_session(&session, "new epi answer", 10)
                .unwrap()
                .total_hits,
            1
        );
        let export = temp.path().join("epi.md");
        history.export(&session, &export, "md").unwrap();
        assert!(fs::read_to_string(export)
            .unwrap()
            .contains("new epi answer"));
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let backup = crate::native_backup::capture_session(&paths, &session, &staging).unwrap();
        assert_eq!(
            backup.artifacts.len(),
            1,
            "migration marker is not a transcript backup artifact"
        );
        let restored = temp.path().join("restored");
        crate::native_backup::materialize(&staging, &restored, &[backup]).unwrap();
        let restored_file = restored
            .join("sessions")
            .join(&session.id)
            .join("pi")
            .join(name);
        assert!(fs::read_to_string(restored_file)
            .unwrap()
            .contains("new epi answer"));
        assert_eq!(fs::read(legacy.join(name)).unwrap(), old);
        assert!(crate::native_cleanup::plan_native_cleanup(&paths, &session).is_empty());
        assert!(published.join(name).exists());
    }

    #[test]
    fn native_history_starts_at_the_tail_and_pages_toward_older_events() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Pi, Some("pi-tail"));
        let pi = paths.session_dir(&session.id).join("pi");
        fs::create_dir_all(&pi).unwrap();
        fs::write(
            pi.join("2026_pi-tail.jsonl"),
            concat!(
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"oldest\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"middle\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"latest\"}}"
            ),
        )
        .unwrap();

        let history = NativeHistory::new(&paths);
        let latest = history.page(&session, None, 1).unwrap();
        assert_eq!(latest.events[0].text, "latest");
        let middle = history
            .page(&session, latest.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(middle.events[0].text, "middle");
        let oldest = history
            .page(&session, middle.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(oldest.events[0].text, "oldest");
        assert!(oldest.next_cursor.is_none());
    }

    #[test]
    fn hook_native_id_rollover_resolves_multiple_claude_sources() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let mut session = session(temp.path(), AgentType::Claude, Some("new-id"));
        fs::create_dir_all(paths.session_dir(&session.id)).unwrap();
        fs::write(
            paths.hook_events_path(&session.id),
            concat!(
                "{\"data\":{\"session_id\":\"old-id\"}}\n",
                "{\"data\":{\"session_id\":\"new-id\"}}\n"
            ),
        )
        .unwrap();
        let claude = temp.path().join("claude");
        let project = claude.join("projects").join(cwd_slug(&session.cwd));
        fs::create_dir_all(&project).unwrap();
        for (id, text) in [("old-id", "old turn"), ("new-id", "new turn")] {
            fs::write(
                project.join(format!("{id}.jsonl")),
                format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}}}}\n"),
            )
            .unwrap();
        }
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude);
        let page = NativeHistory::new(&paths).page(&session, None, 10).unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].text, "old turn");
        assert_eq!(page.events[1].text, "new turn");
        session.agent_session_id = None;
    }

    #[test]
    fn native_search_scans_pages_and_counts_all_matches() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Pi, Some("pi-search"));
        let pi = paths.session_dir(&session.id).join("pi");
        fs::create_dir_all(&pi).unwrap();
        fs::write(
            pi.join("2026_pi-search.jsonl"),
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"needle then needle\"}}\n",
        )
        .unwrap();
        let result = NativeHistory::new(&paths)
            .search_session(&session, "needle", 1)
            .unwrap();
        assert_eq!(result.total_hits, 2);
        assert_eq!(result.hits.len(), 1);
        assert!(!result.partial);

        let bounded = NativeHistory::new(&paths)
            .search_session_bounded(&session, "needle", 1)
            .unwrap();
        assert_eq!(bounded.total_hits, 1);
        assert_eq!(bounded.hits.len(), 1);
        assert!(bounded.partial);
    }

    #[test]
    fn codex_kimi_and_qoder_resolve_only_verified_native_sources() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));

        let codex_home = temp.path().join("codex");
        let codex_session = session(temp.path(), AgentType::Codex, Some("codex-native"));
        let codex_file = codex_home.join("sessions/2026/08/24/rollout-codex-native.jsonl");
        fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
        fs::write(
            &codex_file,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"codex-native\",\"cwd\":{}}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"codex answer\"}}]}}}}\n",
                serde_json::to_string(&codex_session.cwd).unwrap()
            ),
        )
        .unwrap();
        std::env::set_var("CODEX_HOME", &codex_home);
        let codex = NativeHistory::new(&paths)
            .page(&codex_session, None, 10)
            .unwrap();
        std::env::remove_var("CODEX_HOME");
        assert_eq!(codex.events[0].text, "codex answer");

        let kimi_home = temp.path().join("kimi");
        let kimi_session = session(temp.path(), AgentType::Kimi, Some("kimi-native"));
        let kimi_dir = kimi_home.join("sessions/work/kimi-native");
        fs::create_dir_all(kimi_dir.join("agents/main")).unwrap();
        fs::write(
            kimi_home.join("session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"kimi-native\",\"workDir\":{},\"sessionDir\":{}}}\n",
                serde_json::to_string(&kimi_session.cwd).unwrap(),
                serde_json::to_string(&kimi_dir.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            kimi_dir.join("agents/main/wire.jsonl"),
            "{\"type\":\"context.append_message\",\"time\":\"2026-08-24T00:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"kimi answer\"}]}}\n",
        )
        .unwrap();
        std::env::set_var("KIMI_CODE_HOME", &kimi_home);
        let kimi = NativeHistory::new(&paths)
            .page(&kimi_session, None, 10)
            .unwrap();
        std::env::remove_var("KIMI_CODE_HOME");
        assert_eq!(kimi.events[0].text, "kimi answer");

        let qoder_home = temp.path().join("qoder");
        let qoder_session = session(temp.path(), AgentType::Qoder, Some("qoder-native"));
        let qoder_segments = qoder_home
            .join("logs/sessions")
            .join(cwd_slug(&qoder_session.cwd))
            .join("qoder-native/segments");
        fs::create_dir_all(&qoder_segments).unwrap();
        fs::write(
            qoder_segments.join("001.jsonl"),
            "{\"type\":\"input.prompt.submitted\",\"input\":\"qoder question\",\"timestamp\":\"2026-08-24T00:00:00Z\"}\n",
        )
        .unwrap();
        std::env::set_var("QODER_HOME", &qoder_home);
        let qoder = NativeHistory::new(&paths)
            .page(&qoder_session, None, 10)
            .unwrap();
        std::env::remove_var("QODER_HOME");
        assert_eq!(qoder.events[0].text, "qoder question");
    }
}
