# AI Companion Nova

Foundation Hardening v0.2 for an extensible desktop AI companion.

Architectural rule: Modules depend on contracts, not on implementations.

The repository separates Contracts, Core, Modules, Providers, Host and a Composition Root. Core does not know concrete AI vendors, browser engines, renderers or OS drivers.

Run:
pnpm install
pnpm generate:schemas
pnpm typecheck
pnpm build
pnpm test

Rust:
cargo check --workspace
cargo check --workspace --all-features

Security boundary: dangerous actions pass through the Action Broker. Identity is separate from the untrusted request payload. Risk comes from canonical ToolDefinition policy; actual target is resolved before permission checks.

See docs/security.md, docs/contracts.md and docs/runtime.md.
