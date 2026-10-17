# AgentsPort privacy notice — DRAFT

**Not approved for publication.** This is a source-backed draft for the iOS 1.0.0 release, prepared on 17 October 2026. The publisher has confirmed that users configure their own Relay servers and that the publisher does not collect user information through this App. A corresponding App Store “Data Not Collected” questionnaire draft has been saved, but its Publish action has not been taken. The operator/contact details, final wording and public hosting location below still need approval.

## 1. Scope

AgentsPort is a remote terminal and a mobile client for compatible AgentPort computers. It connects to hosts and optional Relay services configured by the user. A remote host, Relay operator, notification provider, image website or file-sharing destination may have its own privacy practices. This notice must distinguish those services from services actually operated by the App's publisher.

**App operator and privacy contact: pending confirmation.**

## 2. Information stored on your device

To provide its features, the App stores or processes:

- Connection profiles, including the names you assign, host addresses and ports, SSH usernames, connection preferences, trusted host fingerprints, Relay identities, pairing state and related connection settings.
- Passwords, SSH private keys and private pairing identities through the App's secure credential-storage integration. Profiles refer to credential handles rather than embedding the secrets. This draft does not make unverified promises about operating-system backups or Keychain deletion after uninstalling.
- Local terminal shortcut records, such as a terminal name, associated host, shell/tmux choice and optional tmux session name.
- Interface and terminal appearance settings, workspace preferences and local notification/inbox state. Inbox entries can include host/session identifiers, timestamps, event types, read state and session titles.
- Temporary downloaded files and selected-image copies needed for the file and image features.
- Local diagnostic logs containing timestamps, lifecycle events and error/context information. The diagnostic writer limits and rotates its files, but does not automatically redact arbitrary strings passed to it. Do not assume a diagnostic log is free of identifiers or other sensitive context.

## 3. Data sent to the services you connect to

Your selected host processes the information needed for your requested operation. This can include authentication information, pairing identifiers, terminal input and output, commands, project and session information, file paths, file contents, selected images and connection metadata.

SSH password authentication sends the password through the authenticated SSH connection. SSH public-key authentication proves possession of the private key rather than uploading the private key. Mosh uses an initial authenticated SSH connection to start the remote service, followed by its terminal transport. A configured jump host can receive the destination address and port.

### Relay visibility

Relay connections use authenticated device identities and encrypted network transport. However, **the realtime Relay mode supported by the current client and Connector terminates its WSS transport at the Relay, allowing the Relay to read forwarded session data.** That data may include terminal interaction, RPC requests and responses, and files or images sent over the session stream. Do not use a Relay operator you do not trust with this information.

Some older Connector sessions retain an additional Noise encryption layer. This does not justify claiming that every Relay connection is end-to-end encrypted against the Relay operator. Pairing and push-token registration use separate control paths with different protections, described below.

The network services you use can also observe connection metadata such as IP addresses, timing and traffic volume. Whether a host or Relay logs or retains data depends on that service's actual configuration and operator. These are user-configured services; their processing is distinct from the publisher collecting user information through the App.

## 4. Optional notifications

On iOS, the App requests permission before enabling visible system notifications. When notifications and a compatible paired Connector are configured:

- Apple provides an APNs device token and permission/environment information to the App.
- The App registers that token with the approved paired computer using a dedicated Noise-encrypted control channel; it does not fall back to the readable realtime session stream for this registration.
- The Connector stores the registered token, environment and device-authorization information so it can deliver notifications.
- The configured notification provider sends the token and notification payload to Apple APNs. The implemented sender uses generic event text and opaque host/session routing identifiers, rather than terminal commands, file paths or terminal output.

Apple and the notification provider configured for the paired computer process the data needed for delivery. This is not a declaration of a publisher-operated collection backend. Those services' actual retention is not established by the mobile source review. You can change notification permission in iOS Settings; removing a paired device's authorization on the host is a separate operation.

## 5. Files, images and external destinations

- Downloads come from the host/session you choose and are temporarily stored in the App's private cache. The App attempts cleanup on cancellation, disposal, completed saving and subsequent startup. Cleanup can fail, and saving or sharing creates copies outside the App's control.
- When you choose an image to upload, its contents are sent to your selected host. The upload implementation does not establish that embedded image metadata has been removed. A successfully uploaded remote copy is not automatically deleted merely because a local temporary copy is cleaned up.
- Loading an external HTTPS image referenced by Markdown can contact the image website and any accepted redirect destination. Such a service can receive your IP address, requested URL and timing. An anonymous request is not an assurance that no data is disclosed.
- File providers, cloud storage or other apps you choose in the system save/share interface process the shared content under their own practices.

