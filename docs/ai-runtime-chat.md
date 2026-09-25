# AI Runtime + Chat Provider Layer

This phase provides the provider-neutral AI application layer above ProviderRegistry and the first real OpenAI-compatible HTTP adapter.

## Chat contracts

The canonical v1 contracts live under contracts/schemas and are mirrored into contracts/src/index.ts. The checked-in TypeScript schema catalog is generated from those JSON Schema files.

- ChatMessage: system, user, assistant and extensible tool-related messages.
- ChatContext: conversation/session id, ordered messages and optional metadata.
- ChatGenerationOptions: vendor-neutral generation controls.
- ChatRequest: versioned request with model, optional provider selection and context.
- ChatResponse: normalized assistant response with provider/model identity, finish reason, usage and metadata.
- ChatError: stable provider-neutral error vocabulary.

Streaming is intentionally deferred.

## Chat Provider

The ChatProvider interface is a Contracts-layer port. Concrete provider adapters under providers/ implement it. Core never imports vendor SDKs, HTTP transports or credential implementations.

Each provider exposes identity/metadata, capabilities, model listing, health and canonical chat generation.

Current chat providers:

- fake.chat: deterministic offline provider used by Foundation.
- openai-compatible: synchronous OpenAI-compatible Chat Completions adapter.

The OpenAI-compatible adapter uses a provider-local HttpClient abstraction, the existing CredentialStore contract and standard fetch in production. It does not add a vendor SDK.

## OpenAI-compatible adapter

providers/chat/openai-compatible implements:

Contracts
→ ChatProvider
→ OpenAI-compatible adapter
→ HTTP

The adapter supports system/user/assistant messages, model, temperature, maxTokens, topP and text responses. Tool messages/tool-call metadata and structured JSON output are rejected as unsupported.

The provider id is openai-compatible and its advertised capabilities are streaming=false, toolCalling=false, structuredOutput=false and reasoning=false.

It performs no network request for health() and listModels(). Configuration is application-controlled through the Composition Root; the default Foundation runtime does not register the real provider.

See providers/chat/openai-compatible/README.md for credential flow, custom base URLs, error mapping and development configuration.

## AI Runtime

core/src/ai-runtime.ts performs orchestration only:

1. Validate the canonical request.
2. Resolve a registered chat provider through ProviderRegistry.
3. Emit runtime events.
4. Invoke the provider.
5. Normalize provider/model/request identity into the canonical response.
6. Validate the canonical response.
7. Preserve a validated canonical ChatError when a provider reports one; otherwise normalize unexpected provider failures to PROVIDER_ERROR.
8. Record safe diagnostics without terminating Foundation.

The AI Runtime has no filesystem, shell, browser, process, credential or Action Broker access and never executes tools.

## Composition Root

runtime/bootstrap is the single concrete wiring location. It always registers the deterministic fake chat provider. The OpenAI-compatible provider is registered only when explicit application-controlled configuration plus a CredentialStore are supplied.

This keeps the installed Foundation usable without an API key while allowing development/runtime wiring to select the real provider explicitly.

## Events

ChatRequestStarted, ChatResponseReceived and ChatRequestFailed are informational EventBus events. They do not execute actions.

## Deferred future phases

Streaming, tool/function calling, automatic retries/backoff, real remote model discovery, conversation persistence, memory integration, personality/context enrichment, TTS, STT, vision, autonomous planning and browser/computer use remain outside this phase.
