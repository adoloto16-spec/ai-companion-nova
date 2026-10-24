# Nova avatar system

## Avatar rendering

The avatar is an optional visual subsystem. The existing `Character` contract describes Nova's conversational persona; avatar profiles and model blobs remain separate in the local IndexedDB database.

- `modules/character/src/index.ts` defines avatar profiles, bounded display settings, and renderer-neutral dialogue/user-action intents.
- `apps/desktop-ui/src/avatar-library.ts` stores imported `.vrm` and self-contained `.glb` files locally.
- `apps/desktop-ui/src/vrm-avatar-canvas.tsx` renders VRM through Three.js + `@pixiv/three-vrm`. It parses stored binary bytes directly, avoiding a `blob:` URL fetch under the packaged Tauri CSP. It adapts to available humanoid bones, expression shapes, and existing GLB animation clips.
- `apps/desktop-ui/src/avatar-studio.tsx` owns model import, profile selection, settings, overlay visibility, and basic wave/look actions. The desktop overlay is a separate transparent Tauri window.
- `modules/vision/src/index.ts` only captures and bounds a one-shot screenshot attachment. It never calls any model.

## Screenshot flow

Press **Screenshot** in the main Chat composer and select the desired screen/window/tab in the operating-system picker. Nova captures one frame, stops the capture stream, and adds the image to the current draft. The preview can be removed before sending. When sent, the screenshot is stored on the same user `ChatMessage` as the text, survives conversation persistence, passes through context assembly, and is encoded into the same request to the currently selected chat provider:

- Ollama receives the image in its normal `/api/chat` user message `images` array.
- OpenAI-compatible endpoints receive a standard `image_url` content part.
- Gemini receives an `inlineData` part in the same user turn.

Nova does not make a second "vision model" request and does not choose another model for the screenshot. Analysis depends on the selected model/provider actually supporting image input; a text-only model may reject the request. Image payloads are omitted from retained diagnostic traces to avoid duplicating screenshot data.

## Compatibility and limitations

VRM is the primary renderer, but each model must include appropriate geometry and humanoid bones for the corresponding procedural movement, and expression shapes for facial expressions. A self-contained `.glb` file may be imported; external-resource `.gltf` folders are not imported. Live2D remains an unconfigured adapter boundary because the licensed Cubism SDK/Core must be provided separately.

Screenshot capture requires a WebView that supports `getDisplayMedia`; real Windows desktop capture-picker behavior still needs a live smoke test. The actual screenshot analysis is performed by the selected chat model as part of the regular user request, not by a detached screen analysis view.

The animation layer remains procedural and modest; it is not full-body inverse kinematics, learned motion generation, or physical simulation. Transparent overlay compositing and mouse pass-through should still be validated on the user's desktop.
