# AgentsPort Privacy Policy

Effective date: 17 October 2026

Publisher: jin wen

Privacy contact: [tiandrive@icloud.com](mailto:tiandrive@icloud.com)

## Our approach

AgentsPort is a remote terminal and a mobile client for compatible AgentPort computers. You choose and configure the computers and optional Relay services it connects to.

The publisher does not collect user information from the App or operate a Relay data-collection service for its users. The App does not require an account with the publisher. This does not mean that the App processes no data: it keeps information on your device and communicates with the servers and services you use, as explained below.

## Information on your device

To provide its features, the App stores or processes:

- Connection profiles, including names, host addresses and ports, SSH usernames, connection preferences, trusted host fingerprints, pairing identities and related settings.
- Passwords, SSH private keys and private pairing identities through its secure credential-storage integration. Connection profiles refer to credential handles rather than embedding these secrets.
- Terminal shortcut records, interface and terminal preferences, and workspace settings.
- Local notification and inbox records, which can include host/session identifiers, timestamps, event types, read state and session titles.
- Temporary downloads, selected-image copies and local diagnostic logs needed to operate or troubleshoot the App.

Operating-system protections and backup/keychain behavior apply to this local information. Removing the App must not be assumed to erase operating-system keychain records, backups or copies held elsewhere.

## Connections to your hosts and Relay services

Your selected host processes the information needed for your requested operations. This can include authentication information, terminal input and output, commands, project and session information, paths, files and selected images.

SSH password authentication sends the password through the authenticated SSH connection. SSH public-key authentication proves possession of the key rather than uploading the private key. Mosh uses an initial SSH connection to start its remote service and then its terminal transport. A configured jump host can observe the destination address and port.

Relay services are configured by users, not operated as a publisher collection service. **In the current realtime Relay mode, WSS terminates at the Relay, allowing that Relay to read the session data it forwards.** This may include terminal interactions, requests and responses, and files or images sent through the session. Other compatible modes may retain an additional encryption layer. The App does not promise that every Relay connection hides its content from the Relay operator: use a Relay you trust.

Your chosen network services can also observe connection metadata such as IP addresses, timing and traffic volume. Their logging, retention, access controls and deletion practices are determined by their operators, not by this policy. Choosing a server yourself does not mean that the server cannot process or retain data.

## Optional iOS notifications

The App asks for permission to show system notifications. When notifications and a compatible paired Connector are configured, Apple supplies an APNs device token to the App. The App registers that token with the approved paired computer using a dedicated Noise-encrypted control channel, separate from the readable realtime Relay session stream.

The Connector stores the token and device-authorization information needed for notifications. The configured notification sender sends the token and notification payload to Apple APNs. The implemented sender uses generic event text and opaque host/session routing identifiers, rather than terminal commands, file paths or terminal output.

Apple and the notification provider configured for your paired computer process the information needed for delivery under their own practices. You can change notification permission in iOS Settings. Revoking a paired device on its host is a separate operation.

## Files, images and other destinations

Downloads come from the host/session you choose and are temporarily stored in the App's private cache. The App attempts cleanup when downloads are cancelled or discarded, after saving, and at startup. Cleanup can fail. Files you save or share outside the App remain under the control of the destination you select.

When you select an image to upload, its contents are sent to your chosen host. Images may retain embedded metadata. Cleaning up a local temporary copy does not automatically delete a successfully uploaded remote copy.

An external HTTPS image referenced by Markdown can contact the image website and accepted redirect destinations. Those services can receive your IP address, requested URL and timing. File providers, cloud storage and other apps you choose for saving or sharing also process the content under their own practices.

## Permissions and diagnostics

Camera access is used to scan a short-lived pairing code. Local-network access is used to pair with and connect to your computer. Image/file selection and notifications are used when you choose or enable those features.

The App writes limited, rotating diagnostic logs locally. These can contain timestamps, lifecycle details, identifiers and error context; do not assume a diagnostic file contains no sensitive information. The reviewed diagnostic writer does not automatically upload its logs to the publisher.

The App's reviewed direct dependencies and initialization do not include a dedicated advertising, product-analytics or crash-reporting SDK. The publisher does not use the App to collect user information. These statements do not govern the independent services you configure or external content you access.

## Your choices and retention

You can manage connections and settings in the App, disable notifications in iOS Settings, stop using a server, and revoke a paired device on its host. Local preferences and records support their respective features until changed or removed by the applicable App or operating-system controls. Cancelling or letting a pairing attempt expire does not necessarily delete its pending local identity.

There is no publisher-operated App-data collection service for which a retention period is specified. Data held by your chosen hosts, Relay operators, notification providers, external storage or backups follows those services' own rules. To delete remote records or external file copies, use the relevant service's controls or contact its operator.

## Contact and policy updates

For privacy questions, contact [tiandrive@icloud.com](mailto:tiandrive@icloud.com). If you voluntarily send email or open a GitHub issue, the information you choose to include is available to its recipients and the relevant email or website provider. We use such communications to handle your request. Do not send passwords, private keys or private terminal content in public issue reports.

We will review this policy and the App Store privacy declaration if the App's features or service model change. The effective date above identifies this version of the policy.
