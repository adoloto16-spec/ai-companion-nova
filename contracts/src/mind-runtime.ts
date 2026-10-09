export type ThoughtId=string;
export type ThoughtExpression="internal"|"external_candidate";
export type MindExpressionKind="internal"|"chat";
export type MindExpressionStatus="internal"|"published"|"suppressed"|"invalid"|"failed";
export type MindExpressionSuppressionReason="user-message-wake"|"life-start-wake"|"character-change-wake"|"not-scheduled-wake"|"disabled"|"cooldown"|"hourly-limit"|"stale-context"|"wrong-conversation"|"chat-busy"|"publisher-unavailable"|"invalid-expression"|"cancelled"|"publication-failed";
export type MindExpressionCandidate={kind:"internal"}|{kind:"chat";content:string};
export interface MindExpressionPublication{characterId:string;conversationId:string;expressionId:string;content:string;signal?:AbortSignal;}
export type MindExpressionPublishResult=
  | {status:"published";messageId:string;conversationId:string}
  | {status:"suppressed";reason:MindExpressionSuppressionReason}
  | {status:"failed";reason:MindExpressionSuppressionReason;errorCode?:string};
export interface MindExpressionPublisher{publish(expression:MindExpressionPublication):Promise<MindExpressionPublishResult>;}
export type MindRuntimeLifecycleState="off"|"starting"|"thinking"|"waiting"|"stopping"|"error";
export type MindWakeReason="life-start"|"scheduled"|"user-message"|"character-change"|"quota-available"|"error-backoff";
export type MindTraceResult="success"|"error"|"cancelled"|"deferred";
export interface MindTraceEntry{
  runId:string;
  characterId:string;
  wakeReason:MindWakeReason;
  startedAt:string;
  finishedAt:string;
  durationMs:number;
  result:MindTraceResult;
  requestedNextWakeInMs?:number;
  appliedIntervalMs?:number;
  intervalDecision?:string;
  errorCode?:string;
  requestId?:string;
  providerId?:string;
  expressionKind?:MindExpressionKind;
  expressionStatus?:MindExpressionStatus;
  expressionSuppressionReason?:MindExpressionSuppressionReason;
  expressionId?:string;
  expressionConversationId?:string;
  expressionMessageId?:string;
  expressionErrorCode?:string;
}

export interface Thought{
  characterId:string;
  id:ThoughtId;
  timestamp:string;
  content:string;
  expression:ThoughtExpression;
}

export interface MindState{
  focus:string|null;
  lastThought:Thought|null;
  lastThoughtAt:string|null;
  recentThoughts:readonly Thought[];
  lifecycleState:MindRuntimeLifecycleState;
  nextWakeAt?:string|null;
  recentTrace?:readonly MindTraceEntry[];
}
