# Architecture

Layers:
Contracts / JSON Schema
  ^
Core / Modules / Providers
  ^
Composition Root
  ^
Host / UI

Core owns lifecycle, events, state, provider registry and action policy. It depends on Contracts only.

Security pipeline:
ActionInvocation
 -> request schema validation
 -> canonical ToolDefinition
 -> required capabilities
 -> tool argument validation
 -> actual target resolution
 -> permission
 -> foreground
 -> canonical risk / confirmation
 -> driver
 -> postcondition
 -> audit

The request cannot supply its own actor identity, risk, resource or scope policy.

runtime/bootstrap is the concrete composition root used by the Foundation desktop runtime.

Tauri is the privileged Host boundary. The UI receives real runtime diagnostics from the Foundation composition root and host-only diagnostics over Tauri IPC.

Event subscribers and state observers are isolated. Optional module initialize/start/health failures do not terminate Core. Shutdown continues across modules even when a module stop fails.

Contracts carry explicit API/schema versions. JSON Schema files are canonical and the TypeScript schema catalog is generated from them.
