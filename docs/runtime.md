# Runtime Composition

runtime/bootstrap is the composition root.

It constructs EventBus, StateStore, diagnostics, ProviderRegistry, ToolRegistry, permission/foreground/risk/confirmation services, Action Broker, ModuleManager and the Foundation providers/modules.

Core does not import the composition root.

The current desktop Foundation starts the TypeScript runtime in the frontend process so the UI can observe real ModuleManager and ProviderRegistry state. Rust/Tauri remains the privileged Host boundary and provides host-only diagnostics through IPC.

This is intentional for Foundation. Later production builds can move or split composition while preserving the Contracts/Core/Module interfaces.

## Providers

The Composition Root always registers the deterministic FakeChatProvider plus the Foundation fake TTS/STT/embedding/vision providers.

The OpenAI-compatible ChatProvider is optional. It is registered only when createFoundationRuntime/startFoundationRuntime receive explicit openAICompatible configuration containing:

- provider-local base URL/model/credential reference configuration
- an existing CredentialStore
- an optional provider-local HttpClient for deterministic tests

No API credential is required for normal startup, and the desktop UI does not construct providers directly.

## AI Runtime

runtime/bootstrap constructs the provider-neutral AiRuntime and binds it to ProviderRegistry.

Core consumes canonical Chat contracts only. Provider-specific SDKs, transports, authentication and secrets remain outside Core.

Provider failures that expose a validated canonical ChatError are preserved as stable AiRuntimeError values. Unexpected provider exceptions remain normalized to PROVIDER_ERROR.

The chat layer is intentionally non-streaming. Tool calling and other deferred capabilities remain outside this phase.
