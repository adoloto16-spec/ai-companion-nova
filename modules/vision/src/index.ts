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
/**
 * A user-authorized screen capture that remains alive until Vision is switched off.
 * Chat captures one fresh frame immediately before each outgoing user request.
 */
export interface ScreenVisionSession {
  capture(): Promise<ChatImageAttachment>;
  stop(): void;
  onEnded(listener: () => void): () => void;
}

function hasCurrentFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
}

async function waitForCurrentFrame(video: HTMLVideoElement): Promise<void> {
  if (hasCurrentFrame(video)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("No screen frame became available. Check the selected window and try again."));
    }, 10_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("resize", ready);
      video.removeEventListener("error", failed);
    };
    const ready = () => {
      if (!hasCurrentFrame(video)) return;
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("The selected screen could not be read."));
    };
    video.addEventListener("loadeddata", ready);
    video.addEventListener("canplay", ready);
    video.addEventListener("resize", ready);
    video.addEventListener("error", failed);
    ready();
  });
}

function encodeCurrentFrame(video: HTMLVideoElement): ChatImageAttachment {
  if (!hasCurrentFrame(video)) throw new Error("The screen capture returned an empty frame.");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the screen screenshot.");
  const maxDimensions = [1440, 1152, 960, 768, 640, 512];
  const qualities = [0.72, 0.64, 0.58, 0.52, 0.46, 0.4];
  for (let attempt = 0; attempt < maxDimensions.length; attempt++) {
    const scale = Math.min(1, maxDimensions[attempt]! / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", qualities[attempt]!);
    const comma = dataUrl.indexOf(",");
    if (comma >= 0 && dataUrl.length - comma - 1 <= MAX_CHAT_IMAGE_BASE64_CHARS) {
      return createChatImageAttachment(dataUrl, "Automatic screen snapshot for the current chat request");
    }
  }
  throw new Error("The screen could not be compressed to the supported request size.");
}

export async function startScreenVisionSession(): Promise<ScreenVisionSession> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture is not available in this WebView.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 5, max: 15 } },
    audio: false
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach(item => item.stop());
    throw new Error("The selected screen did not provide a video track.");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  video.style.width = "1px";
  video.style.height = "1px";
  document.body.appendChild(video);
  video.srcObject = stream;
  try {
    await video.play();
    await waitForCurrentFrame(video);
  } catch (error) {
    stream.getTracks().forEach(item => item.stop());
    video.pause();
    video.srcObject = null;
    video.remove();
    throw error instanceof Error ? error : new Error("The selected screen could not be started.");
  }

  let stopped = false;
  const listeners = new Set<() => void>();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    track.removeEventListener("ended", handleEnded);
    listeners.clear();
    stream.getTracks().forEach(item => item.stop());
    video.pause();
    video.srcObject = null;
    video.remove();
  };
  const handleEnded = () => {
    if (stopped) return;
    for (const listener of [...listeners]) listener();
    stop();
  };
  track.addEventListener("ended", handleEnded);

  return {
    async capture() {
      if (stopped || track.readyState !== "live") {
        throw new Error("Screen sharing has stopped. Turn Vision on again to resume automatic screenshots.");
      }
      await waitForCurrentFrame(video);
      if (stopped || track.readyState !== "live") {
        throw new Error("Screen sharing stopped before the screenshot could be captured.");
      }
      return encodeCurrentFrame(video);
    },
    stop,
    onEnded(listener) {
      if (stopped || track.readyState !== "live") {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/** Compatibility helper for callers that explicitly need a single, isolated capture. */
export async function captureScreenAttachment(): Promise<ChatImageAttachment> {
  const session = await startScreenVisionSession();
  try {
    return await session.capture();
  } finally {
    session.stop();
  }
}
