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


## 2026-10-23 — Entry 003: renderer, settings, and Tauri overlay integration

### Actions performed
- Added the frontend dependencies `three`, `@pixiv/three-vrm`, and `@types/three`; added Vite multi-page entry configuration for the main UI and `avatar-overlay.html`.
- Added `avatar-library.ts` to import supported single-file models into local IndexedDB, keep profile settings separate from the source asset, and select/delete/rename saved profiles.
- Added `vrm-avatar-canvas.tsx` using the official GLTFLoader + `VRMLoaderPlugin` flow. It adapts to available VRM humanoid bones and expression manager, plays the first GLB animation clip when present, and supplies basic breathing/head movement/blink/talk/wave/point behavior.
- Added Avatar Studio UI, the secondary overlay view/entry, and styling. The main UI has a separate Avatar Studio navigation page. Assistant message presentation emits renderer-neutral intent events to the avatar subsystem.
- Configured a separate initially hidden transparent, undecorated, always-on-top Tauri window. Added only the required narrow window commands to the existing Tauri capability and authorized the two intended window labels.
- Added manual screen sharing and single-frame local Ollama image analysis UI, with validated normalized target regions and the ability to ask the avatar to look/point toward a selected region.

### Decisions and limits
- Avatar state is stored in a dedicated IndexedDB database and never added to Nova's conversational Character store or prompt instructions.
- VRM/GLB rendering is the only implemented renderer in this stage. The Live2D status explicitly says the adapter runtime is not configured; there is no false claim that Cubism models play.
- Screen capture is user-initiated; analysis happens only after pressing Analyze. No periodic capture loop is installed.
- This action records intended integration. CI will determine whether the implementation compiles; runtime behavior on a physical Windows desktop remains separately unverified.


## 2026-10-23 — Entry 004: CI verification and screen-space movement refinement

### Actions performed
- Waited for GitHub Actions run [39956481804](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/39956481804) to complete on HEAD `823648a152c0c969ed61c184da18af816b585a05`.
- Recorded the run's final overall conclusion: `success`. The TypeScript Foundation job (including the root test command), React UI job, Rust/Tauri validation job, and Windows installer job all succeeded. The Windows job built the NSIS installer, installed the staged application, passed its startup smoke test, calculated its SHA-256, and uploaded the artifact.
- Tried to clone the branch into the execution container for local reruns; the container could not resolve `github.com` (DNS failure), so local execution remains unavailable. CI outcomes are from GitHub Actions, not local execution.
- Added normalized monitor matching and work-area placement helpers to the avatar contract module, with tests for unique monitor matches, refusal to guess when capture is a window/ambiguous, and clamped placement.
- Added basic upper-leg/arm gait for a walking intent, capture-surface/dimension metadata, and native overlay window movement toward a selected region when the full-monitor geometry can be matched.
- Added narrow Tauri permissions for native overlay position/size changes and updated the user-facing architecture/limitation documentation.

### Decisions
- Move the avatar window only when the captured image dimensions match exactly one available monitor within a 1.5% tolerance; never infer desktop coordinates from a browser-tab/window crop or ambiguous monitor sizes.
- Use the monitor work area rather than raw screen bounds so the avatar is less likely to be hidden under the taskbar.
- Publish a walking intent during the window-position transition, followed by the pointing intent. The walk is still procedural and does not claim full IK or physical locomotion simulation.
- The first CI run verified the preceding implementation only. The movement refinement, new monitor tests, capability changes, and journal update still require a new CI run.

### Verification status
- Pre-refinement commit `823648a152c0c969ed61c184da18af816b585a05`: GitHub Actions fully green.
- Refinement in this entry: verification pending the next GitHub Actions run.
- Real-world monitor/DPI mapping, transparent compositing, mouse pass-through, and smooth movement across mixed-DPI monitors remain unverified in a live Windows desktop session.


## 2026-10-23 — Entry 005: diagnose and fix monitor placement precision

### Action performed
- Inspected the failed test output from GitHub Actions run [39958446273](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/39958446273), job `typescript-foundation`.
- Identified the exact failing assertion: screen placement calculated `x: 1197.9999999999998` while native logical-pixel placement/test expectation was `x: 1198`. No other failure was reported before the unit-test command stopped.
- Fixed the production placement helper by rounding final logical x/y window positions to whole pixels. Kept the expected test value unchanged.

### Decision
- Native desktop windows are placed on logical-pixel coordinates in this flow; returning fractional residue has no value and makes deterministic placement brittle. Rounding at the boundary is preferable to weakening the test or using an approximate test matcher.

### Verification status
- The prior implementation's TypeScript typecheck/build passed; `pnpm test` failed only at the exact screen-placement equality assertion documented above.
- The precision fix has not yet been checked by CI; rerun validation is required before treating the movement path as verified.


## 2026-10-23 — Entry 006: use the supported Tauri window scale-factor API

