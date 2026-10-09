import type {CognitiveScheduleSettings,MindExpressionCandidate,MindExpressionPublishResult,MindExpressionPublisher,MindExpressionSuppressionReason,MindInitiativeState,MindInitiativeUpdate,MindReactiveTurn,MindRuntimeLifecycleState,MindState,MindTraceEntry,MindWakeReason,Thought,Unsubscribe} from "../../contracts/src";
import {DEFAULT_COGNITIVE_SCHEDULE,DEFAULT_PROACTIVE_CHAT,validateMindInitiativeUpdate} from "../../contracts/src";
import type {ProactiveChatSettings} from "../../contracts/src";
import {MindScheduler} from "./mind-scheduler";

const DEFAULT_RECENT_THOUGHTS=50;
const DEFAULT_STEP_TIMEOUT_MS=60_000;
const MAX_THOUGHT_CHARS=8_000;
const MAX_TRACE_ENTRIES=100;
const HOUR_MS=3_600_000;
const defaultNow=()=>Date.now();
const sharedProactivePublicationTimes:number[]=[];

export interface CognitiveStepContext{characterId:string;state:Readonly<MindState>;signal:AbortSignal;wakeReason:MindWakeReason;userTurn?:MindReactiveTurn;}
export interface CognitiveStepResult{thought:Thought;nextWakeInMs?:unknown;requestId?:string;providerId?:string;model?:string;providerPresetId?:string;expression?:MindExpressionCandidate;expressionInvalid?:boolean;initiative?:MindInitiativeUpdate;conversationId?:string;}
export interface CognitiveStep{run(context:CognitiveStepContext):Promise<Thought|CognitiveStepResult>;}
export interface MindRuntimeOptions{
  cognitiveStep:CognitiveStep;
  schedule?:CognitiveScheduleSettings;
  /** Legacy test/consumer option. When provided without schedule it selects fixed cadence. */
  stepIntervalMs?:number;
  stepTimeoutMs?:number;
  recentThoughtLimit?:number;
  initialFocus?:string|null;
  onError?:(error:unknown)=>void;
  clock?:()=>string;
  now?:()=>number;
  proactiveChat?:ProactiveChatSettings;
  expressionPublisher?:MindExpressionPublisher;
  isExpressionContextCurrent?:(characterId:string,conversationId:string)=>Promise<boolean>|boolean;
  onExpressionError?:(error:unknown)=>void;
}

