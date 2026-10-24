# Screen capture for Chat

`modules/vision/src/index.ts` is a capture/attachment utility, not an inference service.

The main Chat composer requests one frame from the operating-system screen-share picker after the user presses **Screenshot**. It converts that frame into a bounded `ChatImageAttachment`; capture tracks are stopped immediately afterwards. The attachment is shown in the composer, can be removed before sending, is persisted with the user message, and is sent in the same Chat request as its text.

There is no separate vision-model invocation, no hidden polling loop, and no screenshot analysis panel in Avatar Studio. Image understanding depends on the currently selected chat model supporting multimodal input. The utility never chooses or calls a model.

Tests validate MIME/base64 bounds and the attachment contract without depending on an operating-system capture picker.