### Action performed
- Inspected the React UI typecheck output from run [39958709467](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/39958709467), job `react-ui`.
- The compiler reported `TS2339: Property 'currentMonitor' does not exist on type 'Window'` in `avatar-studio.tsx`. The frontend compile therefore correctly rejected the assumed API.
- Replaced the unsupported method with the Tauri v2 `Window.scaleFactor()` API when converting the overlay's current physical position to logical coordinates.

### Decision
- Keep the geometry conversion based on the overlay window's actual scale factor, not the destination monitor's factor, because source and target monitors can use different DPI scaling.
- Do not bypass TypeScript or cast the window API to an invented shape.

### Verification status
- After Entry 005, the full root `pnpm test` succeeded, including the screen placement geometry tests.
- The same CI run's React UI typecheck exposed this compile-time API mismatch; the fix in this entry requires another full CI run.


## 2026-10-24 — Entry 007: VRM loading path in packaged Tauri

### User-reported symptom
- The VRM avatar does not appear after importing/selecting a model.

### Inspection and decision
- Confirmed that the renderer fetched the stored Blob by creating a `blob:` object URL and then calling `GLTFLoader.load(blobUrl)`.
- The packaged Tauri Content Security Policy allows `blob:` under `img-src`, but not under `connect-src`. Three.js loads a URL through its resource loader/fetch path, so relying on a `blob:` URL can be rejected by the packaged application's CSP.
- Replaced the URL roundtrip with `Blob.arrayBuffer()` + `GLTFLoader.parse()`. The supported model flow already only accepts binary VRM and self-contained GLB, so it should not need external resource URL resolution.
- Added a bounds sanity check that reports an explicit error for a file with no renderable geometry. The overlay now keeps load/renderer errors visible instead of hiding all status messages.

### Verification
- Source change is committed in the same branch as PR #47. A new GitHub Actions run is required to check TypeScript, React UI build, and Windows install/smoke-test.
- Visual rendering of the user's particular VRM remains unverified until a real desktop launch with that file.


## 2026-10-24 — Entry 008: verify VRM loading fix and align screen understanding with Chat

### Verification of the previous commit
- Waited for GitHub Actions run [40047099452](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/40047099452) for HEAD `06e242883eb8b31f6d8080e82eb8412b01f7be9a` to complete.
- All four jobs completed with `success`: TypeScript foundation/tests, React UI typecheck/build, Windows NSIS installer including staged install/startup smoke-test, and Rust/Tauri validation.
- This validates compilation, automated tests, installer packaging, and application startup. It does not visually verify the user's actual VRM file in an interactive desktop session.

## 2026-10-24 — Entry 009: one screenshot, one normal Chat request

### User-reported mismatch
- The previous design put capture and a separate Ollama vision call in Avatar Studio. That was not the intended user path: the Screenshot button should attach an image to the main chat message so the selected chat model receives it with ordinary context, without a second model request.
- The VRM load path in Entry 007 passed the CI run noted above; interactive display of the user's specific model still requires desktop verification.

### Actions and decisions
- Introduced `ChatImageAttachment` as an optional part of `ChatMessage`, with MIME/count/payload bounds. Updated the generated schema catalog and Rust conversation persistence/validation so screenshots survive app restarts.
- Added a common context-assembly restoration helper. The context engine works on textual candidates, but original image payloads are reattached by message ID before provider invocation; the newest user screenshot is not silently dropped if budget filtering omits its message.
- Added same-request image encoding for the existing providers: Ollama message `images`, OpenAI-compatible `image_url` parts, and Gemini `inlineData`. Unit tests assert one ordinary provider request contains both text and image.
- Moved one-shot screen capture and removable image preview into the main Chat composer. Capture stops its tracks after one frame; the capture module has no provider, prompt, or inference dependency.
- Removed the detached screen-analysis path and its region-pointing UI/motion code so the screenshot action cannot invoke a second model.

### Verification status
- The preceding VRM-fix HEAD passed all GitHub Actions jobs.
- The chat attachment integration still requires fresh TypeScript/unit-test, React UI, Rust/Tauri, and Windows installer validation.
- OS screenshot-picker behavior and actual VRM visual rendering require interactive desktop checks; GitHub CI cannot prove those user-specific paths.


## 2026-10-24 — Entry 010: preserve the existing composer busy-state contract

### Action
- Read the failed root unit-test output from run [40048828462](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/40048828462).
- The exact failure was in the existing `chat-stream-ui-regression.test.ts`: it verifies that the main composer explicitly uses `disabled={chatBusy}`, where `chatBusy` combines normal streaming and pending Nova Life work.
- The screenshot change had broadened the textarea binding to `disabled={chatBusy||captureBusy}`, which did not preserve that explicit source-level contract even though the expression also blocked input while streaming. The test correctly caught a regression in the UI contract; the test itself was not changed.
- Restored the textarea's `disabled={chatBusy}` binding and exposed capture-in-progress state through `aria-busy={captureBusy}`. Sending remains blocked during capture by the submit handler and submit button.

