import assert from "node:assert/strict";
import { createChatImageAttachment } from "../../modules/vision/src/index";
import { MAX_CHAT_IMAGE_BASE64_CHARS } from "../../contracts/src/index";

const image = createChatImageAttachment("data:image/jpeg;base64,aGVsbG8=", "Desktop screenshot");
assert.deepEqual(image, { mimeType: "image/jpeg", dataBase64: "aGVsbG8=", alt: "Desktop screenshot" });
assert.throws(() => createChatImageAttachment("data:image/svg+xml;base64,PHN2Zz4="), /supported base64 image/);
assert.throws(() => createChatImageAttachment("data:image/jpeg;base64,not base64!"), /supported base64 image/);
assert.throws(
  () => createChatImageAttachment("data:image/jpeg;base64," + "A".repeat(MAX_CHAT_IMAGE_BASE64_CHARS + 4)),
  /too large/
);
assert.equal(createChatImageAttachment("data:image/png;base64,aGVsbG8=", " ").alt, undefined);
console.log("screen-capture.test.ts: passed");
