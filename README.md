# AI Companion Nova

Extensible Foundation for a desktop AI companion.

## Architectural law

> Modules depend on contracts, not on implementations.

The Foundation separates:
- contracts and JSON Schemas
- Core lifecycle/orchestration
- modules and providers
- privileged Host boundary
- React UI and Tauri IPC

Production integrations are intentionally deferred. Fake providers/modules make the Core usable offline and without API keys.

## Commands

With pnpm:
```bash
pnpm install
pnpm test
```

Rust host:
```bash
cargo check --workspace
```

## Adding a module

Implement `CompanionModule`, use only Contracts/SDK/Events/Services, and register the module at the composition root. Do not import another module implementation.

## Adding a provider

Implement the relevant provider contract and register it in `ProviderRegistry`. Core does not know the provider name.
