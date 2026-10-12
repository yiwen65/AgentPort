use super::*;
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::symlink;

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, Downloads, String) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("data.bin"), bytes).unwrap();
    let downloads = Downloads::default();
    let open = downloads
        .open(root.path().to_str().unwrap(), "data.bin")
        .unwrap();
    assert_eq!(open["name"], "data.bin");
    assert_eq!(open["sizeBytes"], bytes.len());
    assert_eq!(open["chunkBytes"], CHUNK_BYTES);
    let id = open["downloadId"].as_str().unwrap().to_owned();
    (root, downloads, id)
}

fn call(downloads: &Downloads, action: &str, id: &str) -> Result<Value> {
    downloads.execute(
        &format!("session.files.download.{action}"),
        json!({"downloadId":id}),
    )
}

fn chunk(downloads: &Downloads, id: &str, offset: u64) -> Result<Value> {
    downloads.execute(
        "session.files.download.chunk",
        json!({"downloadId":id, "offset":offset}),
    )
}

#[test]
fn binary_chunks_are_bounded_sequential_and_hash_matches_transmitted_bytes() {
    let bytes = (0..CHUNK_BYTES * 2 + 7)
        .map(|i| (i % 256) as u8)
        .collect::<Vec<_>>();
    let (_root, downloads, id) = fixture(&bytes);
    assert_eq!(
        call(&downloads, "finish", &id),
        Err(SessionFilesError::IncompleteDownload)
    );
    assert_eq!(
        chunk(&downloads, &id, 1),
        Err(SessionFilesError::InvalidOffset)
    );
    let mut received = Vec::new();
    loop {
        let offset = received.len() as u64;
        let result = chunk(&downloads, &id, offset).unwrap();
        assert_eq!(result["offset"], offset);
        let data = base64::engine::general_purpose::STANDARD
            .decode(result["contentBase64"].as_str().unwrap())
            .unwrap();
        assert!(!data.is_empty());
        assert!(data.len() <= CHUNK_BYTES);
        received.extend_from_slice(&data);
        assert_eq!(
            chunk(&downloads, &id, offset),
            Err(SessionFilesError::InvalidOffset)
        );
        if result["eof"] == true {
            break;
        }
    }
    assert_eq!(received, bytes);
    let result = call(&downloads, "finish", &id).unwrap();
    assert_eq!(result["sizeBytes"], bytes.len());
    assert_eq!(result["sha256"], format!("{:x}", Sha256::digest(&received)));
    assert!(downloads.handles.lock().unwrap().is_empty());
    assert_eq!(
        call(&downloads, "finish", &id),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        chunk(&downloads, &id, 0),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        call(&downloads, "close", &id).unwrap(),
        json!({"closed":true})
    );
}