interface CharacterMindState{focus:string|null;initiative:MindInitiativeState|null;lastThought:Thought|null;lastThoughtAt:string|null;recentThoughts:Thought[];}
type CancellationKind="cancelled"|"superseded"|"timeout";
interface IntervalChoice{intervalMs:number;requested?:number;decision:string;}
function abortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(abortError());
  return new Promise<T>((resolve,reject)=>{
    const onAbort=()=>{signal.removeEventListener("abort",onAbort);reject(abortError());};
    signal.addEventListener("abort",onAbort,{once:true});
    promise.then(value=>{signal.removeEventListener("abort",onAbort);resolve(value);},error=>{signal.removeEventListener("abort",onAbort);reject(error);});
  });
}
function cloneState(state:MindState):MindState{
  return {...state,initiative:state.initiative?{...state.initiative}:null,recentThoughts:[...state.recentThoughts],nextWakeAt:state.nextWakeAt??null,recentTrace:(state.recentTrace??[]).map(entry=>({...entry}))};
}
function createCharacterMindState(focus:string|null=null):CharacterMindState{return {focus,initiative:null,lastThought:null,lastThoughtAt:null,recentThoughts:[]};}
function normalizeSchedule(schedule:CognitiveScheduleSettings):CognitiveScheduleSettings{
  const upper=3_600_000;
  const validInt=(value:unknown,fallback:number,min=1,max=upper)=>typeof value==="number"&&Number.isFinite(value)&&Number.isInteger(value)?Math.min(max,Math.max(min,value)):fallback;
  const minIntervalMs=validInt(schedule?.minIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.minIntervalMs);
  const maxIntervalMs=Math.max(minIntervalMs,validInt(schedule?.maxIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.maxIntervalMs));
  const defaultIntervalMs=Math.min(maxIntervalMs,Math.max(minIntervalMs,validInt(schedule?.defaultIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.defaultIntervalMs)));
  const maxRequestsPerHour=validInt(schedule?.maxRequestsPerHour,DEFAULT_COGNITIVE_SCHEDULE.maxRequestsPerHour,1,3600);
  return {mode:schedule?.mode==="fixed"?"fixed":"adaptive",defaultIntervalMs,minIntervalMs,maxIntervalMs,maxRequestsPerHour};
}
function extractResult(value:Thought|CognitiveStepResult):CognitiveStepResult{
  if(value&&typeof value==="object"&&"thought" in value)return value as CognitiveStepResult;
  return {thought:value as Thought};
}
function normalizeProactiveChat(settings:ProactiveChatSettings|undefined):ProactiveChatSettings{
  const integer=(value:unknown,fallback:number,min:number,max:number)=>typeof value==="number"&&Number.isSafeInteger(value)?Math.max(min,Math.min(max,value)):fallback;
  return {
    enabled:typeof settings?.enabled==="boolean"?settings.enabled:DEFAULT_PROACTIVE_CHAT.enabled,
    minMessageIntervalMs:integer(settings?.minMessageIntervalMs,DEFAULT_PROACTIVE_CHAT.minMessageIntervalMs,10_000,3_600_000),
    maxMessagesPerHour:integer(settings?.maxMessagesPerHour,DEFAULT_PROACTIVE_CHAT.maxMessagesPerHour,1,3600)
  };
}
function chooseInterval(raw:unknown,settings:CognitiveScheduleSettings):IntervalChoice{
  if(settings.mode==="fixed")return {intervalMs:settings.defaultIntervalMs,decision:"fixed-mode"};
  if(typeof raw!=="number"||!Number.isFinite(raw)||!Number.isInteger(raw)||!Number.isSafeInteger(raw)){
    return {intervalMs:settings.defaultIntervalMs,decision:raw===undefined?"missing-interval-default":"invalid-interval-default"};
  }
  if(raw<settings.minIntervalMs)return {intervalMs:settings.minIntervalMs,requested:raw,decision:"below-minimum-clamped"};
  if(raw>settings.maxIntervalMs)return {intervalMs:settings.maxIntervalMs,requested:raw,decision:"above-maximum-clamped"};
  return {intervalMs:raw,requested:raw,decision:"model"};
}
function mergeWakeReason(current:MindWakeReason|undefined,next:MindWakeReason):MindWakeReason{
  if(!current)return next;
  if(current==="character-change"||next==="character-change")return "character-change";
  if(current==="user-message"||next==="user-message")return "user-message";
  return current;
}

export class MindRuntime{
  private readonly cognitiveStep:CognitiveStep;
  private readonly recentThoughtLimit:number;
  private readonly stepTimeoutMs:number;
  private readonly onError?:MindRuntimeOptions["onError"];
  private readonly initialFocus:string|null;
  private readonly clock:()=>string;
  private readonly now:()=>number;
  private scheduleSettings:CognitiveScheduleSettings;
  private proactiveChatSettings:ProactiveChatSettings;
  private expressionPublisher:MindExpressionPublisher|undefined;
  private readonly isExpressionContextCurrent:((characterId:string,conversationId:string)=>Promise<boolean>|boolean)|undefined;
  private readonly onExpressionError:((error:unknown)=>void)|undefined;
  private readonly expressionPublicationTimes:number[];
  private readonly state:MindState;
  private readonly characterStates=new Map<string,CharacterMindState>();
  private readonly listeners=new Set<(state:MindState)=>void>();
  private readonly thoughtListeners=new Set<(thought:Thought)=>void>();
  private readonly trace:MindTraceEntry[]=[];
  private readonly requestStarts:number[]=[];
  private readonly scheduler:MindScheduler;
  private activeCharacterId:string|undefined;
  private lifeController:AbortController|undefined;
  private stepController:AbortController|undefined;
  private cancelActiveStep:((kind:CancellationKind)=>void)|undefined;
  private stepPromise:Promise<void>|undefined;
  private stepActive=false;
  private pendingWakeReason:MindWakeReason|undefined;
  private pendingReactiveTurn:MindReactiveTurn|undefined;
  private contextVersion=0;
  private runSequence=0;
  private consecutiveErrors=0;

