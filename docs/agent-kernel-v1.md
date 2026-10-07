# Agent Kernel v1 — internal cognition

The Agent Kernel is an internal cognition mechanism of Nova. It is not a user-facing mode.

Nova's persistent lifecycle is owned by `NovaLifeRuntime`:

```text
Nova Life
  -> wake
  -> Context Engine
  -> bounded AgentRun
  -> Agent decision/action
  -> assistant message / wait / ask_user / tool result
  -> waiting or scheduled wake
  -> next wake
```

## Agent Kernel boundary

The bounded cognition protocol currently accepts exactly these canonical decisions:

- `respond` with `content`
- `tool_call` with `toolName`, `arguments`, and `callId`
- `wait` with `waitMs`
- `ask_user` with `question`

Structured JSON is preferred only when the provider/model advertises `structuredOutput=true`.

When structured output is unavailable, the response format is plain text. A non-empty assistant response that is not a special `<NOVA_ACTION>` block is normalized directly to:

```json
{"action":"respond","content":"<full model response>"}
```

Special tagged actions remain supported for compatibility:

```text
<NOVA_ACTION>
type=tool_call
toolName=browser.navigate
arguments={"url":"https://example.com"}
callId=call-1
</NOVA_ACTION>
```

```text
<NOVA_ACTION>
type=wait
wait_ms=30000
</NOVA_ACTION>
```

```text
<NOVA_ACTION>
type=ask_user
question=What information do you need?
</NOVA_ACTION>
```

A tagged `respond` block is also accepted, but normal user-facing text does not need the wrapper.

A protocol error means the special output is actually malformed or the response is otherwise empty/invalid. Ordinary user-facing text is not a protocol error.

Provider failures remain provider failures. Authentication, timeout, network, rate-limit, server, and configuration categories are not rewritten as model-output protocol errors.

## Cognition requests and diagnostics

Every model request records diagnostics with:

- `requestId`
- `runId`
- `step`
- `provider`
- `model`
- `outputMode`
- `status`
- `durationMs`

Diagnostics never persist chain-of-thought or secrets.

The AgentRun tracks actual model calls and attempted versus completed cognition steps. A model response that fails protocol parsing therefore appears as one attempted step, zero completed steps, one model call, and a `protocol_error` diagnostic decision. It does not manufacture a `respond` decision.

## Life interaction

Each Life wake creates a short-lived AgentRun. AgentRun completion or failure does not stop Nova Life.

`respond` persists a normal assistant message and returns Life to waiting or a controlled scheduled wake.

`wait` schedules the next wake without stopping Life.

`ask_user` becomes a normal assistant question in Conversation. The next ordinary user message raises the canonical `UserMessageReceived` event and wakes another bounded cognition burst.

`tool_call` is executed through the existing ActionBroker/tool boundary. Tool results become runtime context for the next cognition step.

For `wakeReason=user_message`, the Context Engine supplies the current conversation so the next cognition cycle sees the latest user message as `role=user`.

For `wakeReason=startup`, a useful proactive response may be plain assistant text. It is persisted normally and Life remains ON.

## User-facing contract

There is no Agent Mode API or Agent Mode UI.

The user interacts with the global `Nova: OFF` / `Nova: ON` control and the normal Chat composer.

When Nova is OFF, the existing Chat controller remains the response path.

When Nova is ON, the Chat composer persists the user message into Conversation; `UserMessageReceived` wakes Life and the Life Runtime owns the cognitive response path.

OFF cancels future scheduler timers, interrupts the active bounded cognition burst, unsubscribes runtime event handlers, and returns Life to `off`.

## Diagnostics and failure isolation

Life trace uses the existing EventBus and DiagnosticsStore. Lifecycle events include:

- `NovaLifeStarted`
- `NovaLifeStopped`
- `NovaLifeWakeStarted`
- `NovaLifeWakeCompleted`
- `NovaLifeSleeping`
- `NovaLifeError`

Cognition/provider failures are isolated from the Life lifecycle. Provider failures keep their provider category and use the existing controlled retry policy where applicable. Protocol failures are not retried as provider failures.

The internal `DefaultAgentActionExecutor` remains deliberately limited. No real filesystem, browser automation, mouse, screen vision, avatar, or other external tools are introduced by this change.
