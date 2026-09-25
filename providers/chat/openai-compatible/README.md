# OpenAI-Compatible Chat Provider V1

This provider adapts an OpenAI-compatible Chat Completions style HTTP API to the canonical ChatProvider contract.

## Identity and capabilities
Provider id: openai-compatible

Capabilities:
- streaming: false
- toolCalling: false
- structuredOutput: false
- reasoning: false

The adapter is synchronous and returns one canonical ChatResponse.

## Configuration
The adapter receives a provider-local configuration object:
- baseUrl: deliberate application-controlled HTTP(S) base URL. The adapter appends /chat/completions.
- model: one configured model id. A ChatRequest.model must match this configured model.
- credential: existing CredentialReference.
- timeoutMs: optional finite request timeout; default is 30 seconds.

There is no new configuration framework. The Composition Root accepts this configuration through createFoundationRuntime({openAICompatible:{...}}) / startFoundationRuntime({...}).
The default runtime does not register this provider, so the desktop Foundation still starts without any API credential.
Custom compatible servers are supported by supplying their deliberate base URL. The base URL must use HTTP or HTTPS and cannot contain userinfo, query or fragment components.

## Credential flow
The adapter receives an existing CredentialStore implementation and resolves the configured CredentialReference immediately before the outbound request.
Authorization is created only at the HTTP boundary: Authorization: Bearer <resolved secret>.
The secret is never copied into canonical request data, diagnostics, errors, events or provider metadata.
Production desktop wiring now resolves the existing CredentialStore through the privileged Tauri Host. On Windows the Host uses the Windows Credential Manager Generic Credential API. The provider receives only an opaque CredentialReference and never owns or persists the raw secret.

Development selection is explicit in the Composition Root:

~~~ts
const credentialStore = new InMemoryCredentialStore();
await credentialStore.setSecret(
  {id:"openai-compatible-development",kind:"api-key",provider:"openai-compatible"},
  "<development secret>"
);

const runtime = await createFoundationRuntime({
  openAICompatible:{
    config:{
      baseUrl:"https://example-compatible-server.invalid/v1",
      model:"configured-model",
      credential:{id:"openai-compatible-development",kind:"api-key",provider:"openai-compatible"},
      timeoutMs:30000
    },
    credentialStore
  }
});
~~~

Do not commit real secrets.

## HTTP mapping
Canonical messages are mapped in order:
- system -> system
- user -> user
- assistant -> assistant
Canonical tool messages and tool-call metadata are rejected as unsupported rather than silently rewritten.
Generation mapping:
- temperature -> temperature
- maxTokens -> max_tokens
- topP -> top_p
- synchronous operation -> stream: false
Only explicitly supplied generation values are sent.
The adapter posts JSON to <baseUrl>/chat/completions.

## Response mapping
The first response choice must contain assistant text content.
Mapped values include request id, conversation id, provider id, response model, assistant text, finish reason and usage when available.
Finish reasons are normalized to stop, length, content_filter, error and unknown.
Raw provider response objects never cross the adapter boundary.

## Errors
The adapter normalizes failures into canonical ChatError values.
Covered categories include invalid provider configuration, missing credential, timeout, network/connection failure, HTTP 400, 401, 403, 404, 429, 500+, malformed JSON, malformed provider response, missing assistant message/content, unsupported tool messages and unsupported structured JSON output.
Diagnostics retain only safe details such as provider id, model, request id, normalized category, HTTP status and duration. Raw response bodies, prompts, full model responses and authorization headers are not recorded.

## Health and models
health() performs no network request.
- unavailable for invalid configuration
- unavailable when the credential cannot be resolved
- healthy when local configuration and credential resolution succeed
listModels() returns only the configured model metadata and does not call a remote model-listing endpoint.

## Offline testing
Provider tests use a fake HttpClient and fake CredentialStore. No external network is used by the test suite.
The provider is also exercised through ProviderRegistry, AiRuntime and the Composition Root.

## Security limitations
The provider has no filesystem, shell, browser, Tauri, Action Broker or module access.
The endpoint is application-controlled configuration. Model output cannot redefine the provider base URL.
Automatic retry/backoff is intentionally not implemented.

## Deferred work
- streaming
- tool/function calling
- automatic retries/backoff
- real remote model discovery
- conversation persistence
- memory integration
- personality/context enrichment
- TTS/STT
- vision
- autonomy
- browser/computer use
