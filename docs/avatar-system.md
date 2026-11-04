# Nova avatar system

## Avatar rendering

The avatar is an optional visual subsystem. The existing `Character` contract describes Nova's conversational persona; avatar profiles and model blobs remain separate in the local IndexedDB database.

- `modules/character/src/index.ts` defines avatar profiles, bounded display settings, and renderer-neutral dialogue/user-action intents.
- `apps/desktop-ui/src/avatar-library.ts` stores imported `.vrm` and self-contained `.glb` files locally.
- `apps/desktop-ui/src/vrm-avatar-canvas.tsx` renders VRM through Three.js + `@pixiv/three-vrm`. It parses stored binary bytes directly, avoiding a `blob:` URL fetch under the packaged Tauri CSP. It adapts to available humanoid bones, expression shapes, and existing GLB animation clips.
- `apps/desktop-ui/src/avatar-studio.tsx` owns model import, profile selection, settings, overlay visibility, and wave/look actions. Nova Life can call the registered, permission-gated `avatar.set_intent` tool to choose idle/talk/wave/look actions and a bounded expression/intensity; its event updates the in-window studio and any separate overlay. The desktop overlay is a separate transparent Tauri window.
- `modules/vision/src/index.ts` only captures and bounds a one-shot screenshot attachment. It never calls any model.

## Screenshot flow

Use **Vision: Off/On** in the main Chat composer. Turning Vision on opens the operating-system picker so the user can authorize a screen/window. Once enabled, the capture session remains active until Vision is switched off, the Chat view is closed, or screen sharing is stopped by the operating system.

Every outgoing Chat or Nova Life message automatically captures a fresh frame immediately before submission. The screenshot is stored on the same user `ChatMessage` as the text, survives conversation persistence, passes through context assembly, and is encoded into the same request to the selected chat provider:

- Ollama receives the image in its normal `/api/chat` user message `images` array.
- OpenAI-compatible endpoints receive a standard `image_url` content part.
- Gemini receives an `inlineData` part in the same user turn.

Nova does not make a second vision-model request and does not select a model on the user's behalf. Image understanding depends on the active model/provider supporting image input. If a provider rejects a screenshot request, Chat gives an image-specific error and directs the user to Diagnostics. Screenshot base64 is omitted from retained diagnostic traces.

## Compatibility and limitations

VRM is the primary renderer, but each model must include appropriate geometry and humanoid bones for the corresponding procedural movement, and expression shapes for facial expressions. A self-contained `.glb` file may be imported; external-resource `.gltf` folders are not imported. Live2D remains an unconfigured adapter boundary because the licensed Cubism SDK/Core must be provided separately.

Screenshot capture requires a WebView that supports `getDisplayMedia`; real Windows desktop capture-picker behavior still needs a live smoke test. The actual screenshot analysis is performed by the selected chat model as part of the regular user request, not by a detached screen analysis view.

The animation layer remains procedural and modest; it is not full-body inverse kinematics, learned motion generation, or physical simulation. Transparent overlay compositing and mouse pass-through should still be validated on the user's desktop.


## Orientation and material diagnostics

The viewer selects its front-camera side from VRM metadata: VRM 0.x faces -Z, while VRM 1.0 faces +Z. For loaded meshes, the renderer also reasserts sRGB color space and marks base-color maps for GPU upload. If the model contains meshes and materials but no base-color texture maps, Avatar Studio displays that diagnosis instead of silently reporting a complete load. This distinguishes a file exported without embedded textures from a rendering failure; confirm the actual map counts with the user's asset if it still appears white.


## Overlay controls and gaze tracking

- The frameless overlay uses Tauri's native window-drag region. Its capability must explicitly include `core:window:allow-start-dragging`; `core:window:default` does not grant this command.
- Model scale and camera framing are independent. The camera fit is derived from the unscaled model bounds and vertical field of view; the camera-distance setting is a zoom-out multiplier with a safe minimum.
- `Track cursor` is an opt-in profile setting. The overlay maps pointer-move events in the WebView into a bounded gaze target; the VRM head controller applies limited yaw/pitch. Because Tauri pass-through windows do not receive pointer events, enabling cursor tracking temporarily disables pass-through so gaze input can be observed.
- GLB PBR base-color textures are exposed as material maps, while VRM MToon base-color textures are stored in `uniforms.map.value`. Material preparation handles both paths and reasserts sRGB before upload. Texture diagnostics use Three.js' `isTexture` marker, count decoded image dimensions, and report external image URI references. The current importer reads one self-contained `.vrm`/`.glb` binary; external `.gltf` sidecar images are not bundled or resolved yet.


## Avatar Director and procedural rig goals

The Avatar Director is a separate, optional chat-agent request. It runs once after a completed assistant reply, uses the currently active chat provider preset, and does not delay the user-facing answer. Its settings toggle is stored with the active avatar profile. Provider or parsing failures fall back to a neutral, bounded intent; an older analysis result is discarded if a newer turn has already started.

The agent returns only a typed semantic intent: gesture, expression, gaze, intensity and duration. Its prompt is a dedicated `avatar-director` record in Prompt Presets. The output is validated in code and never contains bone names, quaternions or arbitrary transforms.

The procedural Bone Controller turns semantic gestures into smoothed hand-space goals and torso/weight-shift targets. For VRM humanoids with both normalized hand end-effectors, the renderer solves upper-arm and forearm chains with analytic two-bone IK. Goals are clamped to reachable arm length; missing hand bones use the legacy conservative pose fallback. No canned clips are required for these generated gestures. Existing embedded GLB clips remain a separate playback path. Full-body IK, collision-aware foot planting, spring simulation and per-model joint-limit calibration are not implemented yet.


## Image attachments and text-only context

ChatRequest accepts bounded image attachments on user messages. The Context Engine remains intentionally text-only: screenshot bytes are removed before context tokenization and retrieval, then restored by message id before the selected chat provider receives the request. Normal Chat and Nova Life use the same separation. If optional screen capture fails while the user typed a prompt, the prompt is still sent without the image and the UI reports the fallback; a Vision-only send without a prompt remains blocked.
