# Security

The bridge runs as root on the LG TV and uses an authorized Fire TV ADB key.
Keep both devices on a trusted LAN and protect SSH and ADB access.

Pairing tokens and the dedicated ADB key live under `.state/` on the installer
and `/media/developer/magic-fire/` on the TV. Personal settings, credentials,
logs, and captures are excluded from Git. Deployment installs credentials
with owner-only permissions. Backups of these directories are credentials too.

The Fire TV LAN service provides a TLS certificate that this client does not
validate against a trusted certificate authority. The static `x-api-key` in
source is a protocol identifier; the private pairing token is the credential.
ADB uses a separate dedicated key. Voice audio is streamed during a held mic
press and is not saved by this bridge. Alexa processes it according to your
Amazon settings.

Use GitHub private vulnerability reporting when available. Do not publish
live tokens or keys in an issue. If credentials leak, revoke the paired
remote and ADB key on Fire TV and provision new credentials.
