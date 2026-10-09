import type {CognitiveScheduleSettings} from "../../contracts/src";
import {DEFAULT_COGNITIVE_SCHEDULE} from "../../contracts/src";
import type {MindReactiveTurn, MindState, MindTraceEntry, MindWakeReason, MindRuntimeLifecycleState, MindTurnSink, MindToolExecutor} from "../../contracts/src";
import type {NovaToolResult, NovaTurn} from "../../contracts/src/nova-turn";
import type {CognitiveStep, CognitiveStepContext, CognitiveStepResult} from "./llm-cognitive-step";
import {MindScheduler} from "./mind-scheduler";

const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const MAX_TRACE_ENTRIES = 100;
const MAX_TOOL_RESULT_CHARS = 4_000;
const HOUR_MS = 3_600_000;
type CancellationKind = "cancelled" | "superseded" | "timeout";
interface IntervalChoice { intervalMs: number; requested?: number; decision: string; }

function abortError(): Error { const error = new Error("Mind Runtime cognitive step aborted."); error.name = "AbortError"; return error; }
function validInteger(value: unknown, fallback: number, min = 1, max = 3_600_000): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function normalizeSchedule(schedule?: CognitiveScheduleSettings): CognitiveScheduleSettings {
  const minIntervalMs = validInteger(schedule?.minIntervalMs, 3_000);
  const maxIntervalMs = Math.max(minIntervalMs, validInteger(schedule?.maxIntervalMs, 300_000));
  const defaultIntervalMs = Math.min(maxIntervalMs, Math.max(minIntervalMs, validInteger(schedule?.defaultIntervalMs, 30_000)));
  const quota = schedule?.maxRequestsPerHour;
  const maxRequestsPerHour = quota === null ? null : validInteger(quota, DEFAULT_COGNITIVE_SCHEDULE.maxRequestsPerHour ?? 0, 1, 3_600);
  return { mode: schedule?.mode === "fixed" ? "fixed" : "adaptive", defaultIntervalMs, minIntervalMs, maxIntervalMs, maxRequestsPerHour };
}
function chooseInterval(raw: unknown, settings: CognitiveScheduleSettings, diagnostics: readonly string[] = []): IntervalChoice {
  if (diagnostics.includes("NEXT_WAKE_MS-invalid") || typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    return { intervalMs: settings.defaultIntervalMs, ...(typeof raw === "number" ? {requested: raw} : {}), decision: "invalid-next-wake-default" };
  }
  if (settings.mode === "fixed") return { intervalMs: settings.defaultIntervalMs, requested: raw, decision: "fixed-mode" };
  if (raw < settings.minIntervalMs) return { intervalMs: settings.minIntervalMs, requested: raw, decision: "below-minimum-clamped" };
  if (raw > settings.maxIntervalMs) return { intervalMs: settings.maxIntervalMs, requested: raw, decision: "above-maximum-clamped" };
  return { intervalMs: raw, requested: raw, decision: "model" };
}
function priority(reason: MindWakeReason): number {
  switch (reason) {
    case "user-message": return 6;
    case "character-change": return 5;
    case "tool-result": return 4;
    case "life-start": return 3;
    case "error-backoff": return 2;
    case "quota-available": return 1;
    default: return 0;
  }
}
function mergeWakeReason(current: MindWakeReason | undefined, next: MindWakeReason): MindWakeReason {
  return !current || priority(next) > priority(current) ? next : current;
}
function safeToolOutput(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { value: String(value).slice(0, MAX_TOOL_RESULT_CHARS) };
    if (json.length <= MAX_TOOL_RESULT_CHARS) return JSON.parse(json);
    return { truncated: true, preview: json.slice(0, MAX_TOOL_RESULT_CHARS) };
  } catch { return { error: "Tool result was not serializable." }; }
}
function cloneState(state: MindState): MindState {
  return {...state, nextWakeAt: state.nextWakeAt ?? null, recentTrace: (state.recentTrace ?? []).map(entry => ({...entry, ...(entry.protocolDiagnostics ? {protocolDiagnostics:[...entry.protocolDiagnostics]} : {})}))};
}

