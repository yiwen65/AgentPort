#![cfg(unix)]

use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn write_executable(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, contents).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn pi_cli(version: &str) -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo '{version}'\nelse\n  echo '--session --session-id --approve --no-approve'\nfi\n"
    )
}

fn probe(temp: &Path, home: &Path, shell: &Path, process_path: &str, agent: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_agentport-cli"))
        .args(["--json", "probe", agent])
        .env_clear()
        .env("HOME", home)
        .env("USER", "agentport-test")
        .env("SHELL", shell)
        .env("PATH", process_path)
        .env("AGENTPORT_DATA_DIR", temp.join("data"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "probe process failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn probe_resolves_runtime_from_login_shell_path() {
    let temp = tempfile::tempdir().unwrap();
    let runtime_dir = temp.path().join("runtime-bin");
    let cli_dir = temp.path().join("cli-bin");
    fs::create_dir_all(&runtime_dir).unwrap();
    fs::create_dir_all(&cli_dir).unwrap();

    write_executable(
        &runtime_dir,
        "node",
        "#!/bin/sh\nif [ \"$2\" = \"--version\" ]; then\n  echo 'codex-cli 9.9.9'\nelse\n  echo 'Usage: codex'\n  echo '  --sandbox'\nfi\n",
    );
    let codex = write_executable(&cli_dir, "codex", "#!/usr/bin/env node\n");
    let login_shell = write_executable(
        temp.path(),
        "login-shell",
        "#!/bin/sh\nif [ \"$1\" = \"-i\" ]; then\n  printf '__AGENTPORT_PATH__=%s\\n' \"$AGENTPORT_TEST_LOGIN_PATH\"\nelse\n  printf '__AGENTPORT_PATH__=%s\\n' '/usr/bin:/bin'\nfi\n",
    );

    let output = Command::new(env!("CARGO_BIN_EXE_agentport-cli"))
        .args(["--json", "probe", "codex", "--path"])
        .arg(&codex)
        .env_clear()
        .env("HOME", temp.path())
        .env("USER", "agentport-test")
        .env("SHELL", login_shell)
        .env("PATH", "/usr/bin:/bin")
        .env("AGENTPORT_DATA_DIR", temp.path().join("data"))
        .env("AGENTPORT_TEST_LOGIN_PATH", &runtime_dir)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "probe process failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload[0]["state"], "available", "payload: {payload}");
    assert_eq!(payload[0]["install"]["version"], "codex-cli 9.9.9");
}

#[test]
fn probe_discovers_agent_from_volta_without_manual_path() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let volta_bin = home.join(".volta/bin");
    fs::create_dir_all(&volta_bin).unwrap();
    let pi = write_executable(&volta_bin, "pi", &pi_cli("0.99.0"));
    let shell = write_executable(
        temp.path(),
        "login-shell",
        "#!/bin/sh\nprintf '__AGENTPORT_PATH__=%s\\n' '/usr/bin:/bin'\n",
    );

    let payload = probe(temp.path(), &home, &shell, "/usr/bin:/bin", "pi");

    assert_eq!(payload[0]["state"], "available", "payload: {payload}");
    assert_eq!(payload[0]["install"]["path"], pi.to_string_lossy().as_ref());
    let selected = payload[0]["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["path"] == pi.to_string_lossy().as_ref())
        .unwrap();
    assert_eq!(selected["source"], "version_manager");
}

#[test]
fn probe_prefers_the_interactive_shell_candidate_over_process_path() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let process_bin = temp.path().join("process-bin");
    let shell_bin = temp.path().join("shell-bin");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&process_bin).unwrap();
    fs::create_dir_all(&shell_bin).unwrap();
    write_executable(&process_bin, "pi", &pi_cli("process 1.0.0"));
    let shell_pi = write_executable(&shell_bin, "pi", &pi_cli("shell 2.0.0"));
    let shell = write_executable(
        temp.path(),
        "login-shell",
        "#!/bin/sh\nprintf '__AGENTPORT_PATH__=%s\\n' \"$AGENTPORT_TEST_LOGIN_PATH\"\n",
    );
    let process_path = format!("{}:/usr/bin:/bin", process_bin.display());

    let output = Command::new(env!("CARGO_BIN_EXE_agentport-cli"))
        .args(["--json", "probe", "pi"])
        .env_clear()
        .env("HOME", &home)
        .env("USER", "agentport-test")
        .env("SHELL", &shell)
        .env("PATH", process_path)
        .env("AGENTPORT_DATA_DIR", temp.path().join("data"))
        .env("AGENTPORT_TEST_LOGIN_PATH", &shell_bin)
        .output()
        .unwrap();
    assert!(output.status.success());
    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(payload[0]["state"], "available", "payload: {payload}");
    assert_eq!(
        payload[0]["install"]["path"],
        shell_pi.to_string_lossy().as_ref()
    );
    assert_eq!(payload[0]["install"]["version"], "shell 2.0.0");
}

#[test]
fn probe_prefers_the_newest_version_manager_installation() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let fnm_root = home.join(".local/share/fnm/node-versions");
    let old_bin = fnm_root.join("v8.0.0/installation/bin");
    let new_bin = fnm_root.join("v24.15.0/installation/bin");
    fs::create_dir_all(&old_bin).unwrap();
    fs::create_dir_all(&new_bin).unwrap();
    write_executable(&old_bin, "pi", &pi_cli("8.0.0"));
    let newest = write_executable(&new_bin, "pi", &pi_cli("24.15.0"));
    let shell = write_executable(
        temp.path(),
        "login-shell",
        "#!/bin/sh\nprintf '__AGENTPORT_PATH__=%s\\n' '/usr/bin:/bin'\n",
    );

    let payload = probe(temp.path(), &home, &shell, "/usr/bin:/bin", "pi");

    assert_eq!(payload[0]["state"], "available", "payload: {payload}");
    assert_eq!(
        payload[0]["install"]["path"],
        newest.to_string_lossy().as_ref()
    );
    assert_eq!(payload[0]["install"]["version"], "24.15.0");
}
