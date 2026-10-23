export const AVATAR_API_VERSION = "1" as const;
export const AVATAR_SCHEMA_VERSION = "1" as const;
export const AVATAR_CHANNEL_NAME = "nova-avatar-runtime";

export type AvatarFormat = "vrm" | "glb" | "live2d";
export type AvatarAction = "idle" | "talk" | "wave" | "point" | "look" | "walk";
export type AvatarExpression = "neutral" | "happy" | "sad" | "surprised";
export type AvatarAutonomy = "off" | "balanced" | "active";

export interface NormalizedScreenTarget { x: number; y: number; }
export interface NormalizedBounds { x: number; y: number; width: number; height: number; }
export type DisplaySurface = "monitor" | "window" | "browser" | "unknown";
export interface ScreenCaptureGeometry { surface: DisplaySurface; width: number; height: number; }
export interface AvatarMonitorGeometry {
  name?: string | null;
  physicalSize: { width: number; height: number };
  logicalPosition: { x: number; y: number };
  logicalSize: { width: number; height: number };
  workAreaPosition: { x: number; y: number };
  workAreaSize: { width: number; height: number };
  scaleFactor: number;
}
export interface OverlayPlacement { x: number; y: number; width: number; height: number; }
export interface AvatarIntent {
  action: AvatarAction;
  expression: AvatarExpression;
  intensity: number;
  target?: NormalizedScreenTarget;
  label?: string;
}
export interface AvatarSettings {
  scale: number;
  cameraDistance: number;
  idleMotion: boolean;
  breathing: boolean;
  blink: boolean;
  lookAround: boolean;
  motionIntensity: number;
  autonomy: AvatarAutonomy;
  overlayPassthrough: boolean;
}
export interface AvatarProfile {
  id: string;
  name: string;
  format: AvatarFormat;
  assetId: string;
  settings: AvatarSettings;
  createdAt: string;
  updatedAt: string;
}
export const DEFAULT_AVATAR_SETTINGS: AvatarSettings = {
  scale: 1, cameraDistance: 1.7, idleMotion: true, breathing: true, blink: true,
  lookAround: true, motionIntensity: 1, autonomy: "balanced", overlayPassthrough: false
};
export type AvatarSignal =
  | { type: "dialogue"; text: string; speaking: boolean }
  | { type: "user-action"; action: "wave" | "look" }
  | { type: "screen-region"; label: string; bounds: { x: number; y: number; width: number; height: number }; confidence: number }
  | { type: "emotion"; expression: AvatarExpression; intensity?: number };
export type AvatarBroadcastEvent = { kind: "intent"; intent: AvatarIntent } | { kind: "profile-updated" };

