# Agent Kernel v1 — internal cognition

The Agent Kernel is an internal thinking mechanism of Nova. It is not a user-facing mode.

Nova's persistent lifecycle is owned by `NovaLifeRuntime`:

```text
Nova Life
  -> wake
  -> Context Engine
  -> bounded AgentRun
  -> Agent decision/action
  -> message / wait / ask_user
  -> waiting or scheduled wake
  -> next wake
```

## Agent Kernel boundary

The LLM chooses only one bounded cognition action: `continue`, `wait`, `ask_user`, or `finish`. The Kernel owns state transitions, step/duration/failure limits, cancellation, decision validation, diagnostics, events, and the internal action boundary.

Each Life wake creates a short-lived AgentRun. AgentRun completion never means that Nova Life stopped.

The Life Runtime supplies a fresh context before every cognition step through the existing provider-neutral `ContextEngine`. That context includes the current Conversation plus existing Core Book, Memory/Retrieval candidates and an ephemeral structured Life-state/wake-reason message. No second context collector is introduced.

## Output protocols

Structured JSON is preferred only when the provider/model advertises `structuredOutput=true`. The provider-neutral `responseFormat` contract carries the canonical `agent-decision` JSON Schema.

Plain tagged text is the compatibility protocol:

```text
<NOVA_ACTION>
type=continue
</NOVA_ACTION>
```

Both modes normalize into one `AgentDecision`, then the Kernel validates the canonical value again before execution.

Fallback is limited to structured capability unsupported, explicit unsupported structured response rejection, or malformed structured output. Authentication, timeout, network, rate-limit, and generic provider failures are not converted into tagged retries.

Harmless blank lines inside `<NOVA_ACTION>` do not invalidate the tagged protocol. Raw model output and chain-of-thought are not persisted; runs keep only bounded structured summaries/outcomes.

## Life interaction

`continue` remains an internal step inside the current bounded AgentRun.

`wait` means that Nova Life should sleep and schedule a bounded future wake. It does not stop Nova.

`ask_user` becomes a normal assistant message in Conversation. The next ordinary user message raises the canonical `UserMessageReceived` event and wakes Life for another bounded cognition burst.

`finish` may produce a normal proactive assistant message. Life remains running and returns to waiting or a scheduled wake.

Provider/cognition failures are isolated from the Life lifecycle. The Runtime records diagnostics and performs a controlled retry rather than entering a tight loop.

The internal `DefaultAgentActionExecutor` remains deliberately limited. No real filesystem, browser automation, mouse, screen vision, avatar, or other external tools are introduced by this change.

## User-facing contract

There is no Agent Mode API and no Agent Mode UI.

The user interacts with one global `Nova: OFF` / `Nova: ON` control and the normal Chat composer.

When Nova is OFF, the existing Chat controller remains the response path.

When Nova is ON, the Chat composer persists the user message into Conversation; the Life Runtime receives `UserMessageReceived` and owns the cognitive response path. The UI does not start or poll AgentRuns.

OFF cancels future scheduler timers, interrupts the active bounded cognition burst, unsubscribes runtime event handlers, and returns the Life state to `off`.

## Diagnostics

Life trace uses the existing EventBus and DiagnosticsStore. Structured lifecycle events include:

- `NovaLifeStarted`
- `NovaLifeStopped`
- `NovaLifeWakeStarted`
- `NovaLifeWakeCompleted`
- `NovaLifeSleeping`
- `NovaLifeError`

Diagnostics expose Life state, wake count/reason, current/last AgentRun metadata, last action/outcome, next wake, and context assembly metadata without exposing chain-of-thought.
