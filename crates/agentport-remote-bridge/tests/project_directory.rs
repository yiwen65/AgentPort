use agentport_remote_protocol::{read_frame, write_frame, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "agentport-directory-bridge-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn request(id: &str, method: &str, params: Value) -> Value {
    json!({"type":"request", "requestId":id, "method":method, "params":params})
}

fn bridge(data: &Path, requests: &[Value]) -> Vec<Value> {
    let mut frames = Vec::new();
    write_frame(
        &mut frames,
        &json!({
            "type":"hello", "protocol":{"major":1,"minor":1},
            "client":{"name":"directory-integration-test","version":"1"},
            "requestedCapabilities":["project.directory.read","project.write"]
        }),
        MAX_FRAME_BYTES,
    )
    .unwrap();
    for request in requests {
        write_frame(&mut frames, request, MAX_FRAME_BYTES).unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentport-remote-bridge"))
        .args(["serve", "--stdio"])
        .env("AGENTPORT_DATA_DIR", data)
        .env("HOME", data.parent().unwrap())
        .env("USERPROFILE", data.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&frames).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut reader = Cursor::new(output.stdout);
    let mut envelopes = Vec::new();
    while let Some(frame) = read_frame(&mut reader, MAX_FRAME_BYTES).unwrap() {
        envelopes.push(serde_json::from_slice(frame.as_bytes()).unwrap());
    }
    envelopes
}

fn result<'a>(envelopes: &'a [Value], id: &str) -> &'a Value {
    envelopes
        .iter()
        .find(|envelope| envelope["type"] == "result" && envelope["requestId"] == id)
        .unwrap()
}

#[test]
fn real_framed_directory_reads_are_read_only_and_forward_path_preflight_errors() {
    let root = TestDirectory::new();
    let browse = root.0.join("browse");
    std::fs::create_dir(&browse).unwrap();
    std::fs::create_dir(browse.join("ordinary")).unwrap();
    std::fs::create_dir(browse.join(".hidden")).unwrap();
    std::fs::write(browse.join("file.txt"), "untouched").unwrap();
    let data = root.0.join("data");
    let missing = browse.join("missing");
    let envelopes = bridge(
        &data,
        &[
            request("home", "project.directory.list", json!({})),
            request("browse", "project.directory.list", json!({"path":browse})),
            request(
                "hidden",
                "project.directory.list",
                json!({"path":browse,"showHidden":true}),
            ),
            request(
                "resolve",
                "project.directory.resolve",
                json!({"path":browse.join("ordinary")}),
            ),
            request("projects", "project.list", json!({})),
            request("sessions", "session.list", json!({})),
            request("missing", "project.directory.list", json!({"path":missing})),
            request(
                "file",
                "project.directory.resolve",
                json!({"path":browse.join("file.txt")}),
            ),
            request(
                "relative",
                "project.directory.resolve",
                json!({"path":"relative/path"}),
            ),
            request("missing-add", "project.add", json!({"path":missing})),
            request(
                "file-add",
                "project.add",
                json!({"path":browse.join("file.txt")}),
            ),
            request(
                "relative-add",
                "project.add",
                json!({"path":"relative/path"}),
            ),
        ],
    );
    for capability in ["project.directory.read", "project.write"] {
        assert!(envelopes[0]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == capability && entry["enabled"] == true));
    }
    let listing = &result(&envelopes, "browse")["value"];
    assert_eq!(result(&envelopes, "browse")["retryClass"], "read");
    assert_eq!(
        listing["path"],
        browse.canonicalize().unwrap().to_str().unwrap()
    );
    let home = root.0.canonicalize().unwrap();
    assert_eq!(listing["homePath"], home.to_str().unwrap());
    assert_eq!(
        result(&envelopes, "home")["value"]["path"],
        listing["homePath"]
    );
    assert_eq!(
        listing["parentPath"],
        browse
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(listing["truncated"], false);
    assert_eq!(listing["entries"].as_array().unwrap().len(), 1);
    assert_eq!(listing["entries"][0]["name"], "ordinary");
    assert_eq!(
        result(&envelopes, "hidden")["value"]["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        result(&envelopes, "resolve")["value"],
        json!({"path":browse.join("ordinary").canonicalize().unwrap()})
    );
    assert_eq!(result(&envelopes, "projects")["value"], json!([]));
    assert_eq!(result(&envelopes, "sessions")["value"], json!([]));
    for (id, code) in [
        ("missing", "path_not_found"),
        ("file", "not_directory"),
        ("relative", "invalid_path"),
        ("missing-add", "path_not_found"),
        ("file-add", "not_directory"),
        ("relative-add", "invalid_path"),
    ] {
        let failure = result(&envelopes, id);
        assert_eq!(failure["status"], "not_executed");
        assert_eq!(failure["error"]["code"], code);
        assert!(!failure["error"]["message"]
            .as_str()
            .unwrap()
            .contains("request failed"));
    }
    assert_eq!(
        result(&envelopes, "missing-add")["retryClass"],
        "non_idempotent_write"
    );
    assert!(!missing.exists());
    assert_eq!(std::fs::read_dir(&browse).unwrap().count(), 3);
    assert_eq!(
        std::fs::read_to_string(browse.join("file.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn real_framed_add_preserves_shape_and_shares_canonical_duplicate_with_next_bridge() {
    let root = TestDirectory::new();
    let directory = root.0.join("ordinary-non-git");
    std::fs::create_dir(&directory).unwrap();
    let data = root.0.join("data");
    let first = bridge(
        &data,
        &[request(
            "add",
            "project.add",
            json!({"path":directory,"name":"  My project  "}),
        )],
    );
    let added = result(&first, "add");
    assert_eq!(added["status"], "succeeded");
    assert_eq!(added["retryClass"], "non_idempotent_write");
    assert_eq!(added["value"]["focusedExisting"], false);
    assert_eq!(added["value"]["project"]["name"], "My project");
    assert_eq!(added["value"]["project"]["gitRootPath"], Value::Null);
    #[cfg(not(unix))]
    let duplicate_path = directory.join(".");
    #[cfg(unix)]
    let duplicate_path = {
        let alias = root.0.join("alias");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        alias
    };
    let second = bridge(
        &data,
        &[
            request(
                "again",
                "project.add",
                json!({"path":duplicate_path,"name":"DO NOT RENAME"}),
            ),
            request("projects", "project.list", json!({})),
            request("sessions", "session.list", json!({})),
        ],
    );
    assert_eq!(result(&second, "again")["value"]["focusedExisting"], true);
    assert_eq!(
        result(&second, "again")["value"]["project"],
        added["value"]["project"]
    );
    assert_eq!(
        result(&second, "projects")["value"],
        json!([added["value"]["project"].clone()])
    );
    assert_eq!(result(&second, "sessions")["value"], json!([]));
    assert!(std::fs::read_dir(directory).unwrap().next().is_none());
}
