use super::{mobile_mosh_start, MoshSessions, MoshStartRequest, MoshStartResult};
use crate::credentials::load_credential;
use crate::ssh::{connect_authenticated_with_jump, validate, AuthenticatedSsh, SshProbeRequest};
use russh::Disconnect;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::io::AsyncReadExt;
use zeroize::{Zeroize, Zeroizing};

const MAX_BOOTSTRAP_OUTPUT_BYTES: usize = 16 * 1024;
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(15);
const MISSING_SERVER: &str = "AGENTPORT MOSH ERROR missing_mosh_server";
const MISSING_ATTACH: &str = "AGENTPORT MOSH ERROR missing_agentport_mosh_attach";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoshBootstrapMode {
    Shell,
    AgentSession,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshBootstrapRequest {
    connection: SshProbeRequest,
    mode: MoshBootstrapMode,
    #[serde(default)]
    session_id: Option<String>,
}

struct MoshBootstrapResult {
    udp_host: String,
    port: u16,
    key: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoshBootstrapStartRequest {
    bootstrap: MoshBootstrapRequest,
    cols: u16,
    rows: u16,
    #[serde(default = "super::default_prediction_mode")]
    prediction_mode: String,
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn bootstrap_command(mode: MoshBootstrapMode, session_id: Option<&str>) -> Result<String, String> {
    let prefix = format!(
        "case \"$(locale charmap 2>/dev/null || true)\" in UTF-8|UTF8|utf8) ;; *) if [ \"$(uname -s)\" = Darwin ]; then export LC_CTYPE=UTF-8; else export LC_CTYPE=C.UTF-8; fi ;; esac; if ! command -v mosh-server >/dev/null 2>&1; then printf '{}\\n'; exit 127; fi; ",
        MISSING_SERVER
    );
    match mode {
        MoshBootstrapMode::Shell => {
            if session_id.is_some() {
                return Err("ordinary Mosh shell must not include a Session id".into());
            }
            Ok(format!("{prefix}exec mosh-server new -s"))
        }
        MoshBootstrapMode::AgentSession => {
            let session_id = session_id
                .filter(|value| valid_session_id(value))
                .ok_or_else(|| "AgentPort Mosh attach requires a valid Session id".to_string())?;
            Ok(format!(
                "{prefix}attach=$(command -v agentport-mosh-attach 2>/dev/null || true); if [ -z \"$attach\" ] && [ -x /Applications/AgentPort.app/Contents/MacOS/agentport-mosh-attach ]; then attach=/Applications/AgentPort.app/Contents/MacOS/agentport-mosh-attach; fi; if [ -z \"$attach\" ] && [ -x \"$HOME/Applications/AgentPort.app/Contents/MacOS/agentport-mosh-attach\" ]; then attach=\"$HOME/Applications/AgentPort.app/Contents/MacOS/agentport-mosh-attach\"; fi; if [ -z \"$attach\" ]; then printf '{}\\n'; exit 127; fi; exec mosh-server new -s -- \"$attach\" --session {}",
                MISSING_ATTACH, session_id
            ))
        }
    }
}

fn parse_connect(output: &[u8]) -> Result<(u16, Zeroizing<String>), String> {
    let text =
        std::str::from_utf8(output).map_err(|_| "Mosh bootstrap output is invalid".to_string())?;
    if text.lines().any(|line| line.trim() == MISSING_SERVER) {
        return Err("mosh-server is not installed; install it on macOS or Ubuntu and allow its UDP port range, then retry".into());
    }
    if text.lines().any(|line| line.trim() == MISSING_ATTACH) {
        return Err("agentport-mosh-attach is not installed; install the matching AgentPort desktop package, then retry".into());
    }

    let mut connection = None;
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("MOSH CONNECT ") else {
            continue;
        };
        if connection.is_some() {
            return Err("Mosh bootstrap returned multiple connection records".into());
        }
        let mut fields = rest.split(' ');
        let port = fields
            .next()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| *value != 0)
            .ok_or_else(|| "Mosh bootstrap returned an invalid UDP port".to_string())?;
        let key = fields
            .next()
            .filter(|value| {
                value.len() == 22
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
            })
            .ok_or_else(|| "Mosh bootstrap returned an invalid connection key".to_string())?;
        if fields.next().is_some() {
            return Err("Mosh bootstrap returned an invalid connection record".into());
        }
        connection = Some((port, Zeroizing::new(key.to_string())));
    }
    connection.ok_or_else(|| "Mosh bootstrap did not return a connection record".into())
}

async fn read_bounded(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut output = Zeroizing::new(Vec::with_capacity(1024));
    let mut buffer = [0_u8; 1024];
    loop {
        let count = tokio::time::timeout(BOOTSTRAP_TIMEOUT, stream.read(&mut buffer))
            .await
            .map_err(|_| "Mosh bootstrap timed out".to_string())?
            .map_err(|_| "Mosh bootstrap read failed".to_string())?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > MAX_BOOTSTRAP_OUTPUT_BYTES {
            return Err("Mosh bootstrap output exceeds the safe limit".into());
        }
        output.extend_from_slice(&buffer[..count]);
        if output
            .windows(b"\nMOSH CONNECT ".len())
            .any(|window| window == b"\nMOSH CONNECT ")
            || output.starts_with(b"MOSH CONNECT ")
            || output
                .windows(MISSING_SERVER.len())
                .any(|window| window == MISSING_SERVER.as_bytes())
            || output
                .windows(MISSING_ATTACH.len())
                .any(|window| window == MISSING_ATTACH.as_bytes())
        {
            // The complete line is required so a truncated key cannot be accepted.
            if output.last() == Some(&b'\n') {
                return Ok(output);
            }
        }
    }
}

async fn bootstrap(
    app: &AppHandle,
    request: MoshBootstrapRequest,
) -> Result<MoshBootstrapResult, String> {
    validate(&request.connection)?;
    let command = bootstrap_command(request.mode, request.session_id.as_deref())?;
    let mut secret = load_credential(app, &request.connection.credential_id)?;
    let mut jump_secret = request
        .connection
        .jump
        .as_ref()
        .map(|jump| load_credential(app, &jump.credential_id))
        .transpose()?;
    let AuthenticatedSsh {
        session,
        host_key_fingerprint: _,
        jump_session: _jump_session,
    } = connect_authenticated_with_jump(
        &request.connection,
        secret.as_slice(),
        jump_secret.as_ref().map(|value| value.as_slice()),
    )
    .await
    .map_err(|failure| failure.reason.to_string())?;
    secret.zeroize();
    if let Some(value) = jump_secret.as_mut() {
        value.zeroize();
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| "Mosh bootstrap channel open failed".to_string())?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| "Mosh bootstrap launch failed".to_string())?;
    let mut stream = channel.into_stream();
    let output = read_bounded(&mut stream).await?;
    let (port, key) = parse_connect(output.as_slice())?;
    let _ = session
        .disconnect(Disconnect::ByApplication, "Mosh bootstrap complete", "en")
        .await;

    Ok(MoshBootstrapResult {
        // A jump host only transports SSH bootstrap. Mosh UDP always targets
        // the configured destination directly and is never tunneled.
        udp_host: request.connection.hostname,
        port,
        key,
    })
}

