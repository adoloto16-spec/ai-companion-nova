export type ThoughtId=string;
export type ThoughtExpression="internal"|"external_candidate";
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
