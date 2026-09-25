# Architecture

## Dependency direction

```
Contracts
   ↑
Core   Modules   Providers
   \      |        /
    \     |       /
     Composition Root
            |
      Tauri / Host / UI
```

Core never imports OpenAI, Anthropic, ElevenLabs, Ollama, LM Studio, Playwright, Three.js/VRM, LanceDB, or messaging SDKs.

## Lifecycle

```
installed -> loading -> ready -> running
                            \-> degraded
                            \-> error
installed <-> disabled
```

Optional module failure is isolated from Core.

## Security

```
Action Request
 -> schema validation
 -> permission
 -> foreground
 -> scope
 -> risk / confirmation
 -> driver
 -> postcondition
 -> audit
```

`ModuleContext` never exposes unrestricted shell, filesystem, process, mouse, or keyboard operations.

## IPC

UI to Rust uses Tauri IPC. Module/process boundaries have a JSON-RPC 2.0 transport abstraction. Foundation uses an in-memory transport for tests.

## Composition Root

Concrete bindings happen outside Core. The first Foundation uses fake providers and modules only.
