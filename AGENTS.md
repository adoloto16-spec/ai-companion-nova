# AI Companion Nova — agent instructions

## Scope
Treat this repository as a contracts-first desktop companion project. Make the smallest change that satisfies the requested task.

## Architecture
- Preserve the existing separation between Contracts, Core, Modules, Providers, Host, and Composition Root.
- Core must not depend on concrete AI vendors, browser engines, renderers, or OS drivers.
- Keep privileged OS / Tauri operations behind the existing Host and Action Broker boundaries.
- Do not introduce real browser, computer, filesystem automation, autonomy, or other unrelated capabilities unless the task explicitly requires them.
- Prefer existing services, contracts, persistence, and UI surfaces over parallel implementations.

## Change discipline
- Work from a feature/chore branch; do not rewrite or force-push `main`.
- Do not redesign Foundation or replace an existing subsystem when a local fix is sufficient.
- Do not add speculative features, compatibility shims, duplicate abstractions, or unused APIs.
- Preserve public contracts and persisted data compatibility unless the task explicitly requires a migration.
- Keep credentials and other secrets out of source code, ordinary configuration, logs, UI state, URLs, and repository files.
- Treat provider-specific behavior as provider/module code, not as Core policy.

## Validation
Before declaring a task complete, run the narrowest relevant checks and the repository CI checks needed to prove the change is safe.

At minimum, use the existing project commands when applicable:
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm test:security`
- `pnpm test:architecture`
- `cargo check --workspace`
- `cargo check --workspace --all-features`

If a check is not run, say so explicitly. For Windows packaging changes, verify the Windows NSIS workflow/artifact separately.

## Pull requests
Every PR should state:
- exact base and head branch;
- exact head commit SHA when known;
- what changed;
- what did not change;
- tests/CI results;
- manual verification status;
- any remaining risk or follow-up.

Do not merge a PR merely because code changes exist. A human-visible CI GREEN result and an appropriate review are the normal completion gate.