## 6. Permissions

The App's iOS permission descriptions identify camera access for scanning a short-lived pairing code and local-network access for pairing with and connecting to your computer. System image/file selection and notification features operate when you use or enable them. Permission descriptions alone do not prove that no other data is processed.

## 7. Publisher collection and third-party processing

The publisher confirms that Relay servers are configured by users and that the publisher does not collect user information through this App. The reviewed connection paths use user-supplied profiles/invitations rather than a discovered default publisher collection service. The reviewed direct mobile dependencies and initialization did not identify a dedicated advertising, product-analytics or crash-reporting SDK.

This does not mean that the App processes no data: it stores local information and communicates with the hosts, Relay services, notification infrastructure and image/file destinations described above. A user-configured server's own processing must not be confused with collection by the App's publisher. The static review does not establish third-party retention practices or constitute an audit of every transitive dependency.

If you voluntarily contact the publisher through email or GitHub, that separate communication necessarily includes the information you choose to send. Do not include credentials or private terminal content in public issue reports. Any change that introduces publisher collection, analytics or tracking must be reflected in the final policy and App Store privacy declaration.

## 8. Retention and controls

Local settings and records remain available for their relevant features until changed, removed or cleared by applicable App/operating-system controls. Temporary files have the cleanup behavior described above. These statements do not specify a universal retention deadline for every local or remote data category.

Removing a profile, cancelling a pairing attempt or uninstalling the App must not be treated as a guarantee that credentials, host/Relay records, notification registrations, external file copies or backups have all been deleted. In particular, cancelled/expired pairing attempts can retain their pending local identity. Remote device revocation and service-side deletion may require separate action by the relevant operator.

No retention period for a publisher-operated App-data collection service is specified, because the publisher has declared that it does not collect user information through the App. User-operated or third-party services and external copies remain subject to their own controls. The final privacy-contact address and handling of voluntary support requests still require confirmation.

## 9. Contact and changes

The final policy will identify the responsible operator and a functioning privacy-contact address. Requests relating to a third-party or user-operated host, Relay or storage destination may also need to be directed to that service's operator. Changes to actual features or service practices require this notice and the App Store privacy declaration to be reviewed again.

## Operator confirmation required before publication

1. Legal/publishing operator name, privacy-contact email and effective date.
2. Confirmed by the publisher: Relay servers are user-configured and the publisher does not collect user information through this App. The corresponding App Store questionnaire is saved as an unpublished “Data Not Collected” draft.
3. Privacy-request contact and any description of handling voluntary support messages outside the App. Do not invent retention/deletion guarantees for arbitrary user-operated hosts or third-party services.
4. Recheck this notice if the service model, SDKs, analytics or tracking practices change.
5. Public hosting location and approval of the final wording. This file is not yet an approved public policy URL, and saving the questionnaire draft is not authorization to press Publish.

## Internal evidence notes — remove before public policy publication

- Profiles/credentials: `src-tauri/src/hosts/mod.rs`, `src-tauri/src/credentials/mod.rs`, `src-tauri/src/relay_pairing.rs`.
- Relay/SSH/Mosh: `src-tauri/src/remote.rs`, `src-tauri/src/ssh/mod.rs`, `src-tauri/src/mosh/bootstrap.rs`; `../crates/agentport-relay/src/endpoint.rs::connect_session_realtime` and Connector realtime negotiation.
- Notifications: `src-tauri/ios/PushBridge.mm`, `src-tauri/src/ios_push.rs`, Relay `register_push_token` / Connector `register_push` and APNs sender.
- Local inbox/diagnostics: `src/features/sessions/attentionInbox.ts`, `src-tauri/src/lib.rs::mobile_diag_log`.
- Files/images: `src-tauri/src/file_download.rs`, `src-tauri/src/sftp/image.rs`, `src-tauri/src/markdown_images.rs`.
- Dependency/permission scope: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/Info.ios.plist`.

This was a bounded static review. It did not inspect private credentials, execute traffic capture, audit every dependency, or verify deployed server logs, retention, account ownership or third-party practices.