#[tauri::command]
pub async fn mobile_mosh_bootstrap_start(
    app: AppHandle,
    sessions: State<'_, MoshSessions>,
    request: MoshBootstrapStartRequest,
) -> Result<MoshStartResult, String> {
    let result = bootstrap(&app, request.bootstrap).await?;
    mobile_mosh_start(
        sessions,
        MoshStartRequest {
            ip: result.udp_host,
            port: result.port,
            key: result.key,
            cols: request.cols,
            rows: request.rows,
            prediction_mode: request.prediction_mode,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_parser_is_exact_and_bounded() {
        let (port, key) =
            parse_connect(b"notice\nMOSH CONNECT 60001 AbCdEfGhIjKlMnOpQrStUv\n").unwrap();
        assert_eq!(port, 60001);
        assert_eq!(key.as_str(), "AbCdEfGhIjKlMnOpQrStUv");
        assert!(parse_connect(b"MOSH CONNECT 60001 short\n").is_err());
        assert!(parse_connect(b"MOSH CONNECT 60001 AbCdEfGhIjKlMnOpQrStUv extra\n").is_err());
        assert!(parse_connect(b"MOSH CONNECT 60001 AbCdEfGhIjKlMnOpQrStUv\nMOSH CONNECT 60002 AbCdEfGhIjKlMnOpQrStUv\n").is_err());
    }

    #[test]
    fn bootstrap_never_installs_and_validates_mode_contract() {
        let shell = bootstrap_command(MoshBootstrapMode::Shell, None).unwrap();
        assert!(shell.contains("command -v mosh-server"));
        assert!(!shell.contains("apt") && !shell.contains("brew install"));
        assert!(bootstrap_command(MoshBootstrapMode::Shell, Some("ses_1")).is_err());
        let attach = bootstrap_command(MoshBootstrapMode::AgentSession, Some("ses_1")).unwrap();
        assert!(attach.ends_with("\"$attach\" --session ses_1"));
        assert!(attach.contains("/Applications/AgentPort.app/Contents/MacOS/agentport-mosh-attach"));
        assert!(bootstrap_command(MoshBootstrapMode::AgentSession, Some("bad id")).is_err());
    }

    #[test]
    fn missing_server_and_attach_are_actionable() {
        assert!(parse_connect(format!("{MISSING_SERVER}\n").as_bytes())
            .unwrap_err()
            .contains("macOS or Ubuntu"));
        assert!(parse_connect(format!("{MISSING_ATTACH}\n").as_bytes())
            .unwrap_err()
            .contains("desktop package"));
    }
}
