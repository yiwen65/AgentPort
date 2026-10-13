use super::*;
use crate::{CoreService, RemoteService, ServiceError};
use base64::Engine as _;
use serde_json::json;
use std::os::unix::fs::symlink;

fn open(service: &CoreService, root: &std::path::Path, path: &str) -> crate::Result<Value> {
    service.extended_facade("document.images.open", json!({"rootPath":root,"path":path}))
}

#[test]
fn document_image_stream_is_bounded_binary_and_isolated_from_session_downloads() {
    let root = tempfile::tempdir().unwrap();
    let bytes = vec![255; 262_144 + 3];
    std::fs::create_dir(root.path().join("图片 目录")).unwrap();
    std::fs::write(root.path().join("图片 目录/图.bin"), &bytes).unwrap();
    let service = CoreService::memory().unwrap();
    let opened = open(&service, root.path(), "图片 目录/图.bin").unwrap();
    assert_eq!(opened.as_object().unwrap().len(), 4);
    assert_eq!(opened["name"], "图.bin");
    assert_eq!(opened["sizeBytes"], bytes.len());
    assert_eq!(opened["chunkBytes"], 262_144);
    let id = opened["downloadId"].as_str().unwrap();
    for (other, method) in [
        (&service, "session.files.download.chunk"),
        (&CoreService::memory().unwrap(), "document.images.chunk"),
    ] {
        assert!(matches!(
            other.extended_facade(method, json!({"downloadId":id,"offset":0})),
            Err(ServiceError::SessionFiles(
                SessionFilesError::InvalidDownload
            ))
        ));
    }
    let mut received = Vec::new();
    loop {
        let chunk = service
            .extended_facade(
                "document.images.chunk",
                json!({"downloadId":id,"offset":received.len()}),
            )
            .unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap();
        assert!(decoded.len() <= 262_144);
        assert!(serde_json::to_vec(&chunk).unwrap().len() < 16 * 1024 * 1024);
        received.extend(decoded);
        if chunk["eof"] == true {
            break;
        }
    }
    assert_eq!(received, bytes);
    let finished = service
        .extended_facade("document.images.finish", json!({"downloadId":id}))
        .unwrap();
    assert_eq!(finished["sizeBytes"], bytes.len());
    use sha2::Digest as _;
    assert_eq!(
        finished["sha256"],
        format!("{:x}", sha2::Sha256::digest(&bytes))
    );
    assert_eq!(
        service
            .extended_facade("document.images.close", json!({"downloadId":id}))
            .unwrap(),
        json!({"closed":true})
    );
}

#[test]
fn document_image_open_rejects_escape_bad_params_and_non_regular_files() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), b"secret").unwrap();
    std::fs::write(root.path().join("inside"), b"inside").unwrap();
    symlink(outside.path().join("secret"), root.path().join("escape")).unwrap();
    symlink(root.path().join("inside"), root.path().join("alias")).unwrap();
    std::fs::create_dir(root.path().join("directory")).unwrap();
    let service = CoreService::memory().unwrap();
    for (path, expected) in [
        ("../secret", SessionFilesError::OutsideRoot),
        ("escape", SessionFilesError::OutsideRoot),
        ("/absolute", SessionFilesError::InvalidPath),
        ("directory", SessionFilesError::UnsupportedFile),
        ("", SessionFilesError::InvalidPath),
        ("a\\b", SessionFilesError::InvalidPath),
    ] {
        assert!(
            matches!(open(&service, root.path(), path), Err(ServiceError::SessionFiles(error)) if error == expected)
        );
    }
    assert!(open(&service, root.path(), "alias").is_ok());
    for params in [
        json!({"rootPath":"relative","path":"inside"}),
        json!({"path":"inside"}),
        json!({"rootPath":root.path(),"path":"inside","sessionId":"injected"}),
    ] {
        assert!(matches!(
            service.extended_facade("document.images.open", params),
            Err(ServiceError::SessionFiles(SessionFilesError::InvalidPath))
        ));
    }
}

#[test]
fn document_image_limit_is_checked_at_open_without_changing_session_limit() {
    let root = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(root.path().join("large")).unwrap();
    let service = CoreService::memory().unwrap();
    file.set_len(MAX_IMAGE_BYTES).unwrap();
    let opened = open(&service, root.path(), "large").unwrap();
    assert_eq!(opened["sizeBytes"], MAX_IMAGE_BYTES);
    service
        .extended_facade(
            "document.images.close",
            json!({"downloadId":opened["downloadId"]}),
        )
        .unwrap();
    file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
    assert!(matches!(
        open(&service, root.path(), "large"),
        Err(ServiceError::SessionFiles(SessionFilesError::ImageTooLarge))
    ));
    assert_eq!(SessionFilesError::ImageTooLarge.code(), "file_too_large");
    assert!(Downloads::default()
        .open(root.path().to_str().unwrap(), "large")
        .is_ok());
}

#[test]
fn document_image_pins_root_and_file_across_symlink_replacement() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("root");
    let outside = parent.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(root.join("image"), b"inside").unwrap();
    std::fs::write(outside.join("image"), b"SECRET").unwrap();
    let service = CoreService::memory().unwrap();
    let opened = open(&service, &root, "image").unwrap();
    let id = opened["downloadId"].as_str().unwrap();
    std::fs::rename(&root, parent.path().join("old-root")).unwrap();
    symlink(&outside, &root).unwrap();
    let chunk = service
        .extended_facade("document.images.chunk", json!({"downloadId":id,"offset":0}))
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap(),
        b"inside"
    );
    service
        .extended_facade("document.images.close", json!({"downloadId":id}))
        .unwrap();

    let opened = open(&service, &parent.path().join("old-root"), "image").unwrap();
    let id = opened["downloadId"].as_str().unwrap();
    std::fs::rename(
        parent.path().join("old-root/image"),
        parent.path().join("old-root/original"),
    )
    .unwrap();
    symlink(outside.join("image"), parent.path().join("old-root/image")).unwrap();
    match service.extended_facade("document.images.chunk", json!({"downloadId":id,"offset":0})) {
        Ok(chunk) => assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["contentBase64"].as_str().unwrap())
                .unwrap(),
            b"inside"
        ),
        Err(ServiceError::SessionFiles(SessionFilesError::SourceChanged)) => {}
        other => panic!("unexpected result: {other:?}"),
    }
}