### Verification
- The schema-catalog generation, schema diff check, root typecheck, and root build passed before the failing regression assertion.
- Provider image tests (OpenAI-compatible and Ollama), the avatar runtime tests, and the capture attachment test all passed earlier in the same root test run.
- This focused JSX fix requires a new CI run; UI, Windows, Rust, and full root test completion still need to be observed.


## 2026-10-24 — Entry 011: restore primary navigation after an imprecise JSX anchor

### Diagnosis
- The follow-up CI run [40048941993](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/40048941993) passed foundation build, but the root unit tests failed at `desktop-ui-regression.test.ts`: “Primary navigation must expose Model Profile”.
- Inspection showed the route-replacement search had matched `className={view==="avatar"...}` on the **navigation button** instead of the rendered view branch. It therefore removed part of the navigation markup. This was an implementation defect, not an invalid test.

### Corrective action
- Rebased the main UI source on the verified pre-screenshot-integration version of `main.tsx`, then reapplied the screenshot composer changes using a unique, multiline anchor for the rendered Avatar Studio branch.
- Added a pre-commit source check that the primary navigation still contains Chat, Avatar Studio and Model Profile. Kept `disabled={chatBusy}` on the textarea and left capture-in-progress as `aria-busy`; form submission remains disabled while capture is active.
- No tests were edited.

### Verification status
- The source fix is awaiting a new full CI run.
- The previous root test run confirmed the schema/type/build steps, capture/provider unit tests, and existing streaming UI regression passed before the desktop navigation regression test stopped the suite.


## 2026-10-24 — Entry 012: preserve the existing draft-clear semantics

### Diagnosis
- The latest root test run [40049091664](https://github.com/adoloto16-spec/ai-companion-nova/actions/runs/40049091664) passed the screenshot/provider tests, navigation test, and streaming UI contract, then failed at `desktop-ui-regression.test.ts`: “ordinary Chat clears a draft only after a successful send”.
- The original UI regression test also explicitly requires Nova Life to clear only on `awaiting-life`, not on `life-failed`. The screenshot integration had grouped these conditions together, inadvertently changing existing retry behavior.

### Corrective action
- Restored the explicit `if(result.status==="sent") onClearSubmittedDraft(submittedDraft)` and `if(result.status==="awaiting-life") onClearSubmittedDraft(submittedDraft)` guards.
- Kept screenshot preview clearing in separate blocks with the same success conditions. On `life-failed`, the draft and pending screenshot remain available, matching the existing Chat retry semantics.
- No tests were modified.

### Verification status
- The latest root run passed TypeScript checks/build, screenshot capture helper tests, provider image mapping tests, the chat streaming UI regression, and the primary navigation checks before the draft-clear assertion failed.
- This correction requires another complete GitHub Actions run, including React UI, Rust/Tauri, and Windows installer.


## 2026-10-24 — Entry 013: correct the Vision interaction and React-owned canvas lifecycle

### User-reported failures
- Vision required a manual one-frame Screenshot action and a second deliberate send of the queued attachment. This did not meet the intended toggle-controlled, automatic-per-request behavior.
- A screenshot-bearing Chat request surfaced only “The message could not be sent.”, making image-input/model failures difficult to distinguish from ordinary text submissions.
- Avatar Studio intermittently failed with `removeChild`: the Three.js renderer imperatively replaced and removed children on the same DOM element where React rendered the status/error overlay.

### Corrective implementation
- Replaced the one-shot composer workflow with a **Vision: Off/On** control. Enabling Vision asks the user to choose a display surface once; the stream remains active until toggled off, the Chat view unmounts, or screen sharing ends by the operating system.
- Each outgoing Chat/Nova Life message captures a fresh bounded JPEG immediately before submission and adds it to the same user message. No screenshot preview/attachment queue or second model call is required. Turning Vision off stops the stream, and capture failures leave the user's draft unsent.
- Made automatic capture robust to repeated send attempts, view unmounts during the permission prompt, the OS ending the stream, and screenshots that need more compression attempts to satisfy the payload limit.
- Kept the renderer canvas in a dedicated inner host, separate from React-owned status overlays. React no longer has to reconcile nodes that Three.js has removed.
- Made image-bearing provider errors actionable: Chat now states that the active model/provider may not support screenshots and points to Diagnostics for provider-specific details. Existing draft-clear conditions are unchanged.
- Added regression assertions for automatic Vision and the isolated renderer host. No existing tests were weakened or deleted.

### Verification status
- GitHub Actions will run against the new commit. Its final outcome must be observed before calling this validated.
- CI cannot prove the OS screen-picker interaction or visually confirm the user's particular VRM in a live Windows WebView; those remain explicit interactive checks.