  constructor(options:MindRuntimeOptions){
    if(options.stepIntervalMs!==undefined&&(!Number.isInteger(options.stepIntervalMs)||options.stepIntervalMs<1))throw new Error("Mind Runtime step interval must be a positive integer.");
    if(options.stepTimeoutMs!==undefined&&(!Number.isInteger(options.stepTimeoutMs)||options.stepTimeoutMs<1))throw new Error("Mind Runtime step timeout must be a positive integer.");
    if(options.recentThoughtLimit!==undefined&&(!Number.isInteger(options.recentThoughtLimit)||options.recentThoughtLimit<1))throw new Error("Mind Runtime recent thought limit must be a positive integer.");
    this.cognitiveStep=options.cognitiveStep;
    const legacy=options.schedule===undefined&&options.stepIntervalMs!==undefined;
    const interval=options.stepIntervalMs??DEFAULT_COGNITIVE_SCHEDULE.defaultIntervalMs;
    this.scheduleSettings=normalizeSchedule(options.schedule??(legacy?{mode:"fixed",defaultIntervalMs:interval,minIntervalMs:interval,maxIntervalMs:interval,maxRequestsPerHour:3600}:DEFAULT_COGNITIVE_SCHEDULE));
    this.recentThoughtLimit=options.recentThoughtLimit??DEFAULT_RECENT_THOUGHTS;
    this.stepTimeoutMs=options.stepTimeoutMs??DEFAULT_STEP_TIMEOUT_MS;
    this.onError=options.onError;
    this.proactiveChatSettings=normalizeProactiveChat(options.proactiveChat);
    this.expressionPublisher=options.expressionPublisher;
    this.isExpressionContextCurrent=options.isExpressionContextCurrent;
    this.onExpressionError=options.onExpressionError;
    this.initialFocus=options.initialFocus??null;
    this.clock=options.clock??(()=>new Date().toISOString());
    this.now=options.now??defaultNow;
    this.expressionPublicationTimes=options.now?[]:sharedProactivePublicationTimes;
    this.state={focus:this.initialFocus,initiative:null,lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"off",nextWakeAt:null,recentTrace:[]};
    this.scheduler=new MindScheduler(reason=>this.handleWake(reason),this.now);
  }

