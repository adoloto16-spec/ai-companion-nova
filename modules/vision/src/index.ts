import {
  MAX_CHAT_IMAGE_BASE64_CHARS,
  type ChatImageAttachment,
  type ChatImageMimeType
} from "../../../contracts/src/index";

const IMAGE_MIME_TYPES = new Set<ChatImageMimeType>(["image/jpeg", "image/png", "image/webp"]);

export function createChatImageAttachment(
  dataUrl: string,
  alt = "Screenshot captured by the user"
): ChatImageAttachment {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Screenshot did not produce a supported base64 image.");
  const mimeType = match[1] as ChatImageMimeType;
  const dataBase64 = match[2]!;
  if (!IMAGE_MIME_TYPES.has(mimeType) || dataBase64.length < 4 || dataBase64.length % 4 !== 0) {
    throw new Error("Screenshot data is invalid.");
  }
  if (dataBase64.length > MAX_CHAT_IMAGE_BASE64_CHARS) {
    throw new Error("Screenshot is too large to attach to a chat message.");
  }
  const safeAlt = alt.trim().slice(0, 256);
  return { mimeType, dataBase64, ...(safeAlt ? { alt: safeAlt } : {}) };
}

/** Capture one frame after the user presses the chat's Screenshot button. */
export async function captureScreenAttachment(): Promise<ChatImageAttachment> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture is not available in this WebView.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
  let video: HTMLVideoElement | undefined;
  try {
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.position = "fixed";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.style.width = "1px";
    video.style.height = "1px";
    document.body.appendChild(video);
    video.srcObject = stream;
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || video.videoHeight < 1) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("No screen frame became available. Stop sharing and try again."));
        }, 10_000);
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("The selected screen could not be read.")); };
        const cleanup = () => {
          window.clearTimeout(timeout);
          video?.removeEventListener("loadeddata", ready);
          video?.removeEventListener("error", failed);
        };
        video!.addEventListener("loadeddata", ready, { once: true });
        video!.addEventListener("error", failed, { once: true });
        if (video!.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video!.videoWidth > 0) ready();
      });
    }
    if (video.videoWidth < 1 || video.videoHeight < 1) throw new Error("The selected screen returned an empty frame.");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the screen screenshot.");
    const maxDimensions = [1440, 1152, 960, 768];
    const qualities = [0.72, 0.64, 0.58, 0.52];
    for (let attempt = 0; attempt < maxDimensions.length; attempt++) {
      const scale = Math.min(1, maxDimensions[attempt]! / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", qualities[attempt]!);
      const comma = dataUrl.indexOf(",");
      if (comma >= 0 && dataUrl.length - comma - 1 <= MAX_CHAT_IMAGE_BASE64_CHARS) {
        return createChatImageAttachment(dataUrl, "Screenshot captured from the selected screen");
      }
    }
    throw new Error("Screenshot could not be compressed small enough to attach to a chat message.");
  } finally {
    stream.getTracks().forEach(track => track.stop());
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
  }
}

