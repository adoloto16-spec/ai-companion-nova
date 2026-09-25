# Runtime Composition

runtime/bootstrap is the composition root.

It constructs EventBus, StateStore, diagnostics, ProviderRegistry, ToolRegistry, permission/foreground/risk/confirmation services, Action Broker, ModuleManager and offline fake providers/modules.

Core does not import the composition root.

The current desktop Foundation starts the TypeScript runtime in the frontend process so the UI can observe real ModuleManager and ProviderRegistry state. Rust/Tauri remains the privileged Host boundary and provides host-only diagnostics through IPC.

This is intentional for Foundation. Later production builds can move or split composition while preserving the Contracts/Core/Module interfaces.


## AI Runtime

runtime/bootstrap remains the only composition root. It now constructs the provider-neutral AiRuntime and binds it to ProviderRegistry plus the offline fake ChatProvider.

Core consumes canonical Chat contracts only. Provider-specific SDKs, transports, authentication and secrets remain outside Core.

Chat failures are normalized into stable AiRuntimeError / ChatError values and recorded in diagnostics. A provider failure does not terminate Foundation or make the AI Runtime unhealthy while a chat provider remains registered.

The chat layer is intentionally non-streaming in this phase. Real providers, streaming, tool calling and context enrichment are deferred.
