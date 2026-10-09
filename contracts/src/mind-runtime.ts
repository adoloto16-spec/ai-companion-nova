export type ThoughtId=string;
export type ThoughtExpression="internal"|"external_candidate";
export type MindExpressionKind="internal"|"chat";
export type MindExpressionStatus="internal"|"published"|"suppressed"|"invalid"|"failed";
export type MindExpressionSuppressionReason="user-message-wake"|"life-start-wake"|"character-change-wake"|"not-scheduled-wake"|"disabled"|"cooldown"|"hourly-limit"|"stale-context"|"wrong-conversation"|"chat-busy"|"publisher-unavailable"|"invalid-expression"|"cancelled"|"publication-failed";
export type MindExpressionCandidate={kind:"internal"}|{kind:"chat";content:string};
export interface MindReactiveTurn{characterId:string;conversationId:string;userMessageId:string;turnId:string;}
export interface MindExpressionPublication{
  characterId:string;conversationId:string;expressionId:string;content:string;signal?:AbortSignal;
  intent?:"reactive"|"proactive";userMessageId?:string;turnId?:string;
  model?:string;providerId?:string;providerPresetId?:string;
}
export type MindExpressionPublishResult=
  | {status:"published";messageId:string;conversationId:string}
  | {status:"suppressed";reason:MindExpressionSuppressionReason}
  | {status:"failed";reason:MindExpressionSuppressionReason;errorCode?:string};
export interface MindExpressionPublisher{
  publish(expression:MindExpressionPublication):Promise<MindExpressionPublishResult>;
  failReactiveTurn?(turn:MindReactiveTurn,reason:string):void;
}
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
  expressionRequired?:boolean;
  expressionUserMessageId?:string;}

export interface Thought{
  characterId:string;
  id:ThoughtId;
  timestamp:string;
  content:string;
  expression:ThoughtExpression;
}

export type MindInitiativeDecision="continue"|"switch"|"pause"|"finish";
export type MindInitiativeStatus="active"|"paused"|"completed";
export interface MindInitiativeState{status:MindInitiativeStatus;direction:string|null;lastProgress:string|null;}
export interface MindInitiativeUpdate{decision:MindInitiativeDecision;focus?:string;direction?:string;progress?:string;}

/** Validate the compact model-authored initiative update; malformed optional updates are ignored. */
export function validateMindInitiativeUpdate(value:unknown):MindInitiativeUpdate|undefined{
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
  const record=value as Record<string,unknown>;
  const keys=Object.keys(record),allowed=new Set(["decision","focus","direction","progress"]);
  if(keys.some(key=>!allowed.has(key)))return undefined;
  const decision=record.decision;
  if(decision!=="continue"&&decision!=="switch"&&decision!=="pause"&&decision!=="finish")return undefined;
  const hasFocus=Object.prototype.hasOwnProperty.call(record,"focus");
  let valid=true;
  const readText=(key:string,maxLength:number):string|undefined=>{
    if(!Object.prototype.hasOwnProperty.call(record,key))return undefined;
    const raw=record[key];
    if(typeof raw!=="string"){valid=false;return undefined;}
    const text=raw.trim();
    if(!text||text.length>maxLength){valid=false;return undefined;}
    return text;
  };
  const focus=readText("focus",160);
  const direction=readText("direction",280);
  const progress=readText("progress",1000);
  if(!valid||(decision==="switch"&&!focus)||(decision!=="switch"&&hasFocus))return undefined;
  return {decision,...(focus?{focus}:{}),...(direction?{direction}:{}),...(progress?{progress}:{})};
}

export interface MindState{
  focus:string|null;
  initiative:MindInitiativeState|null;
  lastThought:Thought|null;
  lastThoughtAt:string|null;
  recentThoughts:readonly Thought[];
  lifecycleState:MindRuntimeLifecycleState;
  nextWakeAt?:string|null;
  recentTrace?:readonly MindTraceEntry[];
}
