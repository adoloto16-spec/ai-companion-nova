# Security Boundary

The Action Broker receives an ActionInvocation with an ActorIdentity separate from the untrusted action payload.

Canonical tool policy controls risk, capabilities, resource type, action type, parameter schema, target resolver and confirmation policy.

Actual targets are resolved from validated arguments before permission evaluation. The request cannot declare the target scope it wants to be trusted.

Domain policy treats an allowed domain as the exact domain or a subdomain: youtube.com matches www.youtube.com but not evil-youtube.com.

Filesystem policy normalizes paths, rejects escape above a Windows-style root, and requires a canonicalized target before root checks pass. A future Host resolver is responsible for real filesystem canonicalization and symlink safety.

Application policy matches application ids and optionally window ids.

Capability context is scoped in runtime. AllowAllCapabilityContext exists only as an explicit test helper.

CredentialStore stores secrets behind references. Audit records only argument keys and sanitized metadata; it does not record API keys or credential values.

Tauri capability configuration grants only minimal core permissions and no shell, filesystem, process or automation plugin permissions. CSP is enabled.
