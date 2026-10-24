export const AVATAR_API_VERSION = "1" as const;
export const AVATAR_SCHEMA_VERSION = "1" as const;
export const AVATAR_CHANNEL_NAME = "nova-avatar-runtime";

export type AvatarFormat = "vrm" | "glb" | "live2d";
export type AvatarAction = "idle" | "talk" | "wave" | "look";
export type AvatarExpression = "neutral" | "happy" | "sad" | "surprised";
export type AvatarAutonomy = "off" | "balanced" | "active";

export interface AvatarIntent {
  action: AvatarAction;
  expression: AvatarExpression;
  intensity: number;
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
  | { type: "emotion"; expression: AvatarExpression; intensity?: number };
export type AvatarBroadcastEvent = { kind: "intent"; intent: AvatarIntent } | { kind: "profile-updated" };

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
  return {
    action: "idle", expression: signal.expression, intensity: clamp(signal.intensity ?? 0.5, 0, 1, 0.5)
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
    const actions: readonly string[] = ["idle", "talk", "wave", "look"];
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
