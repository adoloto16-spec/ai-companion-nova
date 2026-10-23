# Nova Avatar & Screen Understanding — Development Log

Repository: `adoloto16-spec/ai-companion-nova`
Workstream: PR #47, branch `feat/prompt-presets-system`
Baseline HEAD inspected: `7a6f92b2c2c6a24bcc4571bc5892cb483ecacea6`
Log policy: append an entry for each implementation or verification action; record observed results, decisions, and unverified platform-only behavior. Never rewrite prior entries to hide failures.

## 2026-10-23 — Entry 001: baseline inspection and initial decisions

### Actions performed
- Read PR #47 metadata and confirmed it is open; its base is `fix/nova-tts-queue-reasoning-settings`, and its head branch is `feat/prompt-presets-system`.
- Read the head commit's recursive Git tree, repository manifests, the existing character and vision module placeholders, contracts, desktop UI entry point, and CI workflow.
- Read the completed workflow/check metadata for baseline HEAD.

### Observations
- Baseline HEAD: `7a6f92b2c2c6a24bcc4571bc5892cb483ecacea6`.
- The latest completed CI run found for that HEAD is run [39248836911](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/39248836911); all four reported jobs completed successfully.
- The repository already has React + TypeScript, Rust/Tauri, versioned contracts, a reserved `modules/character` placeholder for VRM/Live2D, and a reserved `modules/vision` placeholder.
- The existing `Character` contract represents Nova's conversational character/persona, so avatar-model profiles must use a different name and storage key.
- The existing workspace configuration does not include a renderer/VRM package. CI currently uses `pnpm install --no-frozen-lockfile`; schema catalog generation is checked for a clean diff.
- Live2D's official Cubism Core is distributed through its SDK package under proprietary licensing terms; do not vendor SDK/Core binaries or invent a renderer implementation.

### Decisions
- Add the work on PR #47's head branch, not `main`, and do not create or retarget a PR.
- Keep avatar state and rendering optional and separate from chat/persona state. Define renderer-neutral contracts before concrete renderer integration.
- Prioritize a real VRM path via Three.js and `@pixiv/three-vrm`; keep Live2D behind an adapter boundary until the user supplies/obtains the SDK files needed for a legitimate runtime integration.
- Screen understanding stays a separate service with an injected capture source and vision analyzer; it must not import or depend on the avatar runtime.
- Use a hybrid behavior controller: deterministic low-latency idle/motion orchestration first, with an optional context director later. A model/LLM is not required for basic movement.
- The desired desktop overlay is a separate Tauri webview window; its support and click-through details must be validated on Windows, not assumed from a TypeScript build.

### Verification status
- Baseline PR metadata and workflow status: checked.
- Local execution, interactive rendering, and Windows desktop behavior are not available through the GitHub repository connector and remain unverified until CI/desktop smoke testing.


## 2026-10-23 — Entry 002: renderer-neutral contracts and unit tests

### Actions performed
- Added `modules/character/src/index.ts`: renderer-independent avatar profile/settings/intent types, validated file extension handling, normalized setting bounds, deterministic dialogue-to-expression mapping, screen-region targeting, and a BroadcastChannel event bridge for the main/overlay webviews.
- Added `modules/vision/src/index.ts`: injected vision-inference contract, bounded screenshot payload validation, JSON response parsing, normalized region validation, and stable screen observation output.
- Added unit tests for settings validation, model format restrictions, dialogue intents, point target bounds, invalid model response geometry, and reuse of the configured vision model.
- Added both unit test files to the root test command.

### Verification after this action
- Source blobs were created on GitHub but are not yet attached to the branch tree; this entry records the implementation stage, not a passing test claim.
- Unit tests and TypeScript checks will be run through the branch's CI after the integrated code commit.
- Decision: keep the module APIs independent of the provider and renderer implementations; no changes were made to Nova's conversational `Character` persistence or memory.
