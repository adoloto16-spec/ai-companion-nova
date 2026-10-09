export const NOVA_TURN_PROTOCOL_VERSION = 1 as const;
export const NOVA_TURN_MAX_SERIALIZED_CHARS = 32_000;

export interface NovaToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface NovaTurn {
  version: typeof NOVA_TURN_PROTOCOL_VERSION;
  situation: string;
  thoughts: string;
  emotion: string;
  tools: readonly NovaToolCall[];
  speech: string;
  nextWakeMs: number;
}

export interface NovaTurnParseResult {
  turn?: NovaTurn;
  /** A unique, independently valid SPEECH block can be recovered from a damaged wrapper. */
  speech?: string;
  complete: boolean;
  diagnostics: readonly string[];
}

const FIELD_LIMITS = {
  SITUATION: 4_000,
  THOUGHTS: 8_000,
  EMOTION: 500,
  SPEECH: 4_000,
  TOOL_COUNT: 12,
  TOOL_ARGUMENTS: 4_000,
  NEXT_WAKE_MS: 3_600_000,
} as const;

const TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_entity, name: string) => {
    switch (name) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      default: return _entity;
    }
  });
}

function readSingleTag(source: string, name: string): { value?: string; diagnostic?: string } {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("<" + escapedName + ">([\\s\\S]*?)</" + escapedName + ">", "gi");
  const matches = [...source.matchAll(re)];
  if (matches.length !== 1) return { diagnostic: name + (matches.length === 0 ? "-missing" : "-duplicate") };
  return { value: unescapeXml(matches[0]![1]!).trim() };
}

export function serializeNovaTurn(turn: NovaTurn): string {
  const tools = turn.tools.map(call => {
    if (!TOOL_NAME.test(call.name)) throw new Error("Invalid NovaTurn tool name.");
    return "<" + call.name + ">" + escapeXml(JSON.stringify(call.arguments)) + "</" + call.name + ">";
  }).join("\n");
  return [
    '<NOVA_TURN version="1">',
    "<SITUATION>" + escapeXml(turn.situation) + "</SITUATION>",
    "<THOUGHTS>" + escapeXml(turn.thoughts) + "</THOUGHTS>",
    "<EMOTION>" + escapeXml(turn.emotion) + "</EMOTION>",
    "<TOOLS>" + tools + "</TOOLS>",
    "<SPEECH>" + escapeXml(turn.speech) + "</SPEECH>",
    "<NEXT_WAKE_MS>" + String(turn.nextWakeMs) + "</NEXT_WAKE_MS>",
    "</NOVA_TURN>",
  ].join("\n");
}

/**
 * Parse only the versioned tagged protocol. Plain text, JSON-only responses and
 * unsupported versions are never treated as complete NovaTurn records.
 * Speech recovery is deliberately limited to a single, bounded SPEECH block.
 */