#[test]
fn empty_and_exact_chunk_files_have_unambiguous_eof() {
    for bytes in [vec![], vec![0; CHUNK_BYTES]] {
        let (_root, downloads, id) = fixture(&bytes);
        let result = chunk(&downloads, &id, 0).unwrap();
        assert_eq!(result["eof"], true);
        let received = base64::engine::general_purpose::STANDARD
            .decode(result["contentBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(received, bytes);
        assert_eq!(
            chunk(&downloads, &id, bytes.len() as u64),
            Err(SessionFilesError::InvalidOffset)
        );
        assert_eq!(
            call(&downloads, "finish", &id).unwrap()["sha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
    }
}

#[test]
fn one_gib_sparse_file_transfers_in_bounded_chunks_and_over_limit_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let file = File::create(root.path().join("large")).unwrap();
    file.set_len(MAX_FILE_BYTES).unwrap();
    let downloads = Downloads::default();
    let open = downloads
        .open(root.path().to_str().unwrap(), "large")
        .unwrap();
    assert_eq!(open["sizeBytes"], MAX_FILE_BYTES);
    let id = open["downloadId"].as_str().unwrap();
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < MAX_FILE_BYTES {
        let result = chunk(&downloads, id, offset).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result["contentBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes.len(), CHUNK_BYTES);
        assert!(bytes.iter().all(|byte| *byte == 0));
        hash.update(&bytes);
        offset += bytes.len() as u64;
        assert_eq!(result["eof"], offset == MAX_FILE_BYTES);
    }
    let finish = call(&downloads, "finish", id).unwrap();
    assert_eq!(finish["sizeBytes"], MAX_FILE_BYTES);
    assert_eq!(finish["sha256"], format!("{:x}", hash.finalize()));
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "large"),
        Err(SessionFilesError::FileTooLarge)
    );
    assert!(downloads.handles.lock().unwrap().is_empty());
}

#[test]
fn mutations_fail_before_chunk_or_finish_and_release_handles() {
    // Same-length writes, truncation, extension, a write after the final chunk,
    // and a ctime-only chmod (mtime and size unchanged).
    for mode in 0..5 {
        let (root, downloads, id) = fixture(&vec![42; CHUNK_BYTES + 5]);
        chunk(&downloads, &id, 0).unwrap();
        if mode == 3 {
            chunk(&downloads, &id, CHUNK_BYTES as u64).unwrap();
        }
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("data.bin"))
            .unwrap();
        match mode {
            0 | 3 => {
                writer.seek(SeekFrom::Start(0)).unwrap();
                writer.write_all(b"changed").unwrap();
            }
            1 => writer.set_len(1).unwrap(),
            4 => {
                use std::os::unix::fs::PermissionsExt;
                writer
                    .set_permissions(std::fs::Permissions::from_mode(0))
                    .unwrap();
            }
            _ => writer.set_len((CHUNK_BYTES + 6) as u64).unwrap(),
        }
        let result = if mode == 3 {
            call(&downloads, "finish", &id)
        } else {
            chunk(&downloads, &id, CHUNK_BYTES as u64)
        };
        assert_eq!(result, Err(SessionFilesError::SourceChanged));
        assert!(downloads.handles.lock().unwrap().is_empty());
    }
}

#[test]
fn close_is_idempotent_ids_do_not_cross_services_and_drop_releases_descriptors() {
    let (root, downloads, id) = fixture(b"binary\0\xff");
    let second = Downloads::default();
    assert_eq!(
        chunk(&second, &id, 0),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        call(&second, "close", &id),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        call(&downloads, "close", "not-an-id"),
        Err(SessionFilesError::InvalidDownload)
    );
    call(&downloads, "close", &id).unwrap();
    call(&downloads, "close", &id).unwrap();
    assert!(downloads.handles.lock().unwrap().is_empty());
    let id = downloads
        .open(root.path().to_str().unwrap(), "data.bin")
        .unwrap()["downloadId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(downloads.handles.lock().unwrap().contains_key(&id));
    let weak = Arc::downgrade(&downloads.handles);
    drop(downloads);
    for _ in 0..100 {
        if weak.upgrade().is_none() {
            return;
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("download registry outlived its service");
}

#[test]
fn bounded_handles_and_idle_expiration_allow_new_downloads() {
    let (root, downloads, first_id) = fixture(b"x");
    for _ in 1..MAX_HANDLES {
        downloads
            .open(root.path().to_str().unwrap(), "data.bin")
            .unwrap();
    }
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "data.bin"),
        Err(SessionFilesError::TooManyDownloads)
    );
    {
        let mut handles = downloads.handles.lock().unwrap();
        for item in handles.values_mut() {
            item.touched = Instant::now() - IDLE_TTL;
        }
    }
    // Trigger the same periodic reaper without waiting five real minutes; no
    // client RPC or new open is needed for descriptors to be released.
    downloads.reaper.get().unwrap().unpark();
    for _ in 0..1000 {
        if downloads.handles.lock().unwrap().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert!(downloads.handles.lock().unwrap().is_empty());
    assert_eq!(
        chunk(&downloads, &first_id, 0),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        call(&downloads, "close", &first_id).unwrap()["closed"],
        true
    );
    downloads
        .open(root.path().to_str().unwrap(), "data.bin")
        .unwrap();
}

#[test]
fn secure_download_rejects_escapes_special_files_and_keeps_original_descriptor() {
    let (root, downloads, id) = fixture(b"original");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), b"SECRET").unwrap();
    symlink(outside.path().join("secret"), root.path().join("escape")).unwrap();
    symlink(root.path().join("data.bin"), root.path().join("alias")).unwrap();
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "escape"),
        Err(SessionFilesError::OutsideRoot)
    );
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "../secret"),
        Err(SessionFilesError::OutsideRoot)
    );
    assert_eq!(
        downloads.open(
            root.path().to_str().unwrap(),
            outside.path().join("secret").to_str().unwrap()
        ),
        Err(SessionFilesError::InvalidPath)
    );
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "missing"),
        Err(SessionFilesError::PathNotFound)
    );
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "."),
        Err(SessionFilesError::InvalidPath)
    );
    assert!(std::process::Command::new("mkfifo")
        .arg(root.path().join("fifo"))
        .status()
        .unwrap()
        .success());
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "fifo"),
        Err(SessionFilesError::UnsupportedFile)
    );
    let _socket = std::os::unix::net::UnixListener::bind(root.path().join("socket")).unwrap();
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "socket"),
        Err(SessionFilesError::UnsupportedFile)
    );
    std::fs::create_dir(root.path().join("directory")).unwrap();
    assert_eq!(
        downloads.open(root.path().to_str().unwrap(), "directory"),
        Err(SessionFilesError::UnsupportedFile)
    );
    {
        use std::os::unix::fs::PermissionsExt;
        let unreadable = root.path().join("unreadable");
        std::fs::write(&unreadable, b"private").unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0)).unwrap();
        // Skip the assertion under privileged accounts, as the existing text
        // service permission test does; normal service users must get a safe error.
        if File::open(&unreadable).is_err() {
            assert_eq!(
                downloads.open(root.path().to_str().unwrap(), "unreadable"),
                Err(SessionFilesError::PermissionDenied)
            );
        }
    }
    let alias = downloads
        .open(root.path().to_str().unwrap(), "alias")
        .unwrap();
    assert_eq!(alias["name"], "alias");
    call(&downloads, "close", alias["downloadId"].as_str().unwrap()).unwrap();
    std::fs::rename(
        root.path().join("data.bin"),
        root.path().join("original.bin"),
    )
    .unwrap();
    symlink(outside.path().join("secret"), root.path().join("data.bin")).unwrap();
    // macOS/Linux may update ctime on rename; either reject or read the pinned
    // original, never the replacement path or its external target.
    match chunk(&downloads, &id, 0) {
        Ok(result) => assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result["contentBase64"].as_str().unwrap())
                .unwrap(),
            b"original"
        ),
        Err(error) => assert_eq!(error, SessionFilesError::SourceChanged),
    }
}

#[test]
fn strict_wire_params_reject_negative_noninteger_offsets_and_unknown_fields() {
    let (_root, downloads, id) = fixture(b"x");
    for offset in [json!(-1), json!(0.5), json!("0"), Value::Null] {
        assert_eq!(
            downloads.execute(
                "session.files.download.chunk",
                json!({"downloadId":id,"offset":offset})
            ),
            Err(SessionFilesError::InvalidOffset)
        );
    }
    assert_eq!(
        downloads.execute(
            "session.files.download.close",
            json!({"downloadId":id,"path":"/tmp/secret"})
        ),
        Err(SessionFilesError::InvalidDownload)
    );
    assert_eq!(
        chunk(&downloads, &id, u64::MAX),
        Err(SessionFilesError::InvalidOffset)
    );
    chunk(&downloads, &id, 0).unwrap();
    call(&downloads, "finish", &id).unwrap();
}
