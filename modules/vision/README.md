# Vision and screen context

`modules/vision/src/index.ts` owns the user-authorized screen-capture session. It never calls a model itself.

**Vision: On/Off** in the main Chat composer controls live screen sharing. Once enabled, every outgoing Chat/Nova Life message captures a fresh frame immediately before submission, encodes it as a real `image/png` attachment, and sends it in the same ordinary request as message text. PNGs are progressively downscaled only when necessary to fit the attachment limit. Turning Vision off, leaving Chat, or stopping sharing in the operating system stops the capture stream.

**Agent Vision: On/Off** is separate. It affects only Nova Life's cognitive context: Off strips image attachments from the agent's context; On reuses only the most recent image-bearing user message already stored in the conversation. This switch does not call the screen-capture API or create a new image.

The normal selected-provider request maps the PNG through Ollama's `/api/chat` `messages[].images`, OpenAI-compatible `image_url`, or Gemini `inlineData` format. A second vision-model call is not used. Ollama advertises vision support for its image-bearing chat transport. If the provider rejects the image request, Chat shows the provider's original error message when available instead of replacing it with a generic claim about model capabilities.

Screenshot base64 is omitted from retained diagnostic traces. Automated tests cover the attachment contract and the serialized Ollama request; OS screen-picker behavior still requires interactive Windows verification.