/** A screen-capture stream may refer to a monitor, a window, or a browser tab. */
export function findUniqueMatchingMonitor(
  capture: ScreenCaptureGeometry,
  monitors: readonly AvatarMonitorGeometry[]
): AvatarMonitorGeometry | undefined {
  if (capture.surface === "window" || capture.surface === "browser" ||
      !Number.isFinite(capture.width) || !Number.isFinite(capture.height) || capture.width < 1 || capture.height < 1) return undefined;
  const matches = monitors.filter(monitor => {
    const { width, height } = monitor.physicalSize;
    if (![width, height, monitor.scaleFactor].every(Number.isFinite) || width < 1 || height < 1 || monitor.scaleFactor <= 0) return false;
    const widthTolerance = Math.max(8, width * 0.015);
    const heightTolerance = Math.max(8, height * 0.015);
    return Math.abs(capture.width - width) <= widthTolerance && Math.abs(capture.height - height) <= heightTolerance;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Place the overlay beside the selected region, clamped to the target monitor's work area. */
export function resolveOverlayPlacement(
  bounds: NormalizedBounds,
  monitor: AvatarMonitorGeometry,
  requested = { width: 320, height: 500 },
  margin = 18
): OverlayPlacement {
  const values = [
    bounds.x, bounds.y, bounds.width, bounds.height,
    monitor.logicalPosition.x, monitor.logicalPosition.y, monitor.logicalSize.width, monitor.logicalSize.height,
    monitor.workAreaPosition.x, monitor.workAreaPosition.y, monitor.workAreaSize.width, monitor.workAreaSize.height,
    requested.width, requested.height, margin
  ];
  if (!values.every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.x >= 1 || bounds.y >= 1 ||
      bounds.width <= 0 || bounds.height <= 0 || monitor.logicalSize.width <= 0 || monitor.logicalSize.height <= 0 ||
      monitor.workAreaSize.width <= 0 || monitor.workAreaSize.height <= 0) {
    throw new Error("Screen-to-overlay placement geometry is invalid.");
  }
  const width = Math.min(Math.max(1, requested.width), monitor.workAreaSize.width);
  const height = Math.min(Math.max(1, requested.height), monitor.workAreaSize.height);
  const centerX = Math.min(1, bounds.x + bounds.width / 2);
  const centerY = Math.min(1, bounds.y + bounds.height / 2);
  const targetX = monitor.logicalPosition.x + centerX * monitor.logicalSize.width;
  const targetY = monitor.logicalPosition.y + centerY * monitor.logicalSize.height;
  const proposedX = centerX > 0.55 ? targetX - width - margin : targetX + margin;
  const proposedY = targetY - height * 0.68;
  const x = Math.min(monitor.workAreaPosition.x + monitor.workAreaSize.width - width, Math.max(monitor.workAreaPosition.x, proposedX));
  const y = Math.min(monitor.workAreaPosition.y + monitor.workAreaSize.height - height, Math.max(monitor.workAreaPosition.y, proposedY));
  // Native window placement is pixel-based; remove IEEE-754 residue before sending coordinates to Tauri.
  return { x: Math.round(x), y: Math.round(y), width, height };
}

let channel: BroadcastChannel | undefined;
function getChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  if (!channel) channel = new BroadcastChannel(AVATAR_CHANNEL_NAME);
  return channel;
}
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAvatarSettings(input: unknown): AvatarSettings {
  const value = isRecord(input) ? input : {};
  const autonomy = value.autonomy === "off" || value.autonomy === "active" || value.autonomy === "balanced"
    ? value.autonomy : DEFAULT_AVATAR_SETTINGS.autonomy;
  return {
    scale: clamp(Number(value.scale), 0.5, 1.8, DEFAULT_AVATAR_SETTINGS.scale),
    cameraDistance: clamp(Number(value.cameraDistance), 1.1, 3.5, DEFAULT_AVATAR_SETTINGS.cameraDistance),
    idleMotion: typeof value.idleMotion === "boolean" ? value.idleMotion : true,
    breathing: typeof value.breathing === "boolean" ? value.breathing : true,
    blink: typeof value.blink === "boolean" ? value.blink : true,
    lookAround: typeof value.lookAround === "boolean" ? value.lookAround : true,
    motionIntensity: clamp(Number(value.motionIntensity), 0, 2, DEFAULT_AVATAR_SETTINGS.motionIntensity),
    autonomy,
    overlayPassthrough: typeof value.overlayPassthrough === "boolean" ? value.overlayPassthrough : false
  };
}

export function classifyAvatarFileName(fileName: string): AvatarFormat {
  const name = fileName.trim().toLowerCase();
  if (name.endsWith(".vrm")) return "vrm";
  if (name.endsWith(".glb")) return "glb";
  throw new Error("Choose a .vrm file or a self-contained .glb file. Live2D requires the separate Cubism SDK adapter.");
}

export function resolveDialogueIntent(text: string, speaking: boolean): AvatarIntent {
  const value = text.slice(0, 5000);
  const expression: AvatarExpression =
    /\b(wow|surprising|unexpected)\b|неожиданно|удивительно|ого/i.test(value) ? "surprised" :
    /\b(sorry|sad|unfortunately)\b|жаль|сочувствую|к сожалению/i.test(value) ? "sad" :
    /\b(great|nice|excellent|love|wonderful|interesting)\b|отлично|здорово|класс|любопытно|интересно/i.test(value) ? "happy" : "neutral";
  return { action: speaking ? "talk" : "idle", expression, intensity: speaking ? 0.75 : expression === "neutral" ? 0.25 : 0.55 };
}

export function resolveAvatarSignal(signal: AvatarSignal): AvatarIntent {
  if (signal.type === "dialogue") return resolveDialogueIntent(signal.text, signal.speaking);
  if (signal.type === "user-action") return {
    action: signal.action, expression: signal.action === "wave" ? "happy" : "neutral",
    intensity: signal.action === "wave" ? 1 : 0.65
  };
  if (signal.type === "emotion") return {
    action: "idle", expression: signal.expression, intensity: clamp(signal.intensity ?? 0.5, 0, 1, 0.5)
  };
  const { x, y, width, height } = signal.bounds;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x >= 1 || y >= 1) {
    throw new Error("Screen region bounds are invalid.");
  }
  return {
    action: "point", expression: "surprised", intensity: clamp(signal.confidence, 0.2, 1, 0.5),
    target: { x: clamp(x + width / 2, 0, 1, 0.5), y: clamp(y + height / 2, 0, 1, 0.5) },
    ...(signal.label.trim() ? { label: signal.label.trim().slice(0, 120) } : {})
  };
}

export function publishAvatarIntent(intent: AvatarIntent): void {
  getChannel()?.postMessage({ kind: "intent", intent } satisfies AvatarBroadcastEvent);
}
export function publishAvatarProfileUpdated(): void {
  getChannel()?.postMessage({ kind: "profile-updated" } satisfies AvatarBroadcastEvent);
}
export function subscribeAvatarEvents(listener: (event: AvatarBroadcastEvent) => void): () => void {
  const current = getChannel();
  if (!current) return () => undefined;
  const handler = (message: MessageEvent<unknown>) => {
    const value = message.data;
    if (!isRecord(value)) return;
    if (value.kind === "profile-updated") { listener({ kind: "profile-updated" }); return; }
    if (value.kind !== "intent" || !isRecord(value.intent)) return;
    const raw = value.intent;
    const actions: readonly string[] = ["idle", "talk", "wave", "point", "look", "walk"];
    const expressions: readonly string[] = ["neutral", "happy", "sad", "surprised"];
    if (typeof raw.action !== "string" || !actions.includes(raw.action) ||
        typeof raw.expression !== "string" || !expressions.includes(raw.expression)) return;
    const intent: AvatarIntent = {
      action: raw.action as AvatarAction, expression: raw.expression as AvatarExpression,
      intensity: clamp(Number(raw.intensity), 0, 1, 0.5),
      ...(typeof raw.label === "string" ? { label: raw.label.slice(0, 120) } : {}),
      ...(isRecord(raw.target) ? { target: { x: clamp(Number(raw.target.x), 0, 1, 0.5), y: clamp(Number(raw.target.y), 0, 1, 0.5) } } : {})
    };
    listener({ kind: "intent", intent });
  };
  current.addEventListener("message", handler);
  return () => current.removeEventListener("message", handler);
}
