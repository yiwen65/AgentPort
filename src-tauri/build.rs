use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::path::PathBuf;

const RELEASE_BUNDLE_ID: &str = "com.agentport.desktop";

fn workspace_debug_bundle_id() -> Option<String> {
    if env::var("PROFILE").as_deref() != Ok("debug")
        || env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
    {
        return None;
    }
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR")?);
    let workspace = manifest_dir.parent()?.canonicalize().ok()?;
    let digest = format!(
        "{:x}",
        Sha256::digest(workspace.to_string_lossy().as_bytes())
    );
    Some(format!("com.agentport.desktop.debug.{}", &digest[..12]))
}

fn configure_debug_bundle_identity() {
    let Some(generated) = workspace_debug_bundle_id() else {
        return;
    };
    let mut config = env::var("TAURI_CONFIG")
        .map(|raw| {
            serde_json::from_str::<Value>(&raw)
                .expect("TAURI_CONFIG must contain a valid JSON object")
        })
        .unwrap_or_else(|_| json!({}));
    assert!(
        config.is_object(),
        "TAURI_CONFIG must contain a JSON object"
    );
    let identifier = config
        .get("identifier")
        .and_then(Value::as_str)
        .filter(|identifier| *identifier != RELEASE_BUNDLE_ID)
        .unwrap_or(&generated)
        .to_owned();
    config["identifier"] = Value::String(identifier.clone());
    let config = serde_json::to_string(&config).expect("debug Tauri config is serializable");
    env::set_var("TAURI_CONFIG", &config);
    println!("cargo:rustc-env=TAURI_CONFIG={config}");
    println!("cargo:rustc-env=AGENTPORT_BUNDLE_ID={identifier}");
}

fn main() {
    configure_debug_bundle_identity();
    tauri_build::build()
}