export interface CognitiveStepContext {
  characterId: string;
  state: Readonly<MindState>;
  signal: AbortSignal;
  wakeReason: MindWakeReason;
  userTurn?: MindReactiveTurn;
}
export interface CognitiveStepResult {
  turn: NovaTurn;
  conversationId: string;
  requestId?: string;
  providerId?: string;
  model?: string;
  providerPresetId?: string;
  protocolDiagnostics?: readonly string[];
}
export interface CognitiveStep { run(context: CognitiveStepContext): Promise<CognitiveStepResult>; }
export interface MindRuntimeOptions {
  cognitiveStep: CognitiveStep;
  schedule?: CognitiveScheduleSettings;
  stepTimeoutMs?: number;
  onError?: (error: unknown) => void;
  onDiagnostic?: (code: string, detail: string) => void;
  clock?: () => string;
  now?: () => number;
  turnSink?: MindTurnSink;
  toolExecutor?: MindToolExecutor;
}
export class MindRuntime {
  private readonly cognitiveStep: CognitiveStep;
  private readonly stepTimeoutMs: number;
  private readonly onError?: MindRuntimeOptions["onError"];
  private readonly onDiagnostic?: MindRuntimeOptions["onDiagnostic"];
  private readonly clock: () => string;
  private readonly now: () => number;
  private scheduleSettings: CognitiveScheduleSettings;
  private turnSink: MindTurnSink | undefined;
  private toolExecutor: MindToolExecutor | undefined;
  private readonly state: MindState = { lifecycleState: "off", nextWakeAt: null, recentTrace: [] };
  private readonly listeners = new Set<(state: MindState) => void>();
  private readonly trace: MindTraceEntry[] = [];
  private readonly requestStarts: number[] = [];
  private readonly completedTurns = new Set<string>();
  private readonly toolResultCache = new Map<string, NovaToolResult>();
  private readonly scheduler: MindScheduler;
  private activeCharacterId: string | undefined;
  private lifeController: AbortController | undefined;
  private stepController: AbortController | undefined;
  private cancelActiveStep: ((kind: CancellationKind) => void) | undefined;
  private stepPromise: Promise<void> | undefined;
  private stepActive = false;
  private pendingWakeReason: MindWakeReason | undefined;
  private pendingReactiveTurn: MindReactiveTurn | undefined;
  private contextVersion = 0;
  private runSequence = 0;
  private consecutiveErrors = 0;
  private lastRequestStartedAt: number | undefined;

