import type { ChatImageAttachment, ChatMessage } from "../../contracts/src/index";
import { MAX_CHAT_IMAGE_ATTACHMENTS, MAX_CHAT_IMAGE_BASE64_CHARS } from "../../contracts/src/index";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function cloneChatImageAttachments(
  images?: readonly ChatImageAttachment[]
): readonly ChatImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined;
  if (images.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
    throw new Error("A chat message can contain at most " + MAX_CHAT_IMAGE_ATTACHMENTS + " screenshots.");
  }
  return images.map(image => {
    if (!IMAGE_MIME_TYPES.has(image.mimeType)) throw new Error("Unsupported chat image MIME type.");
    if (typeof image.dataBase64 !== "string" || image.dataBase64.length < 4 ||
        image.dataBase64.length > MAX_CHAT_IMAGE_BASE64_CHARS ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) {
      throw new Error("Chat image data is not valid bounded base64.");
    }
    if (image.alt !== undefined && (typeof image.alt !== "string" || image.alt.length > 256)) {
      throw new Error("Chat image alternative text must not exceed 256 characters.");
    }
    return { mimeType: image.mimeType, dataBase64: image.dataBase64, ...(image.alt ? { alt: image.alt } : {}) };
  });
}

/**
 * Re-attaches the user-owned binary payloads after context assembly. The context
 * engine works on textual candidates; it must never turn a screenshot into a second
 * inference call or silently strip the image from the chat request.
 */
export function restoreChatImageAttachments(
  assembledMessages: readonly ChatMessage[],
  sourceMessages: readonly ChatMessage[]
): ChatMessage[] {
  const attachmentsByMessageId = new Map<string, readonly ChatImageAttachment[]>();
  for (const message of sourceMessages) {
    if (message.id && message.images?.length) {
      attachmentsByMessageId.set(message.id, cloneChatImageAttachments(message.images)!);
    }
  }
  const restored = assembledMessages.map(message => {
    const images = (message.id ? attachmentsByMessageId.get(message.id) : undefined) ?? message.images;
    return { ...message, ...(images?.length ? { images: cloneChatImageAttachments(images) } : {}) };
  });
  const latestUser = [...sourceMessages].reverse().find(message => message.role === "user");
  if (latestUser?.id && latestUser.images?.length && !restored.some(message => message.id === latestUser.id)) {
    restored.push({
      ...latestUser,
      ...(latestUser.metadata ? { metadata: { ...latestUser.metadata } } : {}),
      images: cloneChatImageAttachments(latestUser.images)
    });
  }
  return restored;
}