  getState():MindState{return cloneState(this.state);}
  subscribe(listener:(state:MindState)=>void):Unsubscribe{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)};}
  subscribeThoughts(listener:(thought:Thought)=>void):Unsubscribe{this.thoughtListeners.add(listener);return ()=>{this.thoughtListeners.delete(listener)};}

  setActiveCharacter(characterId:string):void{
    const normalized=characterId.trim();
    if(!normalized)throw new Error("Mind Runtime active character id must not be empty.");
    if(normalized===this.activeCharacterId)return;
    if(this.pendingReactiveTurn)this.failReactiveTurn(this.pendingReactiveTurn,"character-change");
    this.activeCharacterId=normalized;this.contextVersion+=1;
    if(!this.characterStates.has(normalized))this.characterStates.set(normalized,createCharacterMindState(this.characterStates.size===0?this.initialFocus:null));
    this.syncActiveState();this.notify();
    if(this.lifeController&&!this.lifeController.signal.aborted)this.wake("character-change");
  }

  async start():Promise<void>{
    if(this.state.lifecycleState!=="off")throw new Error("Mind Runtime cannot start from state "+this.state.lifecycleState+".");
    if(!this.activeCharacterId)throw new Error("Mind Runtime cannot start without an active character.");
    const controller=new AbortController();this.lifeController=controller;
    this.pendingWakeReason=undefined;this.consecutiveErrors=0;
    this.scheduler.cancel();this.state.nextWakeAt=null;
    this.setLifecycleState("starting");
    this.scheduler.wake("life-start");
  }

  async stop():Promise<void>{
    if(this.state.lifecycleState==="off"&&!this.lifeController)return;
    this.scheduler.cancel();this.state.nextWakeAt=null;this.pendingWakeReason=undefined;
    if(this.pendingReactiveTurn)this.failReactiveTurn(this.pendingReactiveTurn,"cancelled");
    this.setLifecycleState("stopping");
    const controller=this.lifeController;
    controller?.abort();
    this.cancelActiveStep?.("cancelled");
    const running=this.stepPromise;
    if(running)await running;
    this.lifeController=undefined;this.stepController=undefined;this.cancelActiveStep=undefined;this.stepPromise=undefined;
    this.stepActive=false;this.state.nextWakeAt=null;
    this.setLifecycleState("off");
  }

  wake(reason:MindWakeReason="user-message"):void{
    const life=this.lifeController;
    if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    this.scheduler.cancel();this.state.nextWakeAt=null;
    if(this.stepActive){
      this.pendingWakeReason=mergeWakeReason(this.pendingWakeReason,reason);
      this.cancelActiveStep?.("superseded");
      this.notify();return;
    }
    this.scheduler.wake(reason);
  }

  wakeForUserMessage(turn:MindReactiveTurn):boolean{
    const life=this.lifeController;
    if(!turn||!turn.characterId?.trim()||!turn.conversationId?.trim()||!turn.userMessageId?.trim()||!turn.turnId?.trim())return false;
    if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping"||turn.characterId!==this.activeCharacterId)return false;
    if(this.pendingReactiveTurn&&this.pendingReactiveTurn.turnId!==turn.turnId)this.failReactiveTurn(this.pendingReactiveTurn,"superseded");
    this.pendingReactiveTurn={characterId:turn.characterId,conversationId:turn.conversationId,userMessageId:turn.userMessageId,turnId:turn.turnId};
    this.wake("user-message");
    return true;
  }

  updateSchedule(schedule:CognitiveScheduleSettings):void{
    this.scheduleSettings=normalizeSchedule(schedule);
    if(!this.lifeController||this.lifeController.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping"||this.stepActive)return;
    const priorReason=this.scheduler.scheduledReason??"scheduled";
    this.scheduler.cancel();this.scheduleNext(this.scheduleSettings.defaultIntervalMs,priorReason);
  }
  updateProactiveChat(settings:ProactiveChatSettings):void{this.proactiveChatSettings=normalizeProactiveChat(settings);}
  setExpressionPublisher(publisher:MindExpressionPublisher|undefined):void{this.expressionPublisher=publisher;}

  deleteThought(thoughtId:string):boolean{
    const id=thoughtId.trim();if(!id||!this.activeCharacterId)return false;
    const characterState=this.characterStates.get(this.activeCharacterId);if(!characterState)return false;
    const index=characterState.recentThoughts.findIndex(thought=>thought.id===id);if(index<0)return false;
    characterState.recentThoughts.splice(index,1);
    if(characterState.lastThought?.id===id){const next=characterState.recentThoughts[characterState.recentThoughts.length-1]??null;characterState.lastThought=next;characterState.lastThoughtAt=next?.timestamp??null;}
    this.syncActiveState();this.notify();return true;
  }
  clearCurrentThoughts():void{
    if(!this.activeCharacterId)return;const characterState=this.characterStates.get(this.activeCharacterId);if(!characterState)return;
    characterState.lastThought=null;characterState.lastThoughtAt=null;characterState.recentThoughts=[];this.syncActiveState();this.notify();
  }
  clearAllThoughts():void{
    for(const characterState of this.characterStates.values()){characterState.lastThought=null;characterState.lastThoughtAt=null;characterState.recentThoughts=[];}
    this.syncActiveState();this.notify();
  }

  private handleWake(reason:MindWakeReason):void{
    const life=this.lifeController;
    if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    if(this.stepActive){this.pendingWakeReason=mergeWakeReason(this.pendingWakeReason,reason);return;}
    const task=this.runStep(reason);this.stepPromise=task;
    void task.finally(()=>{if(this.stepPromise===task)this.stepPromise=undefined;}).catch(()=>undefined);
  }

  private async runStep(reason:MindWakeReason):Promise<void>{
    const life=this.lifeController;if(!life||life.signal.aborted||!this.activeCharacterId)return;
    this.stepActive=true;this.state.nextWakeAt=null;this.setLifecycleState("thinking");
    const characterId=this.activeCharacterId,contextVersion=this.contextVersion;
    const pending=this.pendingReactiveTurn;
    const reactiveTurn=reason==="user-message"&&pending?.characterId===characterId
      ?{characterId:pending.characterId,conversationId:pending.conversationId,userMessageId:pending.userMessageId,turnId:pending.turnId}
      :undefined;
    const startedMs=this.now(),startedAt=this.clock(),runId="mind-run-"+startedMs+"-"+(++this.runSequence);
    let nextDelay:number|undefined, nextReason:MindWakeReason="scheduled";
    let requestId:string|undefined,providerId:string|undefined,requested:number|undefined,applied:number|undefined,decision:string|undefined;
    let expressionTrace:Partial<MindTraceEntry>={};
    let cancellation:CancellationKind|undefined;
    let stepController:AbortController|undefined;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const finishTrace=(result:MindTraceEntry["result"],extra:Partial<MindTraceEntry>={})=>{
      const finishedAt=this.clock(),durationMs=Math.max(0,this.now()-startedMs);
      this.trace.push({runId,characterId,wakeReason:reason,startedAt,finishedAt,durationMs,result,...(requested===undefined?{}:{requestedNextWakeInMs:requested}),...(applied===undefined?{}:{appliedIntervalMs:applied}),...(decision===undefined?{}:{intervalDecision:decision}),...(requestId?{requestId}:{}),...(providerId?{providerId}:{}),...expressionTrace,...extra});
      if(this.trace.length>MAX_TRACE_ENTRIES)this.trace.splice(0,this.trace.length-MAX_TRACE_ENTRIES);
      this.state.recentTrace=this.trace.map(entry=>({...entry}));this.notify();
    };
    try{
      const quotaWait=reactiveTurn?0:this.quotaWaitMs();
      if(quotaWait>0){
        applied=quotaWait;decision="hourly-limit";nextDelay=quotaWait;nextReason="quota-available";
        finishTrace("deferred");return;
      }
      // Reactive replies are user-triggered and do not consume background cognition quota.
      if(!reactiveTurn)this.requestStarts.push(this.now());
      stepController=new AbortController();this.stepController=stepController;
      const cancel=(kind:CancellationKind)=>{
        if(cancellation!==undefined||!stepController)return;
        cancellation=kind;stepController.abort();
      };
      this.cancelActiveStep=cancel;
      const onLifeAbort=()=>cancel("cancelled");
      life.signal.addEventListener("abort",onLifeAbort,{once:true});
      timeout=setTimeout(()=>cancel("timeout"),this.stepTimeoutMs);
      const rawPromise=this.cognitiveStep.run({characterId,state:this.getState(),signal:stepController.signal,wakeReason:reason,...(reactiveTurn?{userTurn:reactiveTurn}:{})});
      const abortPromise=new Promise<never>((_,reject)=>{
        const rejectAbort=()=>{
          if(cancellation==="timeout"){const error=new Error("Cognitive step timed out.");error.name="TimeoutError";reject(error);}
          else reject(abortError());
        };
        if(stepController!.signal.aborted)rejectAbort();
        else stepController!.signal.addEventListener("abort",rejectAbort,{once:true});
      });
      let raw:Thought|CognitiveStepResult;
      try{raw=await Promise.race([rawPromise,abortPromise]);}
      finally{life.signal.removeEventListener("abort",onLifeAbort);}
      const result=extractResult(raw);
      requestId=result.requestId;providerId=result.providerId;
      if(cancellation==="superseded"||life.signal.aborted||contextVersion!==this.contextVersion||characterId!==this.activeCharacterId||(reactiveTurn&&!this.isReactiveTurnCurrent(reactiveTurn))){
        finishTrace("cancelled",{intervalDecision:"stale-context",...(reactiveTurn?{expressionRequired:true,expressionUserMessageId:reactiveTurn.userMessageId}:{})});return;
      }
      const thought=result.thought;
      if(!thought||typeof thought!=="object"||thought.characterId!==characterId)throw new Error("Cognitive Thought character scope mismatch.");
      if(typeof thought.content!=="string"||!thought.content.trim()||thought.content.length>MAX_THOUGHT_CHARS)throw new Error("Cognitive Thought content is empty or exceeds the allowed length.");
      const choice=chooseInterval(result.nextWakeInMs,this.scheduleSettings);
      requested=choice.requested;applied=choice.intervalMs;decision=choice.decision;
      if(stepController.signal.aborted||life.signal.aborted||contextVersion!==this.contextVersion||(reactiveTurn&&!this.isReactiveTurnCurrent(reactiveTurn))){
        finishTrace("cancelled",{intervalDecision:"cancelled-before-apply",...(reactiveTurn?{expressionRequired:true,expressionUserMessageId:reactiveTurn.userMessageId}:{})});return;
      }
      if(reactiveTurn&&(!result.expression||result.expression.kind!=="chat"||result.expressionInvalid)){
        expressionTrace={expressionKind:result.expression?.kind==="internal"?"internal":"chat",expressionStatus:result.expressionInvalid?"invalid":"failed",
          expressionSuppressionReason:"invalid-expression",expressionId:"nova-life-expression:"+runId,expressionRequired:true,
          expressionUserMessageId:reactiveTurn.userMessageId,expressionConversationId:reactiveTurn.conversationId};
        const error=new Error("Nova Life cognition did not return the required public reply.");
        error.name="REACTIVE_EXPRESSION_REQUIRED";
        throw error;
      }
      // Do not commit a Thought from a malformed response that failed the required reactive output contract.
      this.applyInitiative(characterId,result.initiative);
      this.applyThought(thought);
      if(result.expressionInvalid){
        expressionTrace={expressionKind:"chat",expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression",expressionId:"nova-life-expression:"+runId};
      }else if(!result.expression||result.expression.kind==="internal"){
        expressionTrace={expressionKind:"internal",expressionStatus:"internal"};
      }else if(result.expression.kind==="chat"){
        expressionTrace=await this.attemptExpression({
          characterId,conversationId:result.conversationId??reactiveTurn?.conversationId,content:result.expression.content,
          expressionId:"nova-life-expression:"+runId,reason,contextVersion,stepController,life,userTurn:reactiveTurn,
          model:result.model,providerId:result.providerId,providerPresetId:result.providerPresetId,
          isCancelled:()=>cancellation!==undefined
        });
        if(reactiveTurn){
          if(expressionTrace.expressionStatus==="published")this.completeReactiveTurn(reactiveTurn);
          else this.failReactiveTurn(reactiveTurn,expressionTrace.expressionSuppressionReason??"publication-failed");
        }
      }else{
        expressionTrace={expressionKind:"chat",expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression",expressionId:"nova-life-expression:"+runId,...(reactiveTurn?{expressionRequired:true,expressionUserMessageId:reactiveTurn.userMessageId}:{})};
        if(reactiveTurn)this.failReactiveTurn(reactiveTurn,"invalid-expression");
      }
      this.consecutiveErrors=0;nextDelay=applied;nextReason="scheduled";
      finishTrace("success",{...expressionTrace,...(reactiveTurn?{expressionRequired:true,expressionUserMessageId:reactiveTurn.userMessageId}:{})});
    }catch(error){
      if(cancellation==="cancelled"||cancellation==="superseded"||life.signal.aborted||contextVersion!==this.contextVersion||characterId!==this.activeCharacterId||(reactiveTurn&&!this.isReactiveTurnCurrent(reactiveTurn))){
        if(reactiveTurn)this.failReactiveTurn(reactiveTurn,cancellation==="superseded"?"superseded":"cancelled");
        finishTrace("cancelled",{intervalDecision:cancellation==="superseded"?"superseded-by-new-context":"cancelled",...(reactiveTurn?{expressionRequired:true,expressionUserMessageId:reactiveTurn.userMessageId}:{})});return;
      }
      this.consecutiveErrors+=1;
      if(reactiveTurn)this.failReactiveTurn(reactiveTurn,error instanceof Error?error.name:"COGNITIVE_STEP_FAILED");
      applied=this.errorBackoffMs();decision="error-backoff";nextDelay=applied;nextReason="error-backoff";
      const errorCode=cancellation==="timeout"?"STEP_TIMEOUT":error instanceof Error?error.name:"COGNITIVE_STEP_FAILED";
      this.safeOnError(error);
      finishTrace("error",{
        ...expressionTrace,
        ...(reactiveTurn?{
          expressionKind:expressionTrace?.expressionKind??"chat",
          expressionStatus:expressionTrace?.expressionStatus??"failed",
          expressionRequired:true,
          expressionUserMessageId:reactiveTurn.userMessageId,
          expressionConversationId:reactiveTurn.conversationId
        }:{}),
        errorCode,intervalDecision:decision
      });
    }finally{
      if(timeout!==undefined)clearTimeout(timeout);
      this.stepController=undefined;this.cancelActiveStep=undefined;this.stepActive=false;
      const lifeNow=this.lifeController;
      if(lifeNow&&!lifeNow.signal.aborted&&this.state.lifecycleState!=="stopping"){
        const pending=this.pendingWakeReason;
        if(pending){this.pendingWakeReason=undefined;this.scheduler.wake(pending);}
        else if(nextDelay!==undefined)this.scheduleNext(nextDelay,nextReason);
      }
    }
  }

  private async attemptExpression(input:{
    characterId:string;
    conversationId?:string;
    content:string;
    expressionId:string;
    reason:MindWakeReason;
    contextVersion:number;
    stepController:AbortController;
    life:AbortController;
    userTurn?:MindReactiveTurn;
    model?:string;
    providerId?:string;
    providerPresetId?:string;
    isCancelled:()=>boolean;
  }):Promise<Partial<MindTraceEntry>>{
    const userTurn=input.userTurn;
    const reactive=Boolean(userTurn);
    const conversationId=input.conversationId;
    const base:Partial<MindTraceEntry>={expressionKind:"chat",expressionId:input.expressionId,...(conversationId?{expressionConversationId:conversationId}:{}),...(userTurn?{expressionRequired:true,expressionUserMessageId:userTurn.userMessageId,expressionConversationId:userTurn.conversationId}:{})};
    const suppressed=(reason:MindExpressionSuppressionReason):Partial<MindTraceEntry>=>({...base,expressionStatus:"suppressed",expressionSuppressionReason:reason});
    const failed=(reason:MindExpressionSuppressionReason,errorCode?:string):Partial<MindTraceEntry>=>({...base,expressionStatus:"failed",expressionSuppressionReason:reason,...(errorCode?{expressionErrorCode:errorCode}:{})});
    if(!reactive&&input.reason!=="scheduled"){
      const reason:MindExpressionSuppressionReason=input.reason==="user-message"?"user-message-wake":input.reason==="life-start"?"life-start-wake":input.reason==="character-change"?"character-change-wake":"not-scheduled-wake";
      return suppressed(reason);
    }
    if(!reactive&&!this.proactiveChatSettings.enabled)return suppressed("disabled");
    if(typeof input.content!=="string"||!input.content.trim()||input.content.length>2000)return {...base,expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression"};
    if(!conversationId?.trim())return suppressed("wrong-conversation");
    if(!this.expressionPublisher)return suppressed("publisher-unavailable");
    const current=()=>{
      if(input.life.signal.aborted||this.lifeController!==input.life||input.stepController.signal.aborted||input.isCancelled())return false;
      if(input.contextVersion!==this.contextVersion||input.characterId!==this.activeCharacterId)return false;
      if(userTurn&&!this.isReactiveTurnCurrent(userTurn))return false;
      return true;
    };
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    try{
      if(!this.isExpressionContextCurrent)return suppressed("stale-context");
      const contextCurrent=await abortable(Promise.resolve().then(()=>this.isExpressionContextCurrent!(input.characterId,conversationId)),input.stepController.signal);
      if(!contextCurrent)return suppressed("stale-context");
    }catch{return suppressed(input.stepController.signal.aborted||input.life.signal.aborted?"cancelled":"stale-context");}
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    if(!reactive){
      const now=this.now();
      while(this.expressionPublicationTimes.length>0&&now-this.expressionPublicationTimes[0]!>=HOUR_MS)this.expressionPublicationTimes.shift();
      const last=this.expressionPublicationTimes[this.expressionPublicationTimes.length-1];
      if(last!==undefined&&now-last<this.proactiveChatSettings.minMessageIntervalMs)return suppressed("cooldown");
      if(this.expressionPublicationTimes.length>=this.proactiveChatSettings.maxMessagesPerHour)return suppressed("hourly-limit");
    }
    if(!current())return suppressed("stale-context");
    try{
      if(!this.isExpressionContextCurrent)return suppressed("stale-context");
      const contextCurrent=await abortable(Promise.resolve().then(()=>this.isExpressionContextCurrent!(input.characterId,conversationId)),input.stepController.signal);
      if(!contextCurrent)return suppressed("stale-context");
    }catch{return suppressed(input.stepController.signal.aborted||input.life.signal.aborted?"cancelled":"stale-context");}
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    const publisher=this.expressionPublisher;
    if(!publisher)return suppressed("publisher-unavailable");
    let outcome:MindExpressionPublishResult;
    try{
      outcome=await abortable(Promise.resolve().then(()=>publisher.publish({
        characterId:input.characterId,conversationId,expressionId:input.expressionId,content:input.content,signal:input.stepController.signal,
        intent:reactive?"reactive":"proactive",...(userTurn?{userMessageId:userTurn.userMessageId,turnId:userTurn.turnId}:{}),
        ...(input.model?{model:input.model}:{}),...(input.providerId?{providerId:input.providerId}:{}),...(input.providerPresetId?{providerPresetId:input.providerPresetId}:{})
      })),input.stepController.signal);
    }catch(error){
      if(input.stepController.signal.aborted||input.life.signal.aborted)return suppressed("cancelled");
      this.safeOnExpressionError(error);
      return failed("publication-failed",error instanceof Error?error.name:"PUBLISH_FAILED");
    }
    if(outcome.status==="suppressed")return suppressed(outcome.reason);
    if(outcome.status==="failed"){
      if(outcome.reason==="publication-failed"||outcome.reason==="publisher-unavailable")this.safeOnExpressionError(new Error(outcome.errorCode??outcome.reason));
      return failed(outcome.reason,outcome.errorCode);
    }
    if(outcome.conversationId!==input.conversationId||typeof outcome.messageId!=="string"||!outcome.messageId.trim())return suppressed("wrong-conversation");
    if(!reactive)this.expressionPublicationTimes.push(this.now());
    return {...base,expressionStatus:"published",expressionMessageId:outcome.messageId};
  }

  private isReactiveTurnCurrent(turn:MindReactiveTurn):boolean{
    const pending=this.pendingReactiveTurn;
    return Boolean(pending&&pending.characterId===turn.characterId&&pending.conversationId===turn.conversationId&&pending.userMessageId===turn.userMessageId&&pending.turnId===turn.turnId&&this.activeCharacterId===turn.characterId);
  }
  private completeReactiveTurn(turn:MindReactiveTurn):void{
    if(this.isReactiveTurnCurrent(turn))this.pendingReactiveTurn=undefined;
  }
  private failReactiveTurn(turn:MindReactiveTurn,reason:string):void{
    if(!this.isReactiveTurnCurrent(turn))return;
    this.pendingReactiveTurn=undefined;
    try{this.expressionPublisher?.failReactiveTurn?.(turn,reason)}catch{/* UI failure observers must not disrupt cognition. */}
  }

  private quotaWaitMs():number{
    const now=this.now();
    while(this.requestStarts.length>0&&now-this.requestStarts[0]!>=HOUR_MS)this.requestStarts.shift();
    if(this.requestStarts.length<this.scheduleSettings.maxRequestsPerHour)return 0;
    return Math.max(1,this.requestStarts[0]!+HOUR_MS-now);
  }
  private errorBackoffMs():number{
    const exponent=Math.min(20,Math.max(0,this.consecutiveErrors-1));
    const proposed=this.scheduleSettings.defaultIntervalMs*Math.pow(2,exponent);
    return Math.min(this.scheduleSettings.maxIntervalMs,Math.max(this.scheduleSettings.minIntervalMs,proposed));
  }
  private scheduleNext(delayMs:number,reason:MindWakeReason):void{
    const life=this.lifeController;if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    const deadline=this.scheduler.schedule(Math.max(1,Math.floor(delayMs)),reason);
    this.state.nextWakeAt=new Date(deadline).toISOString();this.setLifecycleState("waiting");
  }
  private safeOnError(error:unknown):void{try{this.onError?.(error)}catch{/* diagnostics must not stop Life */}}
  private safeOnExpressionError(error:unknown):void{try{this.onExpressionError?.(error)}catch{/* expression diagnostics must not stop Life */}}
  private setLifecycleState(lifecycleState:MindRuntimeLifecycleState):void{this.state.lifecycleState=lifecycleState;this.notify();}
  private applyInitiative(characterId:string,raw:unknown):void{
    const update=validateMindInitiativeUpdate(raw);
    if(!update)return;
    const characterState=this.characterStates.get(characterId)??createCharacterMindState();
    if(update.decision==="switch"){
      if(characterState.focus===update.focus)return;
      characterState.focus=update.focus!;
      characterState.initiative={status:"active",direction:update.direction??null,lastProgress:update.progress??null};
    }else{
      if(!characterState.focus)return;
      const prior=characterState.initiative;
      const status=update.decision==="pause"?"paused":update.decision==="finish"?"completed":"active";
      characterState.initiative={status,direction:update.direction??prior?.direction??null,lastProgress:update.progress??prior?.lastProgress??null};
    }
    this.characterStates.set(characterId,characterState);
  }
  private applyThought(thought:Thought):void{
    const characterState=this.characterStates.get(thought.characterId)??createCharacterMindState();
    characterState.lastThought=thought;characterState.lastThoughtAt=thought.timestamp;
    characterState.recentThoughts=[...characterState.recentThoughts,thought].slice(-this.recentThoughtLimit);
    this.characterStates.set(thought.characterId,characterState);
    if(thought.characterId===this.activeCharacterId)this.syncActiveState();
    for(const listener of [...this.thoughtListeners]){try{listener({...thought})}catch{/* UI observers cannot affect runtime */}}
    this.notify();
  }
  private syncActiveState():void{
    if(!this.activeCharacterId)return;
    const characterState=this.characterStates.get(this.activeCharacterId)??createCharacterMindState();
    this.characterStates.set(this.activeCharacterId,characterState);
    this.state.focus=characterState.focus;this.state.initiative=characterState.initiative?{...characterState.initiative}:null;this.state.lastThought=characterState.lastThought;this.state.lastThoughtAt=characterState.lastThoughtAt;this.state.recentThoughts=[...characterState.recentThoughts];
  }
  private notify():void{const snapshot=this.getState();for(const listener of [...this.listeners]){try{listener(snapshot)}catch{/* observers cannot affect runtime */}}}
  static createAbortError():Error{return abortError();}
}

export class DeterministicCognitiveStep implements CognitiveStep{
  private sequence=0;
  constructor(private readonly clock:()=>string=()=>new Date().toISOString()){}
  async run(context:CognitiveStepContext):Promise<Thought>{
    if(context.signal.aborted)throw MindRuntime.createAbortError();
    this.sequence+=1;const previous=context.state.lastThought;
    return {characterId:context.characterId,id:"thought:deterministic:"+this.sequence,timestamp:this.clock(),content:previous?"Internal continuation after "+previous.id:"Initial internal thought",expression:"internal"};
  }
}
export type {MindRuntimeLifecycleState};