export function parseNovaTurn(content: string): NovaTurnParseResult {
  const diagnostics: string[] = [];
  if (typeof content !== "string" || content.length === 0 || content.length > NOVA_TURN_MAX_SERIALIZED_CHARS) {
    return { complete: false, diagnostics: [typeof content === "string" && content.length > NOVA_TURN_MAX_SERIALIZED_CHARS ? "response-too-large" : "response-empty-or-invalid"] };
  }

  const speechField = readSingleTag(content, "SPEECH");
  const recoveredSpeech = speechField.value !== undefined && speechField.value.length <= FIELD_LIMITS.SPEECH
    ? speechField.value
    : undefined;
  if (speechField.diagnostic) diagnostics.push(speechField.diagnostic);
  if (speechField.value !== undefined && recoveredSpeech === undefined) diagnostics.push("SPEECH-too-long");

  const wrappers = [...content.matchAll(/<NOVA_TURN\b([^>]*)>/gi)];
  const closers = [...content.matchAll(/<\/NOVA_TURN\s*>/gi)];
  const version = wrappers.length === 1 ? wrappers[0]![1]!.match(/\bversion\s*=\s*["'](\d+)["']/i)?.[1] : undefined;
  const wrapperValid = wrappers.length === 1 && closers.length === 1 && closers[0]!.index! > wrappers[0]!.index! && version === "1";
  if (wrappers.length !== 1 || closers.length !== 1) diagnostics.push("NOVA_TURN-wrapper-invalid");
  else if (version !== "1") diagnostics.push("unsupported-protocol-version");

  const body = wrapperValid
    ? content.slice(wrappers[0]!.index! + wrappers[0]![0].length, closers[0]!.index)
    : content;
  const situationField = readSingleTag(body, "SITUATION");
  const thoughtsField = readSingleTag(body, "THOUGHTS");
  const emotionField = readSingleTag(body, "EMOTION");
  const toolsField = readSingleTag(body, "TOOLS");
  const nextWakeField = readSingleTag(body, "NEXT_WAKE_MS");
  for (const field of [situationField, thoughtsField, emotionField, toolsField, nextWakeField]) {
    if (field.diagnostic) diagnostics.push(field.diagnostic);
  }

  const boundedText = (name: keyof typeof FIELD_LIMITS, raw: string | undefined): string => {
    const limit = FIELD_LIMITS[name] as number;
    if (raw === undefined) return "";
    if (raw.length > limit) {
      diagnostics.push(name + "-too-long");
      return "";
    }
    return raw;
  };
  let tools: NovaToolCall[] = [];
  if (toolsField.value !== undefined) {
    const toolContent = toolsField.value;
    const calls = [...toolContent.matchAll(/<([a-z][a-z0-9_.-]*)>([\s\S]*?)<\/\1>/gi)];
    const residue = toolContent.replace(/<([a-z][a-z0-9_.-]*)>[\s\S]*?<\/\1>/gi, "").trim();
    if (residue) diagnostics.push("TOOLS-malformed-content");
    if (calls.length > FIELD_LIMITS.TOOL_COUNT) diagnostics.push("TOOLS-too-many");
    for (const match of calls.slice(0, FIELD_LIMITS.TOOL_COUNT)) {
      const name = match[1]!;
      const json = unescapeXml(match[2]!).trim();
      if (!TOOL_NAME.test(name) || json.length > FIELD_LIMITS.TOOL_ARGUMENTS) {
        diagnostics.push("tool-call-invalid:" + name);
        continue;
      }
      try {
        const args: unknown = JSON.parse(json);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          diagnostics.push("tool-arguments-invalid:" + name);
          continue;
        }
        tools.push({ name, arguments: args as Record<string, unknown> });
      } catch {
        diagnostics.push("tool-arguments-invalid:" + name);
      }
    }
  }

  const nextWakeRaw = nextWakeField.value;
  const nextWakeMs = nextWakeRaw !== undefined && /^\d+$/.test(nextWakeRaw) ? Number(nextWakeRaw) : Number.NaN;
  const nextWakeValid = Number.isSafeInteger(nextWakeMs) && nextWakeMs >= 1 && nextWakeMs <= FIELD_LIMITS.NEXT_WAKE_MS;
  if (!nextWakeValid) diagnostics.push("NEXT_WAKE_MS-invalid");

  const situation = boundedText("SITUATION", situationField.value);
  const thoughts = boundedText("THOUGHTS", thoughtsField.value);
  const emotion = boundedText("EMOTION", emotionField.value);
  const speech = boundedText("SPEECH", recoveredSpeech);
  const toolsFieldValid = toolsField.value !== undefined && !diagnostics.some(d => d.startsWith("TOOLS-") || d.startsWith("tool-"));
  const complete = wrapperValid && situationField.value !== undefined && thoughtsField.value !== undefined &&
    emotionField.value !== undefined && toolsFieldValid && recoveredSpeech !== undefined && nextWakeValid &&
    situationField.value.length <= FIELD_LIMITS.SITUATION && thoughtsField.value.length <= FIELD_LIMITS.THOUGHTS &&
    emotionField.value.length <= FIELD_LIMITS.EMOTION;
  if (!complete && diagnostics.length === 0) diagnostics.push("protocol-incomplete");

  if (recoveredSpeech === undefined) {
    return { complete: false, diagnostics };
  }
  return {
    turn: {
      version: NOVA_TURN_PROTOCOL_VERSION,
      situation,
      thoughts,
      emotion,
      tools,
      speech,
      nextWakeMs: nextWakeValid ? nextWakeMs : 30_000,
    },
    speech,
    complete,
    diagnostics,
  };
}
