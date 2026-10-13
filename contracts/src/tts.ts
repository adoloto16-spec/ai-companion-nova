export type TtsAudioFormat = "pcm16le";

export interface TtsCredentialReference {
  id: string;
  kind: string;
  provider?: string;
  version?: string;
}

export interface TtsPreset {
  id: string;
  name: string;
  providerId: string;
  baseUrl: string;
  voiceProfileId: string;
  language: string;
  speed: number;
  credentialReference: TtsCredentialReference | null;
  /** Provider-specific, non-secret settings. The selected adapter validates this object. */
  providerOptions: Record<string, unknown>;
}

export interface TtsSettings {
  enabled: boolean;
  activePresetId: string | null;
  presets: TtsPreset[];
}

export const DEFAULT_TTS_PRESET_ID = "tts-preset-default";
export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  activePresetId: DEFAULT_TTS_PRESET_ID,
  presets: [{
    id: DEFAULT_TTS_PRESET_ID,
    name: "VoiceStudio",
    providerId: "voice-studio",
    baseUrl: "http://127.0.0.1:3900",
    voiceProfileId: "",
    language: "ru",
    speed: 1,
    credentialReference: null,
    providerOptions: {}
  }]
};

export interface TtsAudioMetadata {
  format: TtsAudioFormat;
  sampleRate: number;
  channels: number;
}

export interface TtsProviderCapabilities {
  streaming: boolean;
  audioFormats: readonly TtsAudioFormat[];
  supportsVoiceProfiles: boolean;
  supportsLanguage: boolean;
  supportsSpeed: boolean;
  supportsInstruction: boolean;
  nonverbalTags: readonly ("laughter" | "sigh")[];
  maxTextChars: number;
}

export interface TtsSynthesisRequest {
  sessionId: string;
  text: string;
  preset: TtsPreset;
  /** Free-form NovaTurn emotion text; it is not a universal enum. */
  emotion: string;
  /** Adapter-normalized optional instruction and nonverbal actions. */
  instruction?: string;
}

export interface TtsStreamEventStart {
  type: "start";
  sessionId: string;
  audio: TtsAudioMetadata;
}
export interface TtsStreamEventRouting {
  type: "routing";
  sessionId: string;
  status: string;
  reason?: string;
}
export interface TtsStreamEventAudio {
  type: "audio";
  sessionId: string;
  sequence: number;
  data: Uint8Array;
}
export interface TtsStreamEventDone {
  type: "done";
  sessionId: string;
}
export interface TtsStreamEventError {
  type: "error";
  sessionId: string;
  error: { code: string; message: string; retryable: boolean };
}
export type TtsStreamEvent =
  | TtsStreamEventStart
  | TtsStreamEventRouting
  | TtsStreamEventAudio
  | TtsStreamEventDone
  | TtsStreamEventError;

export interface TtsOperationOptions {
  signal: AbortSignal;
}

export interface TtsProviderHealth {
  status: "healthy" | "degraded" | "unavailable" | "error";
  message?: string;
}

/**
 * Providers expose one event stream for both streaming and single-shot synthesis.
 * Single-shot adapters emit start, one or more audio events, then done.
 */
export interface TtsProvider {
  readonly id: string;
  capabilities(): TtsProviderCapabilities;
  synthesize(request: TtsSynthesisRequest, options: TtsOperationOptions): AsyncIterable<TtsStreamEvent>;
  testConnection(preset: TtsPreset, signal: AbortSignal): Promise<TtsProviderHealth>;
}
