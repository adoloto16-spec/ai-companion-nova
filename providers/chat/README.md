# Chat Providers

The ChatProvider contract is defined in Contracts so Core can remain implementation-neutral. Concrete adapters under providers/chat or provider-specific subdirectories implement that contract.

Current implementation:

- providers/mock: deterministic offline provider for Foundation/runtime tests.

Future adapters may target OpenAI, Anthropic, local model servers or custom HTTP APIs without changing Core or the canonical chat contracts.
