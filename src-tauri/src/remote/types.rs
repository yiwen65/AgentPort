//! Shared device profile types for the desktop's remote-device registry.
//!
//! A `DeviceProfile` is everything the registry (T-003) persists per paired
//! device — never secret material. SSH secrets live in the platform keychain
//! under `authRef`; the relay transport authenticates with the installation's
//! client identity (see `identity.rs`) instead of a per-device secret.

use agentport_relay::protocol::Peer;
use serde::{Deserialize, Serialize};

use crate::remote::manager::{DeviceConnectionInfo, DeviceTransport};
use crate::remote::ssh::{SshSecret, SshTarget};
use crate::remote::RemoteCommandError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceProfile {
    pub id: String,
    pub name: String,
    pub transport: DeviceTransportProfile,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DeviceTransportProfile {
    Ssh {
        hostname: String,
        port: u16,
        username: String,
        /// Keychain account holding the SSH password or private key PEM.
        auth_ref: String,
    },
    Relay {
        /// Connector coordinates captured at pairing time (public key pinned).
        peer: Peer,
    },
}

impl DeviceProfile {
    /// Converts the persisted profile into the manager's runtime connection
    /// info. `secret` is the resolved SSH credential (T-003 credential store);
    /// relay profiles ignore it.
    #[allow(dead_code)] // primary consumer is the T-003 registry resolver
    pub fn connection_info(
        &self,
        secret: Option<SshSecret>,
    ) -> Result<DeviceConnectionInfo, RemoteCommandError> {
        let transport = match &self.transport {
            DeviceTransportProfile::Ssh {
                hostname,
                port,
                username,
                ..
            } => DeviceTransport::Ssh(SshTarget {
                host: hostname.clone(),
                port: *port,
                username: username.clone(),
            }),
            DeviceTransportProfile::Relay { peer } => {
                peer.validate().map_err(|error| {
                    RemoteCommandError::new("device_profile_invalid", error.to_string())
                })?;
                DeviceTransport::Relay(peer.clone())
            }
        };
        Ok(DeviceConnectionInfo {
            device_id: self.id.clone(),
            display_name: Some(self.name.clone()),
            transport,
            secret,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay_profile() -> DeviceProfile {
        let identity = agentport_relay::crypto::Identity::generate().unwrap();
        let peer = identity
            .peer(
                "ws://127.0.0.1:9/v1/relay".to_string(),
                "Fixture computer".to_string(),
            )
            .unwrap();
        DeviceProfile {
            id: "dev_test".to_string(),
            name: "Fixture computer".to_string(),
            transport: DeviceTransportProfile::Relay { peer },
            created_at: "2026-09-23T00:00:00Z".to_string(),
            last_connected_at: None,
            last_error: None,
        }
    }

    #[test]
    fn profile_round_trips_as_camel_case_json() {
        let profile = relay_profile();
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(json["transport"]["kind"], "relay");
        assert_eq!(
            json["transport"]["peer"]["relayUrl"],
            "ws://127.0.0.1:9/v1/relay"
        );
        let restored: DeviceProfile = serde_json::from_value(json).unwrap();
        assert_eq!(restored.id, profile.id);
        assert_eq!(restored.name, profile.name);
    }

    #[test]
    fn relay_profile_resolves_to_connection_info() {
        let info = relay_profile().connection_info(None).unwrap();
        assert_eq!(info.device_id, "dev_test");
        assert_eq!(info.display_name.as_deref(), Some("Fixture computer"));
        assert!(matches!(info.transport, DeviceTransport::Relay(_)));
    }

    #[test]
    fn ssh_profile_resolves_to_connection_info() {
        let profile = DeviceProfile {
            id: "dev_ssh".to_string(),
            name: "Linux box".to_string(),
            transport: DeviceTransportProfile::Ssh {
                hostname: "192.168.1.10".to_string(),
                port: 22,
                username: "alice".to_string(),
                auth_ref: "cred_dev_ssh".to_string(),
            },
            created_at: "2026-09-23T00:00:00Z".to_string(),
            last_connected_at: None,
            last_error: None,
        };
        let info = profile.connection_info(None).unwrap();
        match info.transport {
            DeviceTransport::Ssh(target) => {
                assert_eq!(target.host, "192.168.1.10");
                assert_eq!(target.port, 22);
                assert_eq!(target.username, "alice");
            }
            _ => panic!("expected ssh transport"),
        }
    }

    #[test]
    fn invalid_relay_peer_is_rejected_at_conversion() {
        let mut profile = relay_profile();
        if let DeviceTransportProfile::Relay { peer } = &mut profile.transport {
            peer.public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string();
        }
        let error = profile.connection_info(None).unwrap_err();
        assert_eq!(error.code, "device_profile_invalid");
    }
}