  constructor(options: MindRuntimeOptions) {
    if (options.stepTimeoutMs !== undefined && (!Number.isSafeInteger(options.stepTimeoutMs) || options.stepTimeoutMs < 1)) throw new Error("Mind Runtime step timeout must be a positive integer.");
    this.cognitiveStep = options.cognitiveStep;
    this.scheduleSettings = normalizeSchedule(options.schedule);
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.onError = options.onError;
    this.onDiagnostic = options.onDiagnostic;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.now = options.now ?? Date.now;
    this.turnSink = options.turnSink;
    this.toolExecutor = options.toolExecutor;
    this.scheduler = new MindScheduler(reason => this.handleWake(reason), this.now);
  }
  getState(): MindState { return cloneState(this.state); }
  subscribe(listener: (state: MindState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setNovaTurnSink(sink: MindTurnSink | undefined): void { this.turnSink = sink; }
  setToolExecutor(executor: MindToolExecutor | undefined): void { this.toolExecutor = executor; }

  setActiveCharacter(characterId: string): void {
    const normalized = characterId.trim();
    if (!normalized) throw new Error("Mind Runtime active character id must not be empty.");
    if (normalized === this.activeCharacterId) return;
    if (this.pendingReactiveTurn) this.failReactiveTurn(this.pendingReactiveTurn, "character-change");
    this.activeCharacterId = normalized;
    this.contextVersion += 1;
    if (this.lifeController && !this.lifeController.signal.aborted) this.wake("character-change");
    this.notify();
  }
  async start(): Promise<void> {
    if (this.state.lifecycleState !== "off") throw new Error("Mind Runtime cannot start from state " + this.state.lifecycleState + ".");
    if (!this.activeCharacterId) throw new Error("Mind Runtime cannot start without an active character.");
    this.lifeController = new AbortController();
    this.pendingWakeReason = undefined;
    this.consecutiveErrors = 0;
    this.scheduler.cancel();
    this.state.nextWakeAt = null;
    this.setLifecycleState("starting");
    this.scheduler.wake("life-start");
  }
  async stop(): Promise<void> {
    if (this.state.lifecycleState === "off" && !this.lifeController) return;
    this.scheduler.cancel();
    this.state.nextWakeAt = null;
    this.pendingWakeReason = undefined;
    if (this.pendingReactiveTurn) this.failReactiveTurn(this.pendingReactiveTurn, "life-off");
    this.setLifecycleState("stopping");
    const controller = this.lifeController;
    controller?.abort();
    this.cancelActiveStep?.("cancelled");
    const running = this.stepPromise;
    if (running) await running;
    this.lifeController = undefined;
    this.stepController = undefined;
    this.cancelActiveStep = undefined;
    this.stepPromise = undefined;
    this.stepActive = false;
    this.state.nextWakeAt = null;
    this.setLifecycleState("off");
  }
  wake(reason: MindWakeReason = "scheduled"): void {
    const life = this.lifeController;
    if (!life || life.signal.aborted || this.state.lifecycleState === "off" || this.state.lifecycleState === "stopping") return;
    this.scheduler.cancel();
    this.state.nextWakeAt = null;
    if (this.stepActive) {
      this.pendingWakeReason = mergeWakeReason(this.pendingWakeReason, reason);
      if (reason === "user-message" || reason === "character-change") this.cancelActiveStep?.("superseded");
      this.notify();
      return;
    }
    this.scheduler.wake(reason);
  }
  wakeForUserMessage(turn: MindReactiveTurn): boolean {
    const life = this.lifeController;
    if (!turn || !turn.characterId?.trim() || !turn.conversationId?.trim() || !turn.userMessageId?.trim() || !turn.turnId?.trim()) return false;
    if (!life || life.signal.aborted || this.state.lifecycleState === "off" || this.state.lifecycleState === "stopping" || turn.characterId !== this.activeCharacterId) return false;
    if (this.completedTurns.has(turn.turnId)) return false;
    if (this.pendingReactiveTurn && this.pendingReactiveTurn.turnId === turn.turnId) return false;
    if (this.pendingReactiveTurn && this.pendingReactiveTurn.turnId !== turn.turnId) this.failReactiveTurn(this.pendingReactiveTurn, "superseded");
    this.pendingReactiveTurn = {...turn};
    this.wake("user-message");
    return true;
  }
  updateSchedule(schedule: CognitiveScheduleSettings): void {
    this.scheduleSettings = normalizeSchedule(schedule);
    if (!this.lifeController || this.lifeController.signal.aborted || this.state.lifecycleState === "off" || this.state.lifecycleState === "stopping" || this.stepActive) return;
    const pendingReason = this.scheduler.scheduledReason ?? "scheduled";
    this.scheduler.cancel();
    this.scheduleNext(this.scheduleSettings.defaultIntervalMs, pendingReason);
  }

  private handleWake(reason: MindWakeReason): void {
    const life = this.lifeController;
    if (!life || life.signal.aborted || this.state.lifecycleState === "off" || this.state.lifecycleState === "stopping") return;
    if (this.stepActive) { this.pendingWakeReason = mergeWakeReason(this.pendingWakeReason, reason); return; }
    const minWait = this.lastRequestStartedAt === undefined ? 0 : Math.max(0, this.scheduleSettings.minIntervalMs - (this.now() - this.lastRequestStartedAt));
    const quotaWait = this.quotaWaitMs();
    const wait = Math.max(minWait, quotaWait);
    if (wait > 0) {
      this.onDiagnostic?.(quotaWait > minWait ? "COGNITIVE_QUOTA_DEFERRED" : "COGNITIVE_MIN_INTERVAL_ENFORCED", "Next request delayed by " + wait + " ms.");
      this.scheduleNext(wait, quotaWait > minWait ? "quota-available" : reason);
      return;
    }
    const task = this.runStep(reason);
    this.stepPromise = task;
    void task.finally(() => { if (this.stepPromise === task) this.stepPromise = undefined; }).catch(() => undefined);
  }

  private async runStep(reason: MindWakeReason): Promise<void> {
    const life = this.lifeController;
    const characterId = this.activeCharacterId;
    if (!life || life.signal.aborted || !characterId) return;
    this.stepActive = true;
    this.state.nextWakeAt = null;
    this.setLifecycleState("thinking");
    const contextVersion = this.contextVersion;
    const pending = this.pendingReactiveTurn;
    const reactiveTurn = reason === "user-message" && pending?.characterId === characterId ? {...pending} : undefined;
    const startedMs = this.now(), startedAt = this.clock(), runId = "nova-turn-" + startedMs + "-" + (++this.runSequence);
    this.lastRequestStartedAt = startedMs;
    this.requestStarts.push(startedMs);
    let nextDelay: number | undefined;
    let nextReason: MindWakeReason = "scheduled";
    let requestId: string | undefined, providerId: string | undefined, requested: number | undefined, applied: number | undefined, decision: string | undefined;
    let protocolDiagnostics: readonly string[] = [];
    let cancellation: CancellationKind | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finishTrace = (result: MindTraceEntry["result"], extra: Partial<MindTraceEntry> = {}) => {
      const entry: MindTraceEntry = {
        runId, characterId, wakeReason: reason, startedAt, finishedAt: this.clock(), durationMs: Math.max(0, this.now() - startedMs), result,
        ...(requested === undefined ? {} : {requestedNextWakeMs: requested}),
        ...(applied === undefined ? {} : {appliedIntervalMs: applied}),
        ...(decision === undefined ? {} : {intervalDecision: decision}),
        ...(requestId ? {requestId} : {}), ...(providerId ? {providerId} : {}),
        ...(protocolDiagnostics.length ? {protocolDiagnostics:[...protocolDiagnostics]} : {}), ...extra,
      };
      this.trace.push(entry);
      if (this.trace.length > MAX_TRACE_ENTRIES) this.trace.splice(0, this.trace.length - MAX_TRACE_ENTRIES);
      this.state.recentTrace = this.trace.map(item => ({...item}));
      this.notify();
    };
    const turnContext = (result?: CognitiveStepResult): import("../../contracts/src").MindTurnExecutionContext => ({
      characterId,
      conversationId: result?.conversationId ?? reactiveTurn?.conversationId ?? "",
      turnId: reactiveTurn?.turnId ?? runId,
      ...(reactiveTurn ? {userMessageId: reactiveTurn.userMessageId} : {}),
      ...(result?.requestId ? {requestId: result.requestId} : {}),
      ...(result?.providerId ? {providerId: result.providerId} : {}),
      ...(result?.model ? {model: result.model} : {}),
      ...(result?.providerPresetId ? {providerPresetId: result.providerPresetId} : {}),
      signal: this.stepController?.signal ?? life.signal,
    });
    try {
      const quotaWait = this.quotaWaitMs();
      if (!reactiveTurn && quotaWait > 0) {
        decision = "hourly-limit"; applied = quotaWait; nextDelay = quotaWait; nextReason = "quota-available";
        finishTrace("deferred"); return;
      }
      const stepController = new AbortController();
      this.stepController = stepController;
      this.cancelActiveStep = kind => { if (cancellation === undefined) { cancellation = kind; stepController.abort(); } };
      const onLifeAbort = () => this.cancelActiveStep?.("cancelled");
      life.signal.addEventListener("abort", onLifeAbort, {once:true});
      timeout = setTimeout(() => this.cancelActiveStep?.("timeout"), this.stepTimeoutMs);
      let result: CognitiveStepResult;
      try {
        const abortPromise = new Promise<never>((_, reject) => {
          const rejectAbort = () => {
            const error = cancellation === "timeout" ? new Error("Cognitive step timed out.") : abortError();
            if (cancellation === "timeout") error.name = "TimeoutError";
            reject(error);
          };
          if (stepController.signal.aborted) rejectAbort();
          else stepController.signal.addEventListener("abort", rejectAbort, {once:true});
        });
        result = await Promise.race([this.cognitiveStep.run({characterId, state:this.getState(), signal:stepController.signal, wakeReason:reason, ...(reactiveTurn ? {userTurn:reactiveTurn} : {})}), abortPromise]);
      } finally {
        life.signal.removeEventListener("abort", onLifeAbort);
      }
      requestId = result.requestId; providerId = result.providerId; protocolDiagnostics = result.protocolDiagnostics ?? [];
      if (cancellation === "superseded" || life.signal.aborted || contextVersion !== this.contextVersion || characterId !== this.activeCharacterId || (reactiveTurn && !this.isReactiveTurnCurrent(reactiveTurn))) {
        finishTrace("cancelled", {errorCode:"STALE_COGNITIVE_RESULT"}); return;
      }
      if (!result.turn || result.turn.version !== 1 || result.conversationId.trim() === "") throw new Error("Cognitive response is not a valid NovaTurn.");
      if (result.conversationId !== reactiveTurn?.conversationId && reactiveTurn) throw new Error("Reactive NovaTurn conversation scope mismatch.");
      const choice = chooseInterval(result.turn.nextWakeMs, this.scheduleSettings, protocolDiagnostics);
      requested = choice.requested; applied = choice.intervalMs; decision = choice.decision;
      if (decision !== "model" && decision !== "fixed-mode") this.onDiagnostic?.("NOVA_TURN_INTERVAL_CLAMPED", decision);
      let turn: NovaTurn = {...result.turn, toolResults:[...(result.turn.toolResults ?? [])]};
      if (turn.tools.length) {
        const context = turnContext(result);
        const toolResults = await Promise.all(turn.tools.map(async (call, index): Promise<NovaToolResult> => {
          const callId = context.turnId + ":tool:" + index + ":" + call.name;
          const cached = this.toolResultCache.get(callId);
          if (cached) return cached;
          if (stepController.signal.aborted || life.signal.aborted) throw abortError();
          let output: NovaToolResult;
          if (!this.toolExecutor) {
            output = {callId, name:call.name, status:"unknown-tool", error:"Tool execution is not configured."};
          } else {
            try { output = await this.toolExecutor.execute(call, {...context, callId, index}); }
            catch (error) { output = {callId, name:call.name, status:"error", error:error instanceof Error ? error.message.slice(0, MAX_TOOL_RESULT_CHARS) : "Tool execution failed."}; }
          }
          const normalized: NovaToolResult = {
            callId, name:call.name,
            status:output.status === "success" || output.status === "unknown-tool" ? output.status : "error",
            ...(output.output === undefined ? {} : {output:safeToolOutput(output.output)}),
            ...(typeof output.error === "string" ? {error:output.error.slice(0, MAX_TOOL_RESULT_CHARS)} : {}),
          };
          this.toolResultCache.set(callId, normalized);
          if (this.toolResultCache.size > 500) this.toolResultCache.delete(this.toolResultCache.keys().next().value!);
          return normalized;
        }));
        turn = {...turn, toolResults};
      }
      if (stepController.signal.aborted || life.signal.aborted || contextVersion !== this.contextVersion || (reactiveTurn && !this.isReactiveTurnCurrent(reactiveTurn))) {
        finishTrace("cancelled", {errorCode:"CANCELLED_BEFORE_COMMIT"}); return;
      }
      if (reactiveTurn && !turn.speech.trim()) {
        const error = new Error("Nova Life did not return the required public speech in NOVA_TURN v1.");
        error.name = "REACTIVE_SPEECH_REQUIRED";
        throw error;
      }
      const sink = this.turnSink;
      if (!sink) throw new Error("NovaTurn conversation sink is not attached.");
      await sink.commit(turn, turnContext(result));
      if (life.signal.aborted || contextVersion !== this.contextVersion || (reactiveTurn && !this.isReactiveTurnCurrent(reactiveTurn))) {
        finishTrace("cancelled", {errorCode:"STALE_AFTER_COMMIT"}); return;
      }
      if (reactiveTurn) {
        this.pendingReactiveTurn = undefined;
        this.completedTurns.add(reactiveTurn.turnId);
        if (this.completedTurns.size > 1_000) this.completedTurns.delete(this.completedTurns.values().next().value!);
      }
      this.consecutiveErrors = 0;
      nextDelay = applied;
      nextReason = "scheduled";
      if (turn.tools.length > 0) {
        this.pendingWakeReason = mergeWakeReason(this.pendingWakeReason, "tool-result");
        nextReason = "tool-result";
      }
      finishTrace("success", {protocolDiagnostics});
    } catch (error) {
      const stale = cancellation === "cancelled" || cancellation === "superseded" || life.signal.aborted || contextVersion !== this.contextVersion || characterId !== this.activeCharacterId;
      if (stale) {
        if (reactiveTurn && this.isReactiveTurnCurrent(reactiveTurn)) this.failReactiveTurn(reactiveTurn, cancellation === "superseded" ? "superseded" : "cancelled");
        finishTrace("cancelled", {errorCode:cancellation === "timeout" ? "STEP_TIMEOUT" : "CANCELLED"});
        return;
      }
      this.consecutiveErrors += 1;
      if (reactiveTurn) this.failReactiveTurn(reactiveTurn, error instanceof Error ? error.name : "COGNITIVE_STEP_FAILED");
      applied = this.errorBackoffMs(); decision = "error-backoff"; nextDelay = applied; nextReason = "error-backoff";
      const errorCode = cancellation === "timeout" ? "STEP_TIMEOUT" : error instanceof Error ? error.name : "COGNITIVE_STEP_FAILED";
      this.safeOnError(error);
      finishTrace("error", {errorCode});
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.stepController = undefined; this.cancelActiveStep = undefined; this.stepActive = false;
      const lifeNow = this.lifeController;
      if (lifeNow && !lifeNow.signal.aborted && this.state.lifecycleState !== "stopping") {
        const pending = this.pendingWakeReason;
        if (pending) { this.pendingWakeReason = undefined; this.scheduler.wake(pending); }
        else if (nextDelay !== undefined) this.scheduleNext(nextDelay, nextReason);
      }
    }
  }

  private isReactiveTurnCurrent(turn: MindReactiveTurn): boolean {
    const pending = this.pendingReactiveTurn;
    return Boolean(pending && pending.characterId === turn.characterId && pending.conversationId === turn.conversationId &&
      pending.userMessageId === turn.userMessageId && pending.turnId === turn.turnId && this.activeCharacterId === turn.characterId);
  }
  private failReactiveTurn(turn: MindReactiveTurn, reason: string): void {
    if (!this.isReactiveTurnCurrent(turn)) return;
    this.pendingReactiveTurn = undefined;
    try { this.turnSink?.fail?.(turn, reason); } catch { /* UI failure observers cannot disrupt cognition. */ }
  }
  private quotaWaitMs(): number {
    const limit = this.scheduleSettings.maxRequestsPerHour;
    if (limit === null) return 0;
    const now = this.now();
    while (this.requestStarts.length && now - this.requestStarts[0]! >= HOUR_MS) this.requestStarts.shift();
    if (this.requestStarts.length < limit) return 0;
    return Math.max(1, this.requestStarts[0]! + HOUR_MS - now);
  }
  private errorBackoffMs(): number {
    const exponent = Math.min(20, Math.max(0, this.consecutiveErrors - 1));
    const proposed = this.scheduleSettings.defaultIntervalMs * Math.pow(2, exponent);
    return Math.min(this.scheduleSettings.maxIntervalMs, Math.max(this.scheduleSettings.minIntervalMs, proposed));
  }
  private scheduleNext(delayMs: number, reason: MindWakeReason): void {
    const life = this.lifeController;
    if (!life || life.signal.aborted || this.state.lifecycleState === "off" || this.state.lifecycleState === "stopping") return;
    const wait = Math.max(1, Math.floor(delayMs));
    const deadline = this.scheduler.schedule(wait, reason);
    this.state.nextWakeAt = new Date(deadline).toISOString();
    this.setLifecycleState("waiting");
  }
  private safeOnError(error: unknown): void { try { this.onError?.(error); } catch { /* diagnostics must not stop Life */ } }
  private setLifecycleState(lifecycleState: MindRuntimeLifecycleState): void { this.state.lifecycleState = lifecycleState; this.notify(); }
  private notify(): void { const snapshot = this.getState(); for (const listener of [...this.listeners]) { try { listener(snapshot); } catch { /* observers cannot affect runtime */ } } }
}
