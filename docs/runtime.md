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

## Chat Experience V1

The desktop UI uses a non-persistent ConversationSession for the currently open conversation. It stores only canonical ChatMessage values in memory and is cleared on application restart.

ChatSessionController owns the minimal send-state transition:

~~~text
User
  ↓
Chat UI
  ↓
ConversationSession / ChatSessionController
  ↓
FoundationRuntime.chat()
  ↓
AiRuntime
  ↓
active provider
  ↓
ChatResponse
  ↓
assistant message
  ↓
Chat UI
~~~

The controller rejects empty and duplicate submissions, preserves the user message on provider errors, adds an assistant message only after a successful canonical ChatResponse, and exposes only stable user-facing error text. No provider credential or provider-specific object enters the session.

The Foundation runtime exposes the active chat model to the UI while keeping provider selection application-controlled. The UI never supplies a provider id for ordinary chat requests.

Conversation history is passed as the current ChatContext on each non-streaming request. Conversation state is not memory, is not persisted, and is not used by any other module.

The Settings UI remains available alongside Chat and continues to own provider configuration, credential administration, connection testing and diagnostics.
