# Screen capture for Chat

`modules/vision/src/index.ts` manages the explicit Vision capture session; it does not run inference or select a model.

Press **Vision: Off** in the main Chat composer to request the operating-system screen-share picker and choose the screen/window Nova may see. While **Vision: On**, the authorized media stream remains active. Immediately before each outgoing Chat or Nova Life message, the composer captures one fresh, compressed frame and attaches it to that same user message. No separate Screenshot action, upload preview, or second vision-model call is required. Turning Vision off or unmounting Chat stops the media tracks; ending screen sharing through the OS also turns Vision off.

The same request is sent through the selected provider (Ollama `images`, OpenAI-compatible `image_url`, or Gemini `inlineData`). Image understanding requires the selected model to support image input. When the provider rejects an image request, Chat explains that the model may not support images and points to Diagnostics for the provider-specific failure details. The utility never chooses or calls a model, and screenshot base64 data is redacted from retained diagnostic traces.

Tests validate MIME/base64 limits and the image-attachment contract without depending on an operating-system capture picker. Actual desktop permissions and capture-picker behavior still require an interactive Windows smoke test.
