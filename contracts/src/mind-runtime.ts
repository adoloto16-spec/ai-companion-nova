import type {NovaToolCall, NovaToolResult, NovaTurn} from "./nova-turn";

export type MindRuntimeLifecycleState = "off" | "starting" | "thinking" | "waiting" | "stopping" | "error";
export type MindWakeReason = "life-start" | "scheduled" | "user-message" | "character-change" | "tool-result" | "error-backoff" | "quota-available";
export type MindTraceResult = "success" | "error" | "cancelled" | "deferred";

export interface MindReactiveTurn {
  characterId: string;
  conversationId: string;
  userMessageId: string;
  turnId: string;
}

export interface MindState {
  lifecycleState: MindRuntimeLifecycleState;
  nextWakeAt?: string | null;
  recentTrace?: readonly MindTraceEntry[];
}

export interface MindTraceEntry {
  runId: string;
  characterId: string;
  wakeReason: MindWakeReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: MindTraceResult;
  requestedNextWakeMs?: number;
  appliedIntervalMs?: number;
  intervalDecision?: string;
  requestId?: string;
  providerId?: string;
  errorCode?: string;
  protocolDiagnostics?: readonly string[];
}

export interface MindTurnExecutionContext {
  characterId: string;
  conversationId: string;
  /** Stable for a correlated reactive user turn; unique for background turns. */
  turnId: string;
  userMessageId?: string;
  requestId?: string;
  providerId?: string;
  model?: string;
  providerPresetId?: string;
  signal: AbortSignal;
}

export interface MindTurnSink {
  /** Persists the complete tagged turn exactly once in the canonical Conversation. */
  commit(turn: NovaTurn, context: MindTurnExecutionContext): Promise<void>;
  /** Makes a failed reactive turn visible while leaving its persisted user message retryable. */
  fail?(turn: MindReactiveTurn, reason: string): void;
}

export interface MindToolExecutionContext extends MindTurnExecutionContext {
  callId: string;
  index: number;
}

export interface MindToolExecutor {
  execute(call: NovaToolCall, context: MindToolExecutionContext): Promise<NovaToolResult>;
}
