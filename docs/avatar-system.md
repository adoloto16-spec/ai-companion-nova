# Nova avatar system

## Boundaries

The avatar is an optional visual subsystem. The existing `Character` contract describes Nova's conversational persona; it is not a rendered avatar profile.

- `modules/character/src/index.ts` defines renderer-neutral avatar profiles, settings, intents, lightweight deterministic behavior selection, validation, and the cross-window event boundary.
- `apps/desktop-ui/src/avatar-library.ts` stores imported model blobs and editable profiles in a separate local IndexedDB database.
- `apps/desktop-ui/src/vrm-avatar-canvas.tsx` renders VRM via Three.js and `@pixiv/three-vrm`. Self-contained GLB is also allowed; the first authored GLB animation is played when one exists.
- `apps/desktop-ui/src/avatar-studio.tsx` owns model import, profile selection, settings, overlay visibility, and manual screen analysis.
- `apps/desktop-ui/src/avatar-overlay.tsx` runs in a dedicated transparent Tauri window. Its intent channel is independent of the chat and provider interfaces.
- `modules/vision/src/index.ts` validates/normalizes screen observations. `ScreenUnderstandingPanel` obtains user-granted display capture and sends a single chosen frame to the configured loopback Ollama `/api/chat` route via the existing Tauri transport.

## Current capabilities

- Import .vrm and self-contained .glb files (maximum 300 MiB each), retain original model blobs locally, create named profiles, persist model selection and motion settings across app restarts.
- Configure model scale, camera distance, idle movement, breathing, blinking, gaze activity, motion intensity, autonomy preset, and pointer pass-through for the overlay.
- Basic procedural idle/talking facial expressions, head movement, wave/point gestures where the VRM model exposes the necessary humanoid bones, and playing an available first GLB animation clip.
- Show/hide the separate always-on-top desktop overlay.
- Manually share a screen, analyze one captured frame with the existing local Ollama model, inspect normalized region estimates, and request an approximate point/gaze gesture for a selected region.

## Compatibility and deliberate limitations

VRM is the priority renderer, but the source model must contain appropriate humanoid bones and expression shapes for every advanced behavior. GLB import is a single-file flow; external .gltf dependencies are not bundled automatically. Generic GLB files without animation or humanoid bones receive fewer procedural actions.

Live2D remains an explicit adapter boundary, not a working renderer. A licensed Cubism SDK/Core installation is required before it can be implemented and tested. No proprietary SDK binaries are bundled here.

Pointing currently maps a selected region in the captured image to an approximate gaze direction and arm gesture. It does **not** move the model to the edge of a particular YouTube/browser window. The generic display-capture stream does not provide reliable cross-platform desktop origin/window geometry; physical screen-space navigation needs a separate, platform-aware window geometry service and collision/positioning controller.

The current motion layer is a small procedural behavior controller, not full-body IK, physical balance simulation, cloth/hair simulation or learned motion generation. The controller and profile schema are designed so those layers can be added without a dependency from core chat to the renderer.

## Screen capture privacy

Capture starts only after the user selects **Share screen…** in the platform's picker. Nova does not start continuous capture or save screen frames in the avatar library. Analysis occurs only on **Analyze current frame**. Press **Stop sharing** to end the capture tracks. Coordinates and confidence are estimates produced by the selected model; they are not pixel-accurate guarantees.

## Verification status

Automated checks can confirm TypeScript contracts, UI builds, and the Tauri window/capability configuration. A real Windows desktop smoke test is still required to verify transparent compositing, pointer pass-through, OS capture-picker behavior, WebView model loading, GPU compatibility, and the user's specific VRM assets.
