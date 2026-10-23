export const SCREEN_UNDERSTANDING_API_VERSION = "1" as const;
export const SCREEN_UNDERSTANDING_SCHEMA_VERSION = "1" as const;
export const MAX_SCREEN_IMAGE_BASE64_CHARS = 1_750_000;

export interface NormalizedBounds { x: number; y: number; width: number; height: number; }
export interface ScreenRegion {
  id: string; label: string; description: string; bounds: NormalizedBounds; confidence: number;
}
export interface ScreenFrame {
  imageBase64: string; width: number; height: number; capturedAt: string; source: "display-capture";
}
export interface ScreenObservation {
  apiVersion: typeof SCREEN_UNDERSTANDING_API_VERSION;
  schemaVersion: typeof SCREEN_UNDERSTANDING_SCHEMA_VERSION;
  summary: string;
  frame: { width: number; height: number; capturedAt: string; source: ScreenFrame["source"] };
  regions: readonly ScreenRegion[];
}
export interface VisionInferenceRequest { model: string; prompt: string; imageBase64: string; signal?: AbortSignal; }
export interface VisionInference { analyzeImage(request: VisionInferenceRequest): Promise<string>; }

export const SCREEN_ANALYSIS_PROMPT = `Analyze this screenshot for the user's current task. Return JSON only:
{"summary":"brief summary of visible content","regions":[{"label":"short target label","description":"what is visible","x":0,"y":0,"width":0,"height":0,"confidence":0}]}
Coordinates and dimensions must be normalized to the full image from 0 to 1, with x/y measured from the top-left. Include only clearly visible regions, at most 12. Do not infer hidden content or exact video timestamps. Confidence must be between 0 and 1.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function parseObject(raw: string): Record<string, unknown> {
  let value = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    const start = value.indexOf("{"), end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      value = value.slice(start, end + 1);
      try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) return parsed; } catch { /* stable error below */ }
    }
  }
  throw new Error("The vision model did not return a valid JSON object.");
}

export function parseScreenObservation(
  raw: string,
  frame: Pick<ScreenFrame, "width" | "height" | "capturedAt" | "source">
): ScreenObservation {
  if (![frame.width, frame.height].every(Number.isInteger) || frame.width < 1 || frame.height < 1) {
    throw new Error("Captured screen dimensions are invalid.");
  }
  const parsed = parseObject(raw);
  const regions: ScreenRegion[] = [];
  (Array.isArray(parsed.regions) ? parsed.regions.slice(0, 12) : []).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    const x = Number(candidate.x), y = Number(candidate.y), width = Number(candidate.width);
    const height = Number(candidate.height), confidence = Number(candidate.confidence);
    if (![x, y, width, height, confidence].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0) return;
    regions.push({
      id: "screen-region-" + (index + 1),
      label: text(candidate.label, "Region " + (index + 1), 120),
      description: text(candidate.description, "Visible screen region.", 500),
      bounds: { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) },
      confidence: clamp(confidence, 0, 1)
    });
  });
  return {
    apiVersion: SCREEN_UNDERSTANDING_API_VERSION,
    schemaVersion: SCREEN_UNDERSTANDING_SCHEMA_VERSION,
    summary: text(parsed.summary, "No summary was returned.", 2000),
    frame: { ...frame }, regions
  };
}

export async function analyzeScreenFrame(
  frame: ScreenFrame, inference: VisionInference, model: string, signal?: AbortSignal
): Promise<ScreenObservation> {
  if (!model.trim()) throw new Error("Select the existing local Ollama vision model before analyzing a frame.");
  if (!frame.imageBase64.trim()) throw new Error("No screen image was captured.");
  if (![frame.width, frame.height].every(Number.isInteger) || frame.width < 1 || frame.height < 1) throw new Error("Captured screen dimensions are invalid.");
  const rawImage = frame.imageBase64.includes(",") ? frame.imageBase64.slice(frame.imageBase64.indexOf(",") + 1) : frame.imageBase64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rawImage)) throw new Error("Captured screen image is not valid base64 data.");
  if (rawImage.length > MAX_SCREEN_IMAGE_BASE64_CHARS) throw new Error("Screenshot is too large for the local vision transport.");
  const raw = await inference.analyzeImage({ model: model.trim(), prompt: SCREEN_ANALYSIS_PROMPT, imageBase64: rawImage, ...(signal ? { signal } : {}) });
  return parseScreenObservation(raw, frame);
}
