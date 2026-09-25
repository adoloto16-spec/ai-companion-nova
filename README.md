# AI Companion Nova

Foundation Hardening v0.2 for an extensible desktop AI companion.

Architectural rule: Modules depend on contracts, not on implementations.

The repository separates Contracts, Core, Modules, Providers, Host and a Composition Root. Core does not know concrete AI vendors, browser engines, renderers or OS drivers.

## Windows installation

The Foundation CI produces a Windows x64 NSIS installer as a GitHub Actions artifact.

1. Open a successful GitHub Actions run for the Foundation workflow.
2. Download the artifact named `ai-companion-nova-windows-x64`.
3. Run `AI Companion Nova_x64-setup.exe` on Windows 11.
4. Install AI Companion Nova.
5. Launch the application.

The installer contains the built React application, Foundation runtime and Rust/Tauri desktop host. End users do not need Node.js, pnpm, Rust, Cargo or Visual Studio Build Tools to run the installed application.

Windows packaging uses the system WebView2 runtime; a fixed WebView2 runtime is not bundled into the installer.

## Development

### Install

```bash
pnpm install
```

### Run Foundation desktop app

```bash
pnpm desktop:dev
```

This starts the Tauri desktop shell, its React frontend and the Foundation mock runtime. Tauri runs the frontend build/dev command from `apps/desktop-host/src-tauri/tauri.conf.json`.

### Typecheck

```bash
pnpm typecheck
```

### Build

```bash
pnpm build
pnpm --dir apps/desktop-ui build
```

### Tests

```bash
pnpm test
pnpm test:security
pnpm test:architecture
```

### Rust / Tauri validation

```bash
cargo check --workspace
cargo check --workspace --all-features
```

The Tauri all-features validation expects `apps/desktop-ui/dist` to exist, because the Tauri configuration embeds that frontend output.

## Runtime model

The Foundation composition root is `runtime/bootstrap`. It creates the EventBus, StateStore, Diagnostics, ProviderRegistry, ToolRegistry, permission/risk/confirmation services, Action Broker, ModuleManager and offline mock providers/modules.

During a normal Tauri run, the TypeScript Foundation runtime produces diagnostics, the React frontend sends them through Tauri IPC to the Rust Host, and React reads the live snapshot back from the Host. Browser preview may fall back to the in-process snapshot when Tauri IPC is unavailable.

## Security

Dangerous actions pass through the Action Broker. Identity is resolved from a trusted actor credential outside the action payload. Risk comes from canonical ToolDefinition policy; actual target is resolved before permission checks.

No real AI providers, browser automation, OS automation, messaging integrations, vector database or autonomy features are included in this Foundation stage.

See `docs/security.md`, `docs/contracts.md` and `docs/runtime.md`.

CI Windows artifact name: `ai-companion-nova-windows-x64`.
