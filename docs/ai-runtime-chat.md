# AI Runtime + Chat Provider Layer

This phase adds the first provider-neutral AI application layer above ProviderRegistry.

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

Each provider exposes identity/metadata, capabilities, model listing, health and canonical chat generation. The current fake provider is deterministic and offline.

## AI Runtime

core/src/ai-runtime.ts performs orchestration only:

1. Validate the canonical request.
2. Resolve a registered chat provider through ProviderRegistry.
3. Emit runtime events.
4. Invoke the provider.
5. Normalize provider/model/request identity into the canonical response.
6. Validate the canonical response.
7. Convert provider failures into AiRuntimeError / ChatError.
8. Record diagnostics without terminating Foundation.

The AI Runtime has no filesystem, shell, browser, process, credential or Action Broker access and never executes tools.

## Composition Root

runtime/bootstrap is the single concrete wiring location. It creates ProviderRegistry, registers the offline mock chat provider and constructs AiRuntime. The UI does not construct providers.

## Events

ChatRequestStarted, ChatResponseReceived and ChatRequestFailed are informational EventBus events. They do not execute actions.

## Deferred future phases

OpenAI, Anthropic, local model providers, streaming, tool/function calling, memory integration, personality/context enrichment, TTS, STT, vision, autonomous planning and browser/computer use are intentionally outside this phase.
