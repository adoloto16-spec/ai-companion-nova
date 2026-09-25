# Runtime Composition

runtime/bootstrap is the composition root.

It constructs EventBus, StateStore, diagnostics, ProviderRegistry, ToolRegistry, permission/foreground/risk/confirmation services, Action Broker, ModuleManager and offline fake providers/modules.

Core does not import the composition root.

The current desktop Foundation starts the TypeScript runtime in the frontend process so the UI can observe real ModuleManager and ProviderRegistry state. Rust/Tauri remains the privileged Host boundary and provides host-only diagnostics through IPC.

This is intentional for Foundation. Later production builds can move or split composition while preserving the Contracts/Core/Module interfaces.
