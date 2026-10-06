# Agent Kernel v1

The first Agent Kernel vertical slice keeps cognition and execution separate.

The LLM decides only the next high-level action: `continue`, `wait`, `ask_user`, or `finish`. The Kernel owns lifecycle/state transitions, step and duration limits, cancellation, decision validation, diagnostics, events, and the current internal action boundary.

## Output protocols

Structured JSON is preferred only when the provider/model advertises `structuredOutput=true`; the OpenAI-compatible adapter enables this capability explicitly through provider configuration. The existing provider-neutral `responseFormat` contract carries the canonical `agent-decision` JSON Schema.

Plain tagged text is the compatibility protocol:

```text
<NOVA_ACTION>
type=continue
</NOVA_ACTION>
```

Both modes are normalized into one `AgentDecision`, then the Kernel validates the canonical value again before execution.

Fallback is limited to three cases: structured capability unsupported, provider explicitly rejecting the structured response format as unsupported, or malformed structured output. Authentication, timeout, network, rate-limit, and generic provider failures are not converted into tagged retries.

Raw model output is bounded and not stored. Chain-of-thought is neither requested nor persisted. The run stores only bounded summaries/outcomes.

## Kernel loop

A normal run is:

`ready -> thinking -> acting -> thinking -> ... -> completed`

`wait` and `ask_user` enter `waiting` and return control. `interrupt` aborts the current cognitive operation and enters `interrupted`; only an explicit `resume` can continue. There is no periodic sleep for `continue`.

v1 executes no real filesystem, web, mouse, vision, avatar, or other external tool. `DefaultAgentActionExecutor` is the future tool boundary. A later `tool_call` action can route through the existing ActionBroker/Tool Registry without changing the cognitive loop itself.

The runtime exposes manual `startAgentRun`, `getAgentRun`, `interruptAgentRun`, and `resumeAgentRun`. AgentRun persistence and a permanent autonomous scheduler remain out of scope.
