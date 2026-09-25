# Secure Provider Configuration V1

## Architecture

Provider configuration is split between non-secret application settings and OS-backed credentials:

```text
Settings UI
   ├── non-secret provider configuration
   │      ↓
   │   Tauri Host
   │      ↓
   │   app config JSON
   │
   └── API credential
          ↓
      CredentialStore
          ↓
 Windows Credential Manager
```

The React/TypeScript side never calls a Windows credential API. The privileged Tauri Host exposes only four credential commands: save, retrieve, delete and existence check. Each command accepts a validated opaque `CredentialReference`; the Host does not expose arbitrary Windows Credential Manager targets.

## Credential storage

The production Windows implementation uses the Windows Credential Manager Generic Credential API through `CredWriteW`, `CredReadW`, `CredDeleteW` and `CredFree`.

Credential references are application-owned. The supported v1 target is an OpenAI-compatible API-key reference. The Host derives the Windows target name from the opaque reference after validating its provider, kind and identifier. The raw secret is not written to application config, SQLite, localStorage, sessionStorage, URL state, repository files or logs.

The existing TypeScript `CredentialStore` abstraction remains unchanged. `IpcCredentialStore` is only an adapter to the narrow Tauri commands. Tests use `InMemoryCredentialStore`.

## Non-secret configuration

The canonical v1 configuration contains:

- `apiVersion`
- `schemaVersion`
- `providerId`
- `enabled`
- `baseUrl`
- `model`
- `credentialReference`
- optional `timeoutMs`

The Rust Host persists this object as `provider-configuration-v1.json` under Tauri's application config directory. Unknown fields are rejected. No secret field is part of the schema or Rust persistence model.

## Validation

The canonical JSON Schemas are authoritative for the contract shape. Runtime validation additionally enforces the OpenAI-compatible URL safety rules:

- HTTP or HTTPS only;
- no embedded username/password;
- no query string;
- no fragment;
- no surrounding URL whitespace;
- non-empty trimmed model;
- finite positive timeout;
- enabled real provider requires an opaque credential reference.

Dangerous or invalid input produces an explicit configuration error rather than silent normalization.

## Active provider resolution

The Composition Root always registers `FakeChatProvider`.

For a saved provider configuration:

- valid + enabled + `openai-compatible` → application selects `openai-compatible`;
- missing configuration → `fake.chat`;
- disabled configuration → `fake.chat`;
- invalid configuration → `fake.chat`.

A missing stored credential does not prevent startup. The configured real provider can remain selected while the existing OpenAI-compatible provider reports a safe credential-unavailable error at chat time.

The model and Action Broker do not have access to provider configuration or credential administration. AI output cannot select a provider, alter its endpoint or write credentials.

## Connection test

Settings can execute a configuration-level test without creating a second chat pipeline. The implementation constructs the existing OpenAI-compatible `ChatProvider` and runs a fixed minimal canonical chat request through the existing `AiRuntime`.

There are no automatic retries.

Only the stable result semantics cross the configuration boundary:

- `connected`
- `authentication_failed`
- `configuration_error`
- `network_error`
- `timeout`
- `provider_error`

No API key, Authorization header, raw provider payload, raw provider response, prompt or response text is included in the result or diagnostics.

## Settings UI

The Settings area contains only provider configuration controls:

- provider type;
- enabled/disabled;
- base URL;
- model;
- timeout;
- API key entry;
- save;
- connection test;
- remove stored credential.

The API key exists in React state only during entry. After save it is cleared. Startup checks only credential existence; it never reloads the stored secret into React state. The UI displays only `Saved credential` as the persisted state.

## Diagnostics and fallback

Diagnostics can show provider identity and health state, but no secret material. The Action Broker is unchanged and is not used for credential administration.

FakeChatProvider remains available without any API key or network. CI/test doubles use deterministic fake credential and HTTP implementations.

## Security limitations

The current OpenAI-compatible provider still runs in the TypeScript runtime, so the resolved credential necessarily exists transiently at the HTTP authorization boundary when a real chat request is made. It is not persisted by the provider or exposed in canonical contracts, diagnostics or errors.

The configurable provider endpoint requires the desktop WebView CSP to permit HTTP/HTTPS network connections. This is restricted to provider configuration/application behavior; it does not grant filesystem, shell, process or browser-computer-use permissions.

## Deferred

This phase intentionally does not implement browser/computer use, memory, autonomy, TTS/STT, vision, personality, provider streaming/tool calling, vendor SDKs or the full chat UI.
