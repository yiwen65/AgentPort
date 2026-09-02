# Third-party licenses and mobile license boundary

AgentPort Mobile is licensed under **GPL-3.0-only**. This file is an engineering inventory, not legal advice; refresh it from the final lockfiles before distribution.

| Component | Intended license | Use |
|---|---|---|
| Tauri 2 | Apache-2.0 OR MIT | Mobile application runtime |
| React / React DOM | MIT | UI |
| xterm.js and addons | MIT | Terminal rendering |
| i18next / react-i18next | MIT | Localization |
| russh / russh-sftp (candidate, not yet locked) | Apache-2.0 | SSH and SFTP transport |
| Mosh (not yet vendored) | GPLv3 or later upstream | Mobile realtime terminal transport |

Mosh code and bindings must remain inside the GPL mobile product boundary. MIT AgentPort desktop/Core/Service/Bridge/protocol crates must not link GPL Mosh code. Upstream Mosh source, modifications, notices and GPL text must accompany any distributed mobile build as required by the applicable license.